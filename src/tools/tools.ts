import { z } from 'zod';
import {
  cancelAppointment,
  checkInAppointment,
  completeAppointment,
  confirmAppointment,
  createAppointment,
  getAppointmentByIdentifier,
  getAppointmentOverview,
  getMyAppointments,
  listAppointmentAudits,
  listAppointments,
  listBookingReferenceData,
  listStoreServices,
  listStoreStaff,
  markNoShowAppointment,
  rescheduleAppointment,
  searchAvailableSlots,
} from '../services/appointments.js';
import { formatBeijing } from '../utils.js';
import {
  endCustomerSession,
  getCurrentCustomer,
  identifyCustomer,
  normalizePhone,
  phoneHash,
} from '../services/customer-identity.js';
import { pool } from '../db/pool.js';
import { findStoreByNameFlexible } from '../queries.js';

/**
 * 预约系统对外 MCP 工具（数字人可见面，精简集 5 工具）。
 *
 * 对外仅暴露 5 个通用工具：
 *  - list_store_catalog  (resource=stores|services|staff 合并原 3 个 list 工具)
 *  - query_slots
 *  - query_bookings
 *  - manage_booking
 *  - manage_customer_session
 *
 * 设计原则与 HA 系统一致：数字人只看到少数通用动词，复杂业务用 action / resource / scope
 * 参数路由；内部所有能力全部保留，只是暴露面收敛，降低大模型工具选择成本。
 * 摘掉的 manage_staff_schedules / list_staff_availability 为店长后台场景，顾客侧
 * 由 query_slots + manage_staff_schedules(action=list) 覆盖，不再对 LLM 暴露。
 */

// ===== 目录查询（聚合 3 个旧 list 工具） =====

export const listStoreCatalogInput = z.object({
  resource: z.enum(['stores', 'services', 'staff']).describe('目录资源：stores=门店列表；services=某店可约项目/价格（必传 store_id）；staff=某店员工/可做项目（必传 store_id）'),
  store_id: z.string().optional().describe('门店 id（resource=services|staff 时必填）'),
  service_id: z.string().optional().describe('按项目过滤可服务员工（仅 resource=staff 时可选）'),
  keyword: z.string().optional().describe('名称关键字过滤'),
  limit: z.number().int().min(1).max(100).optional(),
}).describe('门店/项目/员工目录查询。查门店传 resource=stores；查价格/项目传 resource=services+store_id；查技师/可做项目传 resource=staff+store_id。数字人做【门店选择/项目价格/技师推荐】统一调此工具，不再分别找旧 list 工具。排班/档期请调 query_slots，预约请调 manage_booking');

// ===== 可约时段查询 =====

export const querySlotsInput = z.object({
  service_id: z.string().min(1).optional(),
  service_name: z.string().min(1).optional().describe('项目名，如"小气泡"；数字人从用户话术中提取后传入，服务端自动解析'),
  store_id: z.string().min(1).optional().describe('门店 id。用户说的是某门店里的项目时优先传入，服务端会限制为该店可做项目'),
  store_name: z.string().min(1).optional().describe('门店名，如"上海徐汇门店"；用户直接说门店名时传入，服务端模糊解析为门店'),
  date: z.string().optional().describe('日期：YYYY-MM-DD；也可直接传口语"今天/明天/后天/大后天/周X/9月9日"，服务端自动换算，无需自行推算今天几号'),
  preferred_staff_id: z.string().min(1).optional(),
  preferred_staff_name: z.string().min(1).optional().describe('员工名，如"李美容师"；用户指定服务员工时传入。【重要】只有用户明确指定技师/美容师人名时才填；门店名（如"上海徐汇门店"）严禁填入此字段，必须填 store_name，否则会被拒绝后无限重试'),
}).describe('查询指定服务在某天可预约的时段，返回可用员工与时间槽。完整校验链路：门店存在→门店开通该项目→门店有会做该项目的员工→员工当天有排班且时段未占用。【播报铁律】向用户播报时段一律使用 start_local/end_local（东八区本地时间，如"2026-09-09 10:00"就是上午十点），严禁自行换算或朗读 start_at/end_at（那是 UTC，朗读会把上午十点说成凌晨两点）。数字人把"我想预约某个项目"先转成可用时段时调用，随后用 manage_booking(action=create) 创建');

// ===== 预约查询 =====

export const queryBookingsInput = z.object({
  scope: z.enum(['my', 'detail', 'list', 'audits', 'overview']).describe('查询范围：my=当前顾客预约列表；detail=单条预约详情；list=管理端按条件查询预约列表；audits=单条预约审计轨迹；overview=预约统计概览'),
  appointment_id: z.string().optional(),
  appointment_code: z.string().optional().describe('预约码，如 apt_20260616_...；查询 detail/audits 时优先用它定位'),
  customer_id: z.string().optional(),
  customer_phone: z.string().optional().describe('顾客手机号（共享终端双重校验用；传了则必须与 customer_name 同时校验，不单独以手机号定人）'),
  customer_name: z.string().optional().describe('顾客称呼（与 customer_phone 双重校验；防止同名/同号串号）'),
  store_id: z.string().optional(),
  staff_id: z.string().optional(),
  service_id: z.string().optional(),
  service_name: z.string().optional().describe('按项目名筛选，如"小气泡"，LLM 从用户话术中提取'),
  keyword: z.string().optional().describe('关键字：匹配预约码、项目名、员工名'),
  status: z.enum(['pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show']).optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
}).describe('查询预约：顾客预约列表、单条预约详情、审计轨迹、管理端列表与预约概览统计。【双重校验】共享终端查询本人预约时以会话绑定为准；若 LLM 显式传入 customer_phone/customer_name 则必须两者一致才放行，单手机号或单名字不单独定人，放止同号/同名串号。【播报铁律】向用户播报预约时间一律用 appointment.start_local（北京时间），严禁朗读 start_at（UTC，会把上午十点说成凌晨一点）；报预约码只报 appointment.booking_code 后8位，严禁朗读 appointment_code 全文或内部 id；严禁向用户索要任何编号/ID');

// ===== 预约动作 =====

export const manageBookingInput = z.object({
  action: z.enum(['create', 'cancel', 'reschedule', 'check_in', 'confirm', 'complete', 'mark_no_show']).describe('预约动作：create=创建预约；cancel=取消；reschedule=改期；check_in=到店签到；confirm=确认待确认预约；complete=完成服务；mark_no_show=标记爽约'),
  service_id: z.string().min(1).optional(),
  service_name: z.string().min(1).optional().describe('项目名，如"小气泡"。数字人从用户话术中提取后传入，服务端自动解析'),
  store_id: z.string().min(1).optional(),
  store_name: z.string().min(1).optional().describe('门店名，如"上海徐汇门店"。【必须】用户回答的门店名填在这里，绝不填进 note 或 staff_name；只填纯门店名，不带"用户确认"等转述前缀，服务端支持模糊匹配（"徐汇店"也可）。用户没说门店且系统有多家门店时先追问，单店场景可不传'),
  staff_id: z.string().min(1).optional(),
  staff_name: z.string().min(1).optional().describe('员工名，如"李美容师"；用户指定员工时传入，服务端在门店内按名字解析。【重要】门店名（如"上海徐汇门店"）严禁填入此字段，必须填 store_name；不确定指定人选时留空不填'),
  start_at: z.string().min(1).optional().describe('到店时间：必须是 query_slots 返回的某个时段的 start_at 原文（UTC ISO），或"YYYY-MM-DD HH:mm"（东八区本地时间）。严禁把用户说的本地时间换算后再传。从 query_slots 结果中获取'),
  appointment_id: z.string().min(1).optional(),
  appointment_code: z.string().min(1).optional().describe('预约码，优先用于精确定位预约'),
  new_start_at: z.string().min(1).optional().describe('改期后的新时间（action=reschedule 时必传），格式同 start_at'),
  reason: z.string().optional().describe('取消原因（action=cancel 时可选）'),
  note: z.string().optional().describe('预约备注（action=create 时可选）。仅用于备注信息（如"靠窗""老顾客"）。严禁把门店名/项目名/员工名写进 note——门店用 store_name、项目用 service_name、员工用 staff_name'),
  operator_id: z.string().optional(),
  idempotency_key: z.string().min(1).optional(),
  status: z.enum(['pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show']).optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
}).describe('统一预约动作工具：创建、取消、改期、签到、确认、完成、标记爽约。创建前必须先 query_slots 查可用时段并向用户确认，再调用本工具；服务端会再次校验门店/项目/员工/排班全链路（不在排班内将拒绝 OUTSIDE_SCHEDULE）。取消/改期优先传 appointment_code。【参数铁律】用户提到的门店名必须传 store_name（如"上海徐汇门店"）、项目名传 service_name、员工名传 staff_name，严禁写进 note。【播报铁律】① 顾客身份由系统自动注入，严禁向用户索要或复述编号/ID/手机号（如"请给我编号"是错误行为）；② 向用户播报预约结果时使用返回的 spoken 字段（时间已转本地、预约码只报 booking_code 后8位或干脆不报），严禁朗读 appointment_code 全文（如 apt_20260908_xxx 是内部单号，读出来是严重事故）；③ 时间播报一律用北京时间上午/下午的说法。身份由调用上下文自动注入，无需传 customer_id');

// ===== 顾客身份 =====

export const manageCustomerSessionInput = z.object({
  action: z.enum(['identify', 'get_current', 'end']).describe('身份动作：identify=识别并绑定顾客；get_current=查询当前会话绑定的顾客；end=顾客离开时结束会话'),
  customer_phone: z.string().min(1).optional().describe('顾客手机号（action=identify 时必填，7-20 位数字），由数字人口语询问获得'),  customer_name: z.string().optional().describe('顾客称呼（可选），方便对话中称呼，如"王女士"'),
  session_id: z.string().optional().describe('结束指定会话（action=end 时可选，不传则结束当前会话）'),
}).describe('顾客身份管理：共享终端每次接待新顾客必须先 identify 绑定身份，顾客离开时 end 结束会话，防止上一位顾客数据泄露给下一位。个人数字人无需调用。扫码已注入身份的会话无需再调用');

// ===== 工具实现 =====

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const actionOf = (input: unknown): string => (isRecord(input) && typeof input.action === 'string' ? input.action : '');
const resourceOf = (input: unknown): string => (isRecord(input) && typeof input.resource === 'string' ? input.resource : '');
const scopeOf = (input: unknown): string => (isRecord(input) && typeof input.scope === 'string' ? input.scope : '');

const only = <T extends Record<string, unknown>>(input: unknown, keys: string[]): T => {
  const record = isRecord(input) ? input : {};
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]])) as T;
};

const missing = (fields: string[], suggestedQuestion: string) => ({
  success: false,
  error_code: 'NEEDS_MORE_INFO',
  message: '参数不完整，请先向用户追问缺失信息后再调用。',
  missing_fields: fields,
  suggested_question: suggestedQuestion,
  /** 明确告诉 LLM 重试时把答案放进哪个参数，防止再次错放进 note 等字段 */
  retry_hint: fields
    .map((field) => {
      const [primary] = field.split('|');
      return `用户回答后请填入参数 ${primary}`;
    })
    .join('；'),
});

const requireFields = (input: unknown, fields: string[], suggestedQuestion: string) => {
  const record = isRecord(input) ? input : {};
  // 复合字段（service_id|service_name）：任一存在即视为已提供
  const missingFields = fields.filter((field) => {
    const alternatives = field.split('|').map((item) => item.trim());
    return !alternatives.some((key) => {
      const value = record[key];
      return value !== undefined && value !== null && String(value).trim() !== '';
    });
  });
  return missingFields.length > 0 ? missing(missingFields, suggestedQuestion) : null;
};

/** 聚合目录 handler：resource 路由到原 3 个服务函数，服务层零改动 */
const storeCatalogHandler = async (input: unknown) => {
  const resource = resourceOf(input);
  switch (resource) {
    case 'stores':
      return listBookingReferenceData(only(input, ['keyword', 'limit', 'active_only']) as unknown as Parameters<typeof listBookingReferenceData>[0]);
    case 'services': {
      const required = requireFields(input, ['store_id'], '请先告诉我您想查询哪家门店的项目。');
      if (required) return required;
      return listStoreServices(only(input, ['store_id', 'keyword', 'limit']) as unknown as Parameters<typeof listStoreServices>[0]);
    }
    case 'staff': {
      const required = requireFields(input, ['store_id'], '请先告诉我您想查询哪家门店的员工。');
      if (required) return required;
      return listStoreStaff(only(input, ['store_id', 'service_id', 'keyword', 'limit']) as unknown as Parameters<typeof listStoreStaff>[0]);
    }
    default:
      return { success: false, error_code: 'INVALID_ARGUMENT', message: `不支持的 resource: ${resource}，仅支持 stores/services/staff` };
  }
};

/** 门店名错放回收（query_slots / manage_booking 入口共用）。
 *
 * 线上死循环根因：用户说“我去上海徐汇门店做光子嫩肤”，LLM 却把门店名填进
 * preferred_staff_name（员工名字段），store_name 留空 → 服务端按“未指定门店 +
 * 多店”返回 NEEDS_MORE_INFO（请确认门店）→ LLM 认为用户早说过了，原参数重试 →
 * 同一错误无限循环（日志：14:37:05~14:37:53 连续 8 次 NEEDS_MORE_INFO）。
 *
 * 回收规则（只在正字段缺失时介入，显式传参一律不动）：
 *  1) store_id/store_name 均为空，且员工名/项目名字段里有值；
 *  2) 该值能命中一家在营门店（findStoreByNameFlexible 精确/包含/去后缀匹配）；
 *  3) 该值同时不是任何在职员工名（防“门店恰好和某技师同名”误伤指定技师场景）。
 * 满足三条才把值搬进 store_name 并清空错放字段。 */
async function recoverMisplacedStoreName(input: unknown): Promise<void> {
  if (!isRecord(input)) return;
  const textOf = (key: string) => (typeof input[key] === 'string' ? String(input[key]).trim() : '');
  if (textOf('store_id') || textOf('store_name')) return;
  for (const key of ['preferred_staff_name', 'staff_name'] as const) {
    const candidate = textOf(key);
    if (!candidate) continue;
    const store = await findStoreByNameFlexible(candidate);
    if (!store) continue;
    // 该值若是真实在职员工名，按员工语义保留，不做搬迁
    const { rows } = await pool.query(
      'SELECT 1 FROM staff WHERE is_active = true AND (name = $1 OR $1 LIKE \'%\' || name || \'%\') LIMIT 1',
      [candidate],
    );
    if (rows.length > 0) continue;
    input.store_name = store.name;
    delete input[key];
    return;
  }
}

const querySlotsHandler = async (input: unknown) => {
  const requiredDate = requireFields(input, ['date'], '请先告诉我您想预约哪一天。');
  if (requiredDate) return requiredDate;
  const record = isRecord(input) ? input : {};
  if (!record.service_id && !record.service_name) {
    return missing(['service_id|service_name'], '请先告诉我您要预约哪个项目。');
  }
  // 门店名可能被 LLM 错放进员工/项目字段：先回收再查档期，否则多店场景会无限 NEEDS_MORE_INFO
  await recoverMisplacedStoreName(input);
  return searchAvailableSlots(only(input, ['service_id', 'service_name', 'store_id', 'store_name', 'date', 'preferred_staff_id', 'preferred_staff_name']) as unknown as Parameters<typeof searchAvailableSlots>[0]);
};

/** 播报辅助：给预约相关返回补 start_local（北京时间）与 booking_code 短码。
 *  LLM 播报一律用这些字段，避免把 UTC ISO（如 2026-09-09T01:00:00Z）误读成"凌晨一点"。 */
function decorateAppointmentsForSpeech(result: unknown): unknown {
  const decorateAppointment = (appointment: Record<string, unknown> | undefined | null) => {
    if (!appointment || typeof appointment !== 'object') return appointment;
    return {
      ...appointment,
      start_local: appointment.start_at ? formatBeijing(String(appointment.start_at)) : undefined,
      booking_code: appointment.appointment_code ? String(appointment.appointment_code).slice(-8) : undefined,
    };
  };
  const decorateItem = (item: unknown) => {
    if (!item || typeof item !== 'object') return item;
    const record = item as Record<string, unknown>;
    // 列表项两种形态：{ appointment: {...} } 详情包装，或预约对象本身（含 appointment_code 字段）
    if ('appointment' in record) return { ...record, appointment: decorateAppointment(record.appointment as Record<string, unknown>) };
    if ('appointment_code' in record || 'start_at' in record) return decorateAppointment(record);
    return item;
  };
  if (Array.isArray(result)) return result.map(decorateItem);
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.items)) return { ...record, items: record.items.map(decorateItem) };
    if ('appointment' in record) return { ...record, appointment: decorateAppointment(record.appointment as Record<string, unknown>) };
  }
  return result;
}

/** 预约查询双重校验：手机号+姓名必须成对且一致，防同号/同名串号；未传则沿用会话绑定，不改原链路。
 *
 * 关键行为（线上 3 条串号修正）：
 *  - 单传 phone_hash 等价（同手机号不同档案 → IDENTITY_MISMATCH，要求同时提供姓名）：
 *    绝不以单一手机号直接定位顾客档案。手机号只是“索引键”，定人必须姓名一致。
 *  - 手机号+姓名成对命中唯一档案后，后续查询强制按该档案 id 作用域，杜绝 LLM 传错
 *    customer_id 串号；与会话绑定 customer_id 不一致时直接拒绝，不静默覆盖。 */
async function verifyBookingQueryIdentity(
  input: unknown,
  boundCustomerId?: string,
): Promise<{ ok: true; effectiveCustomerId?: string } | { ok: false; error: Record<string, unknown> }> {
  const record = isRecord(input) ? input : {};
  const rawPhone = typeof record.customer_phone === 'string' ? record.customer_phone.trim() : '';
  const rawName = typeof record.customer_name === 'string' ? record.customer_name.trim() : '';
  const hasPhone = Boolean(rawPhone);
  const hasName = Boolean(rawName);
  if (!hasPhone && !hasName) return { ok: true };
  if (hasPhone !== hasName) {
    return {
      ok: false,
      error: {
        success: false,
        error_code: 'NEEDS_MORE_INFO',
        message: '查询预约需手机号+姓名双重校验，二者需同时提供且为同一人，避免同号/同名串号。',
        missing_fields: hasPhone ? ['customer_name'] : ['customer_phone'],
        suggested_question: hasPhone ? '请再提供姓名（与该手机号一致）以完成双重校验。' : '请再提供手机号（与该姓名一致）以完成双重校验。',
      },
    };
  }
  try {
    const normalized = normalizePhone(rawPhone);
    const hash = phoneHash(normalized);
    const { rows } = await pool.query(
      'SELECT customer_id, display_name FROM customer_profiles WHERE phone_hash = $1 LIMIT 1',
      [hash],
    );
    const profile = rows[0] as { customer_id: string; display_name: string | null } | undefined;
    if (!profile) {
      return {
        ok: false,
        error: { success: false, error_code: 'IDENTITY_MISMATCH', message: `手机号 ${rawPhone} 未找到对应顾客档案，请核对手机号。` },
      };
    }
    const display = String(profile.display_name ?? '').trim();
    const nameMatch = rawName === display || (display && (display.includes(rawName) || rawName.includes(display)));
    if (!nameMatch) {
      return {
        ok: false,
        error: {
          success: false,
          error_code: 'IDENTITY_MISMATCH',
          message: `手机号与姓名不匹配（该手机号对应「${display || '未知'}」），请确认手机号与姓名为同一人后再试。`,
        },
      };
    }
    if (boundCustomerId && profile.customer_id !== boundCustomerId) {
      return {
        ok: false,
        error: {
          success: false,
          error_code: 'IDENTITY_MISMATCH',
          message: '传入的手机号/姓名与当前会话绑定的顾客不一致，请先通过 manage_customer_session 重新识别或直接用当前会话身份查询。',
        },
      };
    }
    // 双重校验通过：后续查询强制按该档案 id 作用域，避免 LLM 传错 customer_id 串号
    (record as Record<string, unknown>).customer_id = profile.customer_id;
    return { ok: true, effectiveCustomerId: profile.customer_id };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('IDENTIFY_INVALID_PHONE')) {
      return { ok: false, error: { success: false, error_code: 'INVALID_ARGUMENT', message: msg } };
    }
    return { ok: false, error: { success: false, error_code: 'IDENTITY_MISMATCH', message: `双重校验失败：${msg}` } };
  }
}

const queryBookingsHandler = async (input: unknown) => {
  // scope 缺省即 my：顾客问“我的预约”时 LLM 常漏传 scope，原实现落 default 返回
  // INVALID_ARGUMENT，数字人拿到错误码后既不出声也不追问，表现为“直接不理人、
  // 无思考中、日志无记录”。现在缺省按 my 走会话身份查询，链路其余部分零改动。
  const rawScope = scopeOf(input);
  const scope = rawScope || 'my';
  if (isRecord(input)) (input as Record<string, unknown>).scope = scope;
  const boundId = isRecord(input) && typeof input.customer_id === 'string' ? String(input.customer_id).trim() || undefined : undefined;

  // 需要顾客作用域的 scope 先做手机号+姓名双重校验（单字段不单独定人）。
  // 校验通过后统一用「档案 id + 已验证的姓名/手机号对」双重作用域：id 命中档案单，
  // 姓名对命中建档前的 guest 单；手机号相同但姓名不同的单子（家人共用号）绝不合并。
  let effectiveCustomerId = boundId;
  if (['my', 'detail', 'audits', 'list'].includes(scope)) {
    const verified = await verifyBookingQueryIdentity(input, boundId);
    if (!verified.ok) return verified.error;
    if (verified.ok) effectiveCustomerId = verified.effectiveCustomerId ?? boundId;
  }
  // 校验通过后统一用 effectiveCustomerId 覆盖 LLM 传的 customer_id（防串号），
  // 显式双重校验已在函数内写回 record.customer_id；会话绑定场景在这里写回。
  if (isRecord(input) && effectiveCustomerId) {
    (input as Record<string, unknown>).customer_id = effectiveCustomerId;
  }

  switch (scope) {
    case 'my':
      return decorateAppointmentsForSpeech(await getMyAppointments(only(input, ['customer_id', 'customer_name', 'customer_phone', 'from_date', 'to_date', 'status', 'service_name', 'keyword']) as unknown as Parameters<typeof getMyAppointments>[0]));
    case 'detail': {
      const record = isRecord(input) ? input : {};
      if (!record.appointment_id && !record.appointment_code) {
        return missing(['appointment_id|appointment_code'], '请先告诉我预约码，或者直接告诉我是哪一单预约。');
      }
      return decorateAppointmentsForSpeech(await getAppointmentByIdentifier(only(input, ['customer_id', 'customer_name', 'customer_phone', 'appointment_id', 'appointment_code']) as unknown as Parameters<typeof getAppointmentByIdentifier>[0]));
    }
    case 'list': {
      // 共享终端（有会话绑定或双重校验）时强制按人过滤；管理后台 REST（无 customer_id）保持原全量行为。
      const listInput = only(input, ['customer_id', 'customer_name', 'customer_phone', 'store_id', 'staff_id', 'service_id', 'service_name', 'from_date', 'to_date', 'status', 'keyword', 'limit', 'offset']) as unknown as Parameters<typeof listAppointments>[0];
      return decorateAppointmentsForSpeech(await listAppointments(listInput));
    }
    case 'audits': {
      const record = isRecord(input) ? input : {};
      if (!record.appointment_id && !record.appointment_code) {
        return missing(['appointment_id|appointment_code'], '请先告诉我预约码，我再帮您查这单预约的流转记录。');
      }
      return listAppointmentAudits(only(input, ['customer_id', 'customer_name', 'customer_phone', 'appointment_id', 'appointment_code']) as unknown as Parameters<typeof listAppointmentAudits>[0]);
    }
    case 'overview':
      return getAppointmentOverview(only(input, ['from_date', 'to_date', 'store_id']) as unknown as Parameters<typeof getAppointmentOverview>[0]);
    default:
      return { success: false, error_code: 'INVALID_ARGUMENT', message: `不支持的 scope: ${scope}，仅支持 my/detail/list/audits/overview` };
  }
};

/** 剥离 note 里的对话噪音前缀（"用户确认/那就选/说去"等），与 queries.ts 保持一致 */
const stripNotePrefix = (value: string): string => {
  let text = value.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = text
      .replace(/^(?:用户|顾客|客人|客户|他|她|我|我们)/, '')
      .replace(/^(?:已经|已|最终|最后|然后|接着|所以|那么|那|就说|说|讲|提到)?(?:确认|选定|选择|选了|挑选|挑了|确定|敲定|决定|定了|就选|就要|想要|想去|想约|要去|会去|选|定)/, '')
      .replace(/^(?:的话|就是|就|是|在|去|到|约|来)/, '')
      .replace(/^(?:说|讲)/, '')
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
};

/**
 * 从 note 文本中回收被大模型错放的门店/项目/员工名（仅 create 入口调用）。
 *
 * 背景：工具 schema 已明确 store_name/service_name/staff_name 的语义，但 LLM
 * 偶发把"上海徐汇门店"整体塞进 note（观测于线上 14:27 连续两次：一次完全未传
 * store，一次 note="用户确认上海徐汇门店"）。原正则 /{2,12}?(?:门店)/ 从字符串
 * 头部尝试导致把"用户确认上海徐汇门店"整体当门店名提取，进而
 * ILIKE '%用户确认上海徐汇门店%' 查不到 → STORE_NOT_FOUND。
 * 现改为：先剥噪音前缀，再取"含门店/店后缀的最后一段短语"（2-8字），
 * 避免前缀污染；员工/项目回收同理仅在缺失时介入。
 */
const recoverFieldsFromNote = (input: unknown): void => {
  if (!isRecord(input)) return;
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (!note) return;

  const hasField = (key: string) => {
    const value = input[key];
    return value !== undefined && value !== null && String(value).trim() !== '';
  };

  // 噪声剥离后的 note 用于匹配，避免"用户确认"被吞入门店名
  const stripped = stripNotePrefix(note);
  let remainder = note;

  // 门店名回收：取 stripped 中最后一个「XX门店/XX分店/XX店」片段（2-8字前缀），
  // 避免头部贪吃。例："用户确认上海徐汇门店"剥离后"上海徐汇门店" → 提取"上海徐汇门店"。
  if (!hasField('store_id') && !hasField('store_name')) {
    const storeCandidates = stripped.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,8}(?:门店|分店|店)/g);
    let storeName = storeCandidates ? storeCandidates[storeCandidates.length - 1] : null;
    if (storeName) {
      // 对匹配片段再剥一次噪音，兜住"用户说去XX店"这类整体被贪吃进片段的情况
      // （剥离需重复至稳定：如"说去上海徐汇门店"需两轮才能剥干净）
      for (let iter = 0; iter < 3; iter++) {
        const cleaned = stripNotePrefix(storeName);
        if (cleaned === storeName) break;
        storeName = cleaned;
      }
      input.store_name = storeName;
      // 从原 remainder 中移除匹配到的门店名（取最后一次出现）
      const idx = remainder.lastIndexOf(storeName);
      if (idx !== -1) remainder = `${remainder.slice(0, idx)}${remainder.slice(idx + storeName.length)}`.trim();
      else if (storeCandidates && remainder.includes(storeCandidates[storeCandidates.length - 1])) {
        const rawIdx = remainder.lastIndexOf(storeCandidates[storeCandidates.length - 1]);
        remainder = `${remainder.slice(0, rawIdx)}${remainder.slice(rawIdx + storeCandidates[storeCandidates.length - 1].length)}`.trim();
      }
      // 残留的"用户/确认"等转述噪音一并清掉
      remainder = stripNotePrefix(remainder).trim();
    }
  }

  // 员工名回收：「李美容师 / 张技师 / 王店长」这类称谓结构（取最后一个）
  if (!hasField('staff_id') && !hasField('staff_name')) {
    const staffCandidates = remainder.match(/[\u4e00-\u9fa5]{1,3}(?:美容师|技师|理疗师|师傅|店长|顾问)/g);
    const staffName = staffCandidates ? staffCandidates[staffCandidates.length - 1] : null;
    if (staffName) {
      input.staff_name = staffName;
      const idx = remainder.lastIndexOf(staffName);
      if (idx !== -1) remainder = `${remainder.slice(0, idx)}${remainder.slice(idx + staffName.length)}`.trim();
    }
  }

  // 项目名回收：仅当回收后剩下的短文本不含动作/时间语义时才采纳，
  // 防止把"帮我约周五上午"这类话术误当项目名。
  if (!hasField('service_id') && !hasField('service_name')) {
    const candidate = remainder
      .replace(/^(帮我|请|麻烦|我想|我要|预约一下|预约|约一下|约个|约|创建|建个)/, '')
      .replace(/(，|,|。|；|;|\s)+/g, '')
      .trim();
    const looksLikeService =
      candidate.length >= 2 &&
      candidate.length <= 12 &&
      !/[周周明天后天大后上午下午晚上早上点分半\d]/.test(candidate);
    if (looksLikeService) {
      input.service_name = candidate;
      remainder = '';
    }
  }

  // 清理后的 note 写回（避免残留门店/员工噪音）；完全清空则删除字段
  const cleaned = remainder.replace(/^(的|预约|，|,|。)+|(的|预约|，|,|。)+$/g, '').trim().replace(/\s{2,}/g, ' ');
  if (cleaned) {
    input.note = cleaned;
  } else {
    delete input.note;
  }
};

const manageBookingHandler = async (input: unknown) => {
  const action = actionOf(input);
  // note 兜底纠偏（create）：大模型偶尔会把用户话术里的门店名/项目名/员工名
  // 写进 note（如 note="上海徐汇门店"）而不是对应专属字段，随后被 requireFields
  // 以 NEEDS_MORE_INFO 拒绝（0ms，用户感知为"一直报错"）。这里在入口把可辨认
  // 的值从 note 搬回正字段，仅当正字段缺失且 note 文本可提取时生效，不改写
  // 用户显式传过的字段。无法识别的内容留在 note 原样透传。
  if (action === 'create') {
    recoverFieldsFromNote(input);
    // 与 query_slots 同一错放回收：门店名可能被塞进员工名（已回收 note，仍有直接错位的 case）
    await recoverMisplacedStoreName(input);
  }
  const speak = async (result: unknown) => {
    const record = result as Record<string, unknown> | null;
    if (!record || record.success !== true) return result;
    // create 已在服务层返回 spoken；其余动作（cancel/reschedule 等）在此统一补口播字段
    if (!record.spoken && record.appointment) {
      const appointment = record.appointment as { start_at?: string; appointment_code?: string };
      record.spoken = {
        time: appointment.start_at ? formatBeijing(appointment.start_at) : undefined,
        booking_code: appointment.appointment_code ? appointment.appointment_code.slice(-8) : undefined,
      };
    }
    return decorateAppointmentsForSpeech(record);
  };
  switch (action) {
    case 'create': {
      // 门店在单店部署下可由服务端自动兜底（不追问），多店时服务端会返回 NEEDS_MORE_INFO + 候选门店，
      // 故此处不在前置校验里强制要求 store，避免"只有一个门店却反复问哪家门店"的死循环
      const required = requireFields(input, ['service_id|service_name', 'staff_id|staff_name', 'start_at'], '请先补充项目、员工和预约时间后再创建预约。');
      if (required) {
        const CREATE_FIELD_QUESTIONS: Record<string, string> = {
          'service_id|service_name': '请问您想预约哪个项目？',
          'staff_id|staff_name': '请问您有指定的工作人员吗？没有的话我为您安排即可。',
          'start_at': '请问您想预约哪一天、大概几点？',
        };
        const fields = (required as { missing_fields?: string[] }).missing_fields ?? [];
        const questions = fields.map((field) => CREATE_FIELD_QUESTIONS[field]).filter(Boolean);
        if (questions.length > 0) (required as { suggested_question: string }).suggested_question = questions.join(' ');
        return required;
      }
      return speak(await createAppointment(only(input, ['service_id', 'service_name', 'store_id', 'store_name', 'staff_id', 'staff_name', 'start_at', 'customer_name', 'customer_phone', 'customer_id', 'note', 'idempotency_key']) as unknown as Parameters<typeof createAppointment>[0]));
    }
    case 'cancel': {
      const required = requireFields(input, ['appointment_id|appointment_code'], '请先告诉我您要取消哪一单预约。');
      if (required) return required;
      return speak(await cancelAppointment(only(input, ['appointment_id', 'appointment_code', 'customer_id', 'reason', 'idempotency_key', 'service_id', 'service_name', 'status', 'from_date', 'to_date']) as unknown as Parameters<typeof cancelAppointment>[0]));
    }
    case 'reschedule': {
      const required = requireFields(input, ['appointment_id|appointment_code', 'new_start_at'], '请先告诉我您要改哪一单，以及新的时间。');
      if (required) return required;
      return speak(await rescheduleAppointment(only(input, ['appointment_id', 'appointment_code', 'customer_id', 'new_start_at', 'idempotency_key', 'service_id', 'service_name', 'status', 'from_date', 'to_date']) as unknown as Parameters<typeof rescheduleAppointment>[0]));
    }
    case 'check_in': {
      const required = requireFields(input, ['appointment_id'], '请先告诉我您要签到哪一单预约。');
      if (required) return required;
      return speak(await checkInAppointment(only(input, ['appointment_id', 'customer_id', 'operator_id']) as unknown as Parameters<typeof checkInAppointment>[0]));
    }
    case 'confirm': {
      const required = requireFields(input, ['appointment_id'], '请先告诉我您要确认哪一单预约。');
      if (required) return required;
      return speak(await confirmAppointment(only(input, ['appointment_id', 'operator_id', 'customer_id']) as unknown as Parameters<typeof confirmAppointment>[0]));
    }
    case 'complete': {
      const required = requireFields(input, ['appointment_id'], '请先告诉我您要完成哪一单预约。');
      if (required) return required;
      return speak(await completeAppointment(only(input, ['appointment_id', 'operator_id']) as unknown as Parameters<typeof completeAppointment>[0]));
    }
    case 'mark_no_show': {
      const required = requireFields(input, ['appointment_id'], '请先告诉我您要标记爽约哪一单预约。');
      if (required) return required;
      return speak(await markNoShowAppointment(only(input, ['appointment_id', 'operator_id']) as unknown as Parameters<typeof markNoShowAppointment>[0]));
    }
    default:
      return { success: false, error_code: 'INVALID_ARGUMENT', message: `不支持的动作: ${action}` };
  }
};

const manageCustomerSessionHandler = async (input: unknown) => {
  const action = actionOf(input);
  const args = isRecord(input) ? input : {};
  switch (action) {
    case 'identify': {
      const required = requireFields(input, ['customer_phone'], '请先告诉我顾客手机号，我来帮您识别并绑定当前顾客。');
      if (required) return required;
      return identifyCustomer({
        agent_code: typeof args.agent_code === 'string' ? args.agent_code : '',
        customer_phone: typeof args.customer_phone === 'string' ? args.customer_phone : '',
        customer_name: typeof args.customer_name === 'string' ? args.customer_name : undefined,
        external_session_id: typeof args.external_session_id === 'string' ? args.external_session_id : undefined,
        source: typeof args.source === 'string' && (args.source === 'scan' || args.source === 'manual') ? args.source : 'manual',
      });
    }
    case 'get_current':
      return getCurrentCustomer({
        agent_code: typeof args.agent_code === 'string' ? args.agent_code : '',
        external_session_id: typeof args.external_session_id === 'string' ? args.external_session_id : undefined,
      });
    case 'end':
      return endCustomerSession({
        agent_code: typeof args.agent_code === 'string' ? args.agent_code : '',
        external_session_id: typeof args.external_session_id === 'string' ? args.external_session_id : undefined,
        session_id: typeof args.session_id === 'string' ? args.session_id : undefined,
      });
    default:
      return { success: false, error_code: 'INVALID_ARGUMENT', message: `不支持的身份动作: ${action}` };
  }
};

export const appointmentTools = [
  {
    name: 'list_store_catalog',
    description: '门店/项目/员工目录查询。resource=stores 查门店列表；resource=services+store_id 查某店项目/价格（用户说"背部管理多少钱/有哪些项目"时调）；resource=staff+store_id 查某店员工/可做项目（用户说"谁能做/换个技师"时调）。排班/档期请调 query_slots。',
    inputSchema: listStoreCatalogInput,
    handler: storeCatalogHandler,
  },
  {
    name: 'query_slots',
    description: '查询指定服务在某天可预约的时段，返回可用员工与时间槽。数字人把"我想预约某个项目"先转成可用时段时调用，随后用 manage_booking(action=create) 创建。',
    inputSchema: querySlotsInput,
    handler: querySlotsHandler,
  },
  {
    name: 'query_bookings',
    description: '查询预约：顾客预约列表、单条预约详情、审计轨迹、管理端列表与预约概览统计。数字人听到"查我的预约 / 预约详情 / 预约码是xxx / 门店预约统计"时调用。',
    inputSchema: queryBookingsInput,
    handler: queryBookingsHandler,
  },
  {
    name: 'manage_booking',
    description: '统一预约动作工具。action=create 创建预约；cancel 取消预约；reschedule 改期；check_in 到店签到；confirm 确认待确认预约；complete 完成服务；mark_no_show 标记爽约。创建前必须先 query_slots 查可用时段并向用户确认，再调用本工具；取消/改期优先传 appointment_code。身份由调用上下文自动注入，无需传 customer_id。',
    inputSchema: manageBookingInput,
    handler: manageBookingHandler,
  },
  {
    name: 'manage_customer_session',
    description: '顾客身份管理（共享终端必用）。action=identify 识别并绑定当前顾客；get_current 查询当前会话绑定的顾客；end 顾客离开时结束会话，防止上一位顾客数据泄露给下一位。',
    inputSchema: manageCustomerSessionInput,
    handler: manageCustomerSessionHandler,
  },
] as const;

export type AppointmentToolSet = typeof appointmentTools;
