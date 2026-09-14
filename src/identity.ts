/**
 * 双层身份模型：
 *   agent（数字人终端）身份 —— X-Agent-Code / Bearer sub，表示"哪台数字人在说话"；
 *   customer（真实顾客）身份 —— 顾客通过 manage_customer_session(action=identify, customer_phone=...) 建立的会话绑定，
 *                               表示"当前正在被服务的人是谁"。
 *
 * 两种运行模式（IDENTITY_MODE）：
 *   - personal（默认）：数字人账号即顾客本人账号（一人一数字人），行为与旧版一致，
 *     agent 身份直接作为 customer_id。
 *   - shared：共享终端模式（如一楼门店公共数字人 hsh 依次接待多位顾客），
 *     customer_id 必须来自顾客会话；未识别时，顾客级工具返回 IDENTITY_REQUIRED，
 *     由数字人引导顾客完成识别，杜绝把 A 顾客的预约暴露/操作在 B 顾客名下的串号风险。
 *
 * 顾客会话的两个建立来源（shared 模式）：
 *   1) 对话内 manage_customer_session(action=identify, customer_phone=...)（手机号口头提供，source=manual）；
 *   2) 客户端转发层直通注入 X-Customer-Phone / X-Customer-Name
 *      （小程序扫码已确认的顾客身份，source=scan，自动建绑，无需口头再问）。
 *
 * HTTP 头 X-Session-Id（外部会话作用域）：客户端在每次对话会话启动时生成，
 * 同一台数字人并行多路对话时各会话各自绑定顾客，互不串号；单终端顺序接待可不传。
 */

export type IdentityMode = 'personal' | 'shared';

export interface ParsedIdentity {
  agentCode?: string;
  sessionId?: string;
  /** 扫码直通的顾客手机号（客户端转发层注入，表示"小程序已确认的顾客"） */
  customerPhone?: string;
  customerName?: string;
  source: 'header' | 'bearer' | 'none';
}

export interface BoundIdentity {
  /** 已解析的最终顾客身份。shared 模式下可能为 undefined（未识别），由工具层决定报错。 */
  customerId?: string;
  agentCode?: string;
  sessionId?: string;
  /** shared 模式且顾客未识别时为 true，工具层应返回引导文案。 */
  needsIdentification: boolean;
  mode: IdentityMode;
}

const readAuthHeader = (req: { headers?: Record<string, string | string[] | undefined> }): string | undefined => {
  const raw = req.headers?.['authorization'];
  if (Array.isArray(raw)) return raw[0];
  return raw;
};

/** 只解码 JWT payload（不验签：与外层网关/本地转发的信任模型一致，取 sub 而非完整声明）。 */
const decodeJwtSub = (token: string): string | undefined => {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    const sub = typeof payload?.sub === 'string' ? payload.sub.trim() : undefined;
    return sub || undefined;
  } catch {
    return undefined;
  }
};

const firstHeader = (value: string | string[] | undefined): string | undefined => {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed || undefined;
};

/** 头部值兼容处理：客户端对非 ASCII（如中文称呼）做 encodeURIComponent，服务端解码还原；解码失败原样返回。 */
const decodeHeader = (value: string | undefined): string | undefined => {
  if (!value) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export function parseIdentity(req: { headers?: Record<string, string | string[] | undefined> }): ParsedIdentity {
  const rawHeaders = req.headers ?? {};

  const agentCode = firstHeader(rawHeaders['x-agent-code'] ?? rawHeaders['X-Agent-Code']);
  if (agentCode) {
    return {
      agentCode,
      sessionId: firstHeader(rawHeaders['x-session-id'] ?? rawHeaders['X-Session-Id']),
      customerPhone: decodeHeader(firstHeader(rawHeaders['x-customer-phone'] ?? rawHeaders['X-Customer-Phone'])),
      customerName: decodeHeader(firstHeader(rawHeaders['x-customer-name'] ?? rawHeaders['X-Customer-Name'])),
      source: 'header',
    };
  }

  const auth = readAuthHeader(req)?.trim();
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const sub = decodeJwtSub(auth.slice(7).trim());
    if (sub) {
      return {
        agentCode: sub,
        sessionId: firstHeader(rawHeaders['x-session-id']),
        customerPhone: decodeHeader(firstHeader(rawHeaders['x-customer-phone'])),
        customerName: decodeHeader(firstHeader(rawHeaders['x-customer-name'])),
        source: 'bearer',
      };
    }
  }

  return {
    sessionId: firstHeader(rawHeaders['x-session-id']),
    customerPhone: decodeHeader(firstHeader(rawHeaders['x-customer-phone'])),
    customerName: decodeHeader(firstHeader(rawHeaders['x-customer-name'])),
    source: 'none',
  };
}

/**
 * 顾客级工具（查询/创建/取消/改期/签到本人预约、顾客身份管理）的上下文解析。
 * 返回 needsIdentification=true 时工具层直接返回引导文案（fail-closed）。
 *
 * preResolvedSession：调用方在同一请求内已解析过的会话（如扫码直通路径里的
 * getActiveSession 结果）。传入后跳过重复的 DB 解析（undefined=未解析，照常自查；
 * null=已查过且无活跃会话）。省去每次工具调用 2 次多余 DB 往返。
 */
export async function bindCustomerIdentity(
  input: Record<string, unknown>,
  identity: { agentCode?: string; sessionId?: string; customerPhone?: string; customerName?: string },
  resolveSessionCustomer: (agentCode: string, sessionId?: string) => Promise<{ customerId?: string } | null>,
  preResolvedSession?: { customerId?: string } | null,
): Promise<BoundIdentity> {
  const mode: IdentityMode = (process.env.IDENTITY_MODE?.trim().toLowerCase() as IdentityMode) || 'personal';

  // 身份管理工具与匿名/管理端调试：允许显式参数直通
  if (!identity.agentCode) {
    return {
      customerId: typeof input.customer_id === 'string' && input.customer_id.trim() ? input.customer_id.trim() : undefined,
      agentCode: undefined,
      sessionId: identity.sessionId,
      needsIdentification: false,
      mode,
    };
  }

  if (mode === 'personal') {
    return { customerId: identity.agentCode, agentCode: identity.agentCode, sessionId: identity.sessionId, needsIdentification: false, mode };
  }

  // shared 模式：顾客身份只来自顾客会话，不信任 LLM 传入的 customer_id。
  // preResolvedSession 非 undefined 时直接复用调用方已解析的结果（扫码直通路径
  // 已查过一次），避免同一请求重复 2 次 DB 往返；undefined 时保持原自查语义。
  const session = preResolvedSession !== undefined ? preResolvedSession : await resolveSessionCustomer(identity.agentCode, identity.sessionId);
  if (!session?.customerId) {
    return { customerId: undefined, agentCode: identity.agentCode, sessionId: identity.sessionId, needsIdentification: true, mode };
  }
  return { customerId: session.customerId, agentCode: identity.agentCode, sessionId: identity.sessionId, needsIdentification: false, mode };
}

/** 非顾客级工具（参考数据、管理端操作等）：仅注入 agent 语义（operator），不改写 customer_id。 */
export function bindAgentContext<T extends Record<string, unknown>>(input: T, identity: { agentCode?: string }): T {
  if (!identity.agentCode) return input;
  const next = { ...input } as T & { agent_code?: unknown };
  next.agent_code = identity.agentCode;
  return next as T;
}
