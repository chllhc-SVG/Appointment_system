import { pool } from '../db/pool.js';
import { hashIdempotencyKey } from '../utils.js';
import { randomUUID, randomBytes } from 'node:crypto';

/**
 * 共享终端顾客身份服务。
 *
 * 一台数字人（agent_code 如 hsh）在门店现场会依次接待多位真实顾客，
 * agent 身份不能当 customer 身份用（否则所有人共用一个 customer_id 必然串号）。
 * 这里以「会话绑定」解决：identify（手机号/会员码）→ bind（agent 或外部会话级）
 * → 工具层从活跃会话解析 customer_id → 结束或过期自动解绑。
 *
 * 会话解析优先级（resolveSessionCustomer）：
 *   1) (agent_code, external_session_id) —— 客户端转发层注入 X-Session-Id，
 *      同一终端并行多路对话各自绑定，互不影响（扫码登录的 sess_* 即此 id）；
 *   2) agent_code 级唯一活跃会话 —— 单终端顺序接待（现场一次只服务一位）。
 *
 * 滑动续期：活跃会话每次被解析时顺带延长 TTL（不超过硬上限），
 * 保证长对话（查时段→确认→创建）不会中途失效。
 */

const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;

export const CUSTOMER_SESSION_TTL_MS = Math.min(
  Math.max(Number(process.env.CUSTOMER_SESSION_TTL_MS ?? DEFAULT_TTL_MS), 60_000),
  MAX_TTL_MS,
);

export interface CustomerSession {
  session_id: string;
  agent_code: string;
  customer_id: string;
  customer_name: string | null;
  display_name: string | null;
  status: string;
  source: string;
  expires_at: string;
}

interface SessionRow {
  id: string;
  agent_code: string;
  customer_id: string;
  customer_name: string | null;
  display_name: string | null;
  status: string;
  source: string;
  expires_at: Date;
}

const toSession = (row: SessionRow): CustomerSession => ({
  session_id: row.id,
  agent_code: row.agent_code,
  customer_id: row.customer_id,
  customer_name: row.customer_name,
  display_name: row.display_name,
  status: row.status,
  source: row.source,
  expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
});

const maskPhone = (phone: string) => {
  const trimmed = phone.trim();
  if (trimmed.length < 7) return `${trimmed.slice(0, 1)}***`;
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`;
};

export const phoneHash = (phone: string) => hashIdempotencyKey(`customer-phone:${phone.trim().toLowerCase()}`);

const makeCustomerId = () => `cust_${randomBytes(6).toString('hex')}`;

export const makeBindToken = () => `bind_${randomBytes(4).toString('hex').toUpperCase()}`;

/** 手机号格式校验（宽松：7-20 位数字，允许 + 前缀），数字人口语输入容错。 */
export const normalizePhone = (value: string) => {
  const trimmed = String(value ?? '').replace(/[\s-]/g, '');
  if (!/^\+?\d{7,20}$/.test(trimmed)) {
    throw new Error('IDENTIFY_INVALID_PHONE: 手机号格式不正确，请提供 7-20 位数字手机号');
  }
  return trimmed;
};

/**
 * 滑动续期：每次命中活跃会话时延长 TTL，最多延到 now + TTL（封顶 MAX_TTL_MS）。
 * 节流：同一会话 60s 内不重复 UPDATE。续期是"近似滑动"语义，一分钟粒度完全够用
 * （TTL 默认 30min）；原实现每次解析都打一次 UPDATE，把每次工具调用白白垫高
 * 一个 DB 写往返。
 */
const SESSION_TOUCH_THROTTLE_MS = 60_000;
const sessionTouchAt = new Map<string, number>();

const touchSession = async (sessionId: string) => {
  const now = Date.now();
  const last = sessionTouchAt.get(sessionId) ?? 0;
  if (now - last < SESSION_TOUCH_THROTTLE_MS) return;
  sessionTouchAt.set(sessionId, now);
  // 有界：超 512 条时按 last-touch 时间戳删最旧的一批（高峰并发下只记活跃会话，
  // 而不是把 Map 撑爆；被删 key 的下次调用只多付 1 次 UPDATE，可接受）。
  if (sessionTouchAt.size > 512) {
    const cutoff = now - SESSION_TOUCH_THROTTLE_MS;
    for (const [key, ts] of sessionTouchAt) {
      if (ts <= cutoff) sessionTouchAt.delete(key);
    }
    while (sessionTouchAt.size > 512) {
      const oldest = sessionTouchAt.keys().next();
      if (oldest.done) break;
      sessionTouchAt.delete(oldest.value);
    }
  }
  try {
    await pool.query(
      `UPDATE customer_sessions
       SET expires_at = LEAST(now() + make_interval(secs => $2), now() + make_interval(secs => $3)),
           updated_at = now()
       WHERE id = $1 AND status = 'active'`,
      [sessionId, CUSTOMER_SESSION_TTL_MS / 1000, MAX_TTL_MS / 1000],
    );
  } catch {
    // 续期失败不影响本次调用：expires_at 尚有余额，下次解析会再续
  }
};

/**
 * 获取活跃会话（带外部会话作用域）：
 * 优先 (agent, externalSessionId) 精确绑定；无外部会话 id 时退回 agent 级唯一活跃会话。
 * 过期会话顺带标记 expired；命中活跃会话时滑动续期。
 *
 * 热路径节流：命中为 null（新接待扫码中/未识别）时不做清扫 UPDATE——清扫走
 * sweepExpiredSessions() 的后台兜底（5min 批量），避免每次未识别工具调用都多打
 * 1 次写往返。数字人对话里 IDENTITY_REQUIRED 是高频返回，这个 UPDATE 原本是
 * 把每次失败调用都垫高一个 DB 写往返的隐性元凶。
 */
export async function getActiveSession(agentCode: string, externalSessionId?: string): Promise<CustomerSession | null> {
  const agent = agentCode?.trim();
  if (!agent) return null;
  const external = externalSessionId?.trim();

  if (external) {
    const { rows } = await pool.query(
      `SELECT * FROM customer_sessions
       WHERE agent_code = $1 AND external_session_id = $2 AND status = 'active' AND expires_at > now()
       ORDER BY identified_at DESC LIMIT 1`,
      [agent, external],
    );
    const row = rows[0] as SessionRow | undefined;
    if (row) {
      await touchSession(row.id);
      return toSession(row);
    }
    // 该外部会话没有自己的绑定 → 不回落 agent 级，避免并行对话互相串号。
    // 注：不在此清扫过期行（热路径写放大），由后台 sweepExpiredSessions 批量处理。
    return null;
  }

  const { rows } = await pool.query(
    `SELECT * FROM customer_sessions
     WHERE agent_code = $1 AND status = 'active' AND expires_at > now()
     ORDER BY identified_at DESC LIMIT 1`,
    [agent],
  );
  const row = rows[0] as SessionRow | undefined;
  if (!row) {
    // 同上：不清扫，交后台批量
    return null;
  }
  await touchSession(row.id);
  return toSession(row);
}

/** 后台兜底清扫：批量把过期活跃会话标 expired（每 5min 一次，见 main.ts）。
 *  从热路径剥离后，过期标记最多延迟 5min——会话解析本来就带 expires_at > now()
 *  条件，延迟清扫不影响正确性，只影响"管理后台看状态"的实时性（可接受）。 */
export async function sweepExpiredSessions(): Promise<number> {
  try {
    const { rowCount } = await pool.query(
      `UPDATE customer_sessions SET status = 'expired', updated_at = now()
       WHERE status = 'active' AND expires_at <= now()`,
    );
    return rowCount ?? 0;
  } catch {
    return 0;
  }
}

/** 按手机号查询顾客档案 id（不存在返回 null）。用于扫码直通幂等判断。 */
export async function getScanCustomerId(phone: string): Promise<string | null> {
  try {
    const normalized = normalizePhone(phone);
    const { rows } = await pool.query('SELECT customer_id FROM customer_profiles WHERE phone_hash = $1 LIMIT 1', [phoneHash(normalized)]);
    return (rows[0] as { customer_id: string } | undefined)?.customer_id ?? null;
  } catch {
    return null;
  }
}

export async function getSessionById(sessionId: string): Promise<CustomerSession | null> {
  const { rows } = await pool.query('SELECT * FROM customer_sessions WHERE id = $1 LIMIT 1', [sessionId]);
  const row = rows[0] as SessionRow | undefined;
  if (!row) return null;
  if (row.status === 'active' && row.expires_at.getTime() <= Date.now()) {
    await pool.query(`UPDATE customer_sessions SET status = 'expired', updated_at = now() WHERE id = $1`, [sessionId]);
    return { ...toSession(row), status: 'expired' };
  }
  return toSession(row);
}

interface IdentifyInput {
  agent_code: string;
  customer_phone: string;
  customer_name?: string;
  external_session_id?: string;
  source?: 'manual' | 'scan';
}

/**
 * 身份识别：手机号（+可选姓名）→ customer_id，并建立会话绑定。
 * - 已有档案直接复用；新顾客建档。
 * - external_session_id（X-Session-Id）存在时绑到该外部会话，否则绑 agent 级。
 * - source=scan 表示身份来自小程序扫码直通（客户端转发层注入），manual 为对话内口头提供。
 * - 同作用域旧活跃会话被顶替（replaced），均留审计。扫码身份（强证据）可顶替口头识别；
 *   manual 对 manual 的顶替仅发生在同作用域显式重新识别时。
 */
export async function identifyCustomer(input: IdentifyInput) {
  const agentCode = input.agent_code?.trim();
  if (!agentCode) throw new Error('IDENTIFY_NO_AGENT: 缺少数字人身份（X-Agent-Code），无法识别顾客');

  const phone = normalizePhone(input.customer_phone);
  const name = input.customer_name?.trim() || null;
  const hash = phoneHash(phone);
  const masked = maskPhone(phone);
  const externalSession = input.external_session_id?.trim() || null;
  const source = input.source === 'scan' ? 'scan' : 'manual';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 顶替同作用域旧会话
    const previous = await client.query(
      `UPDATE customer_sessions
       SET status = 'replaced', ended_at = now(), updated_at = now()
       WHERE agent_code = $1 AND status = 'active'
         AND (external_session_id = $2::text OR ($2::text IS NULL AND external_session_id IS NULL))
       RETURNING id, customer_id`,
      [agentCode, externalSession],
    );

    let customerId: string;
    let displayName: string | null = null;
    const existing = await client.query('SELECT * FROM customer_profiles WHERE phone_hash = $1 LIMIT 1', [hash]);
    if (existing.rows[0]) {
      customerId = (existing.rows[0] as { customer_id: string }).customer_id;
      displayName = (existing.rows[0] as { display_name: string | null }).display_name;
      await client.query(
        `UPDATE customer_profiles SET updated_at = now() WHERE customer_id = $1`,
        [customerId],
      );
    } else {
      customerId = makeCustomerId();
      displayName = name ?? masked;
      await client.query(
        `INSERT INTO customer_profiles (customer_id, phone_hash, phone_masked, display_name, source)
         VALUES ($1, $2, $3, $4, $5)`,
        [customerId, hash, masked, displayName, source],
      );
    }

    // 名称与档案不一致时，保留最新称呼（仅 display_name，不影响任何授权）
    if (name && name !== displayName) {
      displayName = name;
      await client.query(`UPDATE customer_profiles SET display_name = $2, updated_at = now() WHERE customer_id = $1`, [customerId, name]);
    }

    const sessionId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO customer_sessions
         (id, agent_code, external_session_id, customer_id, customer_name, display_name, status, source, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, now() + make_interval(secs => $8))
       RETURNING *`,
      [sessionId, agentCode, externalSession, customerId, name, displayName, source, CUSTOMER_SESSION_TTL_MS / 1000],
    );

    await client.query('COMMIT');
    const session = toSession(inserted.rows[0] as SessionRow);

    await pool.query(
      `INSERT INTO entity_audits (entity_type, entity_id, action, operator, before_data, after_data)
       VALUES ('customer_session', $1, $2, $3, $4::jsonb, $5::jsonb)`,
      [
        sessionId,
        previous.rows[0] ? 'identify_replace' : 'identify',
        agentCode,
        previous.rows[0] ? JSON.stringify({ previous_session_id: previous.rows[0].id, previous_customer_id: previous.rows[0].customer_id }) : null,
        JSON.stringify({ customer_id: customerId, phone_masked: masked, display_name: session.display_name, source, external_session_id: externalSession }),
      ],
    );

    return {
      success: true,
      session,
      customer: {
        customer_id: customerId,
        display_name: session.display_name,
        phone_masked: masked,
        is_new: !existing.rows[0],
      },
      hint: '已识别顾客身份并绑定到当前数字人会话，后续预约/查询/取消/改期将以此顾客身份执行',
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getCurrentCustomer(input: { agent_code: string; external_session_id?: string }) {
  return getActiveSession(input.agent_code?.trim(), input.external_session_id);
}

/** 结束会话（顾客离开或显式登出）。优先外部会话作用域，其次 agent 级全部活跃会话。 */
export async function endCustomerSession(input: { agent_code: string; external_session_id?: string; session_id?: string; ended_by?: string }) {
  const agentCode = input.agent_code?.trim();
  if (!agentCode) throw new Error('IDENTIFY_NO_AGENT: 缺少数字人身份');
  const externalSession = input.external_session_id?.trim() || null;

  const ended = await pool.query(
    `UPDATE customer_sessions
     SET status = 'ended', ended_at = now(), updated_at = now()
     WHERE agent_code = $1 AND status = 'active'
       AND ($2::text IS NULL OR id = $2)
       AND ($3::text IS NULL OR external_session_id = $3 OR ($3::text IS NOT NULL AND external_session_id IS NULL))
     RETURNING id, customer_id`,
    [agentCode, input.session_id?.trim() || null, externalSession],
  );
  if (ended.rows[0]) {
    await pool.query(
      `INSERT INTO entity_audits (entity_type, entity_id, action, operator, after_data)
       VALUES ('customer_session', $1, 'end', $2, $3::jsonb)`,
      [ended.rows[0].id, input.ended_by ?? agentCode, JSON.stringify({ customer_id: ended.rows[0].customer_id })],
    );
  }
  return { success: true, ended: ended.rowCount ?? 0 };
}
