import { z } from 'zod';
import {
  applyStaffWeeklySchedule,
  cancelAppointment,
  checkInAppointment,
  completeAppointment,
  confirmAppointment,
  createAppointment,
  deleteDayStaffSchedules,
  getAppointmentByIdentifier,
  getAppointmentOverview,
  getMyAppointments,
  listAppointmentAudits,
  listAppointments,
  listBookingReferenceData,
  listStaffAvailability,
  listStoreScheduleGrid,
  listStoreServices,
  listStoreStaff,
  markNoShowAppointment,
  rescheduleAppointment,
  searchAvailableSlots,
  upsertDayStaffSchedules,
} from '../services/appointments.js';
import { formatBeijing } from '../utils.js';
import {
  endCustomerSession,
  getCurrentCustomer,
  identifyCustomer,
} from '../services/customer-identity.js';

/**
 * 预约系统对外 MCP 工具（数字人可见面，HA 风格精简集）。
 *
 * 对外仅暴露 8 个通用工具：
 *  - list_booking_reference
 *  - list_store_services
 *  - list_store_staff
 *  - list_staff_availability
 *  - query_slots
 *  - query_bookings
 *  - manage_booking
 *  - manage_customer_session
 *
 * 设计原则与 HA 系统一致：数字人只看到少数通用动词，复杂业务用 action / resource / scope
 * 参数路由；内部所有能力（预约、取消、改期、签到、审计、管理查询等）全部保留，
 * 只是暴露面收敛，降低大模型工具选择成本。
 */

// ===== 参考数据查询 =====

export const listBookingReferenceInput = z.object({
  resource: z.enum(['stores']).describe('要查询的资源类型：stores=门店列表'),
  active_only: z.boolean().optional(),
  keyword: z.string().optional().describe('名称关键字过滤'),
  limit: z.number().int().min(1).max(100).optional(),
}).describe('统一参考数据查询：门店列表。数字人需要先展示门店列表或做门店选择时调用');

export const listStoreServicesInput = z.object({
  store_id: z.string().min(1).describe('门店 id'),
  keyword: z.string().optional().describe('名称关键字过滤'),
  limit: z.number().int().min(1).max(100).optional(),
}).describe('列出某门店可预约项目。数字人需要直接展示门店项目时调用');

export const listStoreStaffInput = z.object({
  store_id: z.string().min(1).describe('门店 id'),
  service_id: z.string().min(1).optional().describe('按项目过滤可服务员工'),
  keyword: z.string().optional().describe('名称关键字过滤'),
  limit: z.number().int().min(1).max(100).optional(),
}).describe('列出某门店员工及其可服务项目。数字人需要直接推荐员工时调用');

export const listStaffAvailabilityInput = z.object({
  staff_id: z.string().min(1).describe('员工 id'),
  date_from: z.string().min(1).describe('排班查询开始日期 YYYY-MM-DD'),
  date_to: z.string().min(1).describe('排班查询结束日期 YYYY-MM-DD'),
}).describe('查询员工在指定日期范围内的排班。数字人需要直接看某员工班次时调用');

// ===== 排班管理（管理后台 / 数字人店长） =====

export const manageStaffSchedulesInput = z.object({
  action: z.enum(['list', 'upsert_day', 'delete_day', 'apply_weekly']).describe('排班动作：list=查门店排班表；upsert_day=建/改某员工某天班次；delete_day=删某员工某天班次；apply_weekly=按周模板批量铺班'),
  store_id: z.string().min(1).describe('门店 id'),
  staff_id: z.string().min(1).optional().describe('员工 id（upsert_day / delete_day / apply_weekly 必填；list 可选过滤）'),
  date: z.string().optional().describe('日期 YYYY-MM-DD（upsert_day / delete_day 必填）'),
  date_from: z.string().optional().describe('开始日期 YYYY-MM-DD（list / apply_weekly 必填）'),
  date_to: z.string().optional().describe('结束日期 YYYY-MM-DD（list / apply_weekly 必填）'),
  shifts: z.array(z.object({
    start: z.string().describe('班次开始 HH:mm，如 09:00'),
    end: z.string().describe('班次结束 HH:mm，如 18:00'),
    status: z.enum(['available', 'unavailable', 'break']).optional().describe('班次状态，默认 available 可约'),
  })).optional().describe('班次列表（upsert_day / apply_weekly 必填），如 [{start:"09:00",end:"12:00"},{start:"13:00",end:"18:00"}]'),
  weekdays: z.array(z.number().int().min(1).max(7)).optional().describe('每周几上班（apply_weekly 必填），1=周一 ... 7=周日'),
  start: z.string().optional().describe('只删除该开始时间的班次 HH:mm（delete_day 可选，省略删全天）'),
  operator: z.string().optional().describe('操作人（审计用）'),
}).describe('员工排班管理。action=list 查门店某时段排班；upsert_day 按天建/改班次（一天可多班，覆盖式保存）；delete_day 删除某天班次；apply_weekly 把每周固定班铺到日期范围（只填空白天）。排班决定顾客可约时段：没排班的时间 query_slots 不会返回');

// ===== 可约时段查询 =====

export const querySlotsInput = z.object({
  service_id: z.string().min(1).optional(),
  service_name: z.string().min(1).optional().describe('项目名，如"小气泡"；数字人从用户话术中提取后传入，服务端自动解析'),
  store_id: z.string().min(1).optional().describe('门店 id。用户说的是某门店里的项目时优先传入，服务端会限制为该店可做项目'),
  store_name: z.string().min(1).optional().describe('门店名，如"上海徐汇门店"；用户直接说门店名时传入，服务端模糊解析为门店'),
  date: z.string().min(1).describe('日期，格式 YYYY-MM-DD'),
  preferred_staff_id: z.string().min(1).optional(),
  preferred_staff_name: z.string().min(1).optional().describe('员工名，如"李美容师"；用户指定服务员工时传入'),
}).describe('查询指定服务在某天可预约的时段，返回可用员工与时间槽。完整校验链路：门店存在→门店开通该项目→门店有会做该项目的员工→员工当天有排班且时段未占用。【播报铁律】向用户播报时段一律使用 start_local/end_local（东八区本地时间，如"2026-09-09 10:00"就是上午十点），严禁自行换算或朗读 start_at/end_at（那是 UTC，朗读会把上午十点说成凌晨两点）。数字人把"我想预约某个项目"先转成可用时段时调用，随后用 manage_booking(action=create) 创建');

// ===== 预约查询 =====

export const queryBookingsInput = z.object({
  scope: z.enum(['my', 'detail', 'list', 'audits', 'overview']).describe('查询范围：my=当前顾客预约列表；detail=单条预约详情；list=管理端按条件查询预约列表；audits=单条预约审计轨迹；overview=预约统计概览'),
  appointment_id: z.string().optional(),
  appointment_code: z.string().optional().describe('预约码，如 apt_20260616_...；查询 detail/audits 时优先用它定位'),
  customer_id: z.string().optional(),
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
}).describe('查询预约：顾客预约列表、单条预约详情、审计轨迹、管理端列表与预约概览统计。数字人听到"查我的预约 / 预约详情 / 预约码是xxx / 门店预约统计"时调用。【播报铁律】向用户播报预约时间一律用 appointment.start_local（北京时间），严禁朗读 start_at（UTC，会把上午十点说成凌晨一点）；报预约码只报 appointment.booking_code 后8位，严禁朗读 appointment_code 全文或内部 id；严禁向用户索要任何编号/ID');

// ===== 预约动作 =====

export const manageBookingInput = z.object({
  action: z.enum(['create', 'cancel', 'reschedule', 'check_in', 'confirm', 'complete', 'mark_no_show']).describe('预约动作：create=创建预约；cancel=取消；reschedule=改期；check_in=到店签到；confirm=确认待确认预约；complete=完成服务；mark_no_show=标记爽约'),
  service_id: z.string().min(1).optional(),
  service_name: z.string().min(1).optional().describe('项目名，如"小气泡"。数字人从用户话术中提取后传入，服务端自动解析'),
  store_id: z.string().min(1).optional(),
  store_name: z.string().min(1).optional().describe('门店名，如"上海徐汇门店"；用户直接说门店名时传入，服务端自动解析'),
  staff_id: z.string().min(1).optional(),
  staff_name: z.string().min(1).optional().describe('员工名，如"李美容师"；用户指定员工时传入，服务端在门店内按名字解析'),
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

const referenceHandler = async (input: unknown) => {
  const resource = resourceOf(input);
  if (resource !== 'stores') {
    return { success: false, error_code: 'INVALID_ARGUMENT', message: `不支持的 resource: ${resource}，仅支持 stores` };
  }
  return listBookingReferenceData(only(input, ['active_only', 'keyword', 'limit']) as unknown as Parameters<typeof listBookingReferenceData>[0]);
};

const storeServicesHandler = async (input: unknown) => {
  const required = requireFields(input, ['store_id'], '请先告诉我您想查询哪家门店的项目。');
  if (required) return required;
  return listStoreServices(only(input, ['store_id', 'keyword', 'limit']) as unknown as Parameters<typeof listStoreServices>[0]);
};

const storeStaffHandler = async (input: unknown) => {
  const required = requireFields(input, ['store_id'], '请先告诉我您想查询哪家门店的员工。');
  if (required) return required;
  return listStoreStaff(only(input, ['store_id', 'service_id', 'keyword', 'limit']) as unknown as Parameters<typeof listStoreStaff>[0]);
};

const staffAvailabilityHandler = async (input: unknown) => {
  const required = requireFields(input, ['staff_id', 'date_from', 'date_to'], '请先告诉我员工、开始日期和结束日期，我再帮您查排班。');
  if (required) return required;
  return listStaffAvailability(only(input, ['staff_id', 'date_from', 'date_to']) as unknown as Parameters<typeof listStaffAvailability>[0]);
};

/** 排班管理（管理后台/数字人店长场景）：查询、按天建改、删除、周模板铺班 */
const manageSchedulesHandler = async (input: unknown) => {
  const action = actionOf(input);
  switch (action) {
    case 'list': {
      const required = requireFields(input, ['store_id', 'date_from', 'date_to'], '请告诉我门店和起止日期，我帮您查排班表。');
      if (required) return required;
      return listStoreScheduleGrid(only(input, ['store_id', 'date_from', 'date_to', 'staff_id']) as unknown as Parameters<typeof listStoreScheduleGrid>[0]);
    }
    case 'upsert_day': {
      const required = requireFields(input, ['store_id', 'staff_id', 'date'], '请告诉我门店、员工和日期，以及当天班次时间。');
      if (required) return required;
      const record = isRecord(input) ? input : {};
      const rawShifts = Array.isArray(record.shifts) ? record.shifts : [];
      if (rawShifts.length === 0) {
        return missing(['shifts'], '请提供当天班次列表，如 shifts:[{start:"09:00",end:"18:00"}]；清空当天请用 action=delete_day');
      }
      return upsertDayStaffSchedules(only(input, ['store_id', 'staff_id', 'date', 'shifts', 'operator']) as unknown as Parameters<typeof upsertDayStaffSchedules>[0]);
    }
    case 'delete_day': {
      const required = requireFields(input, ['store_id', 'staff_id', 'date'], '请告诉我门店、员工和要删除排班的日期。');
      if (required) return required;
      return deleteDayStaffSchedules(only(input, ['store_id', 'staff_id', 'date', 'start', 'operator']) as unknown as Parameters<typeof deleteDayStaffSchedules>[0]);
    }
    case 'apply_weekly': {
      const required = requireFields(input, ['store_id', 'staff_id', 'date_from', 'date_to', 'weekdays'], '请告诉我门店、员工、日期范围和每周哪几天上班。');
      if (required) return required;
      const record = isRecord(input) ? input : {};
      if (!Array.isArray(record.shifts) || record.shifts.length === 0) {
        return missing(['shifts'], '请提供每周班次时间，如 shifts:[{start:"09:00",end:"18:00"}]');
      }
      return applyStaffWeeklySchedule(only(input, ['store_id', 'staff_id', 'date_from', 'date_to', 'weekdays', 'shifts', 'operator']) as unknown as Parameters<typeof applyStaffWeeklySchedule>[0]);
    }
    default:
      return { success: false, error_code: 'INVALID_ARGUMENT', message: `不支持的排班动作: ${action}（支持 list / upsert_day / delete_day / apply_weekly）` };
  }
};

const querySlotsHandler = async (input: unknown) => {
  const requiredDate = requireFields(input, ['date'], '请先告诉我您想预约哪一天。');
  if (requiredDate) return requiredDate;
  const record = isRecord(input) ? input : {};
  if (!record.service_id && !record.service_name) {
    return missing(['service_id|service_name'], '请先告诉我您要预约哪个项目。');
  }
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

const queryBookingsHandler = async (input: unknown) => {
  const scope = scopeOf(input);
  switch (scope) {
    case 'my':
      return decorateAppointmentsForSpeech(await getMyAppointments(only(input, ['customer_id', 'from_date', 'to_date', 'status', 'service_name', 'keyword']) as unknown as Parameters<typeof getMyAppointments>[0]));
    case 'detail': {
      const record = isRecord(input) ? input : {};
      if (!record.appointment_id && !record.appointment_code) {
        return missing(['appointment_id|appointment_code'], '请先告诉我预约码，或者直接告诉我是哪一单预约。');
      }
      return decorateAppointmentsForSpeech(await getAppointmentByIdentifier(only(input, ['customer_id', 'appointment_id', 'appointment_code']) as unknown as Parameters<typeof getAppointmentByIdentifier>[0]));
    }
    case 'list':
      return decorateAppointmentsForSpeech(await listAppointments(only(input, ['customer_id', 'store_id', 'staff_id', 'service_id', 'service_name', 'from_date', 'to_date', 'status', 'keyword', 'limit', 'offset']) as unknown as Parameters<typeof listAppointments>[0]));
    case 'audits': {
      const record = isRecord(input) ? input : {};
      if (!record.appointment_id && !record.appointment_code) {
        return missing(['appointment_id|appointment_code'], '请先告诉我预约码，我再帮您查这单预约的流转记录。');
      }
      return listAppointmentAudits(only(input, ['customer_id', 'appointment_id', 'appointment_code']) as unknown as Parameters<typeof listAppointmentAudits>[0]);
    }
    case 'overview':
      return getAppointmentOverview(only(input, ['from_date', 'to_date', 'store_id']) as unknown as Parameters<typeof getAppointmentOverview>[0]);
    default:
      return { success: false, error_code: 'INVALID_ARGUMENT', message: `不支持的 scope: ${scope}，仅支持 my/detail/list/audits/overview` };
  }
};

/**
 * 从 note 文本中回收被大模型错放的门店/项目/员工名（仅 create 入口调用）。
 *
 * 背景：工具 schema 已明确 store_name/service_name/staff_name 的语义，但 LLM
 * 偶发把"上海徐汇门店"整体塞进 note（观测于线上 17:45 连续三次 NEEDS_MORE_INFO）。
 * 这里做保守的正则回收：
 *   - 门店：note 中含「门店/店」结尾的片段，或整个 note 就是一个短名词时直接采用；
 *   - 项目/员工：仅当 note 能按常见分隔符拆出与缺失字段一一对应的短语时回收，
 *     拆不出来就不动，宁可让服务端返回 NEEDS_MORE_INFO 由数字人追问。
 * 回收后会把该片段从 note 中移除，避免创建出的预约备注里残留"门店名"这种噪音。
 */
const recoverFieldsFromNote = (input: unknown): void => {
  if (!isRecord(input)) return;
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (!note) return;

  const hasField = (key: string) => {
    const value = input[key];
    return value !== undefined && value !== null && String(value).trim() !== '';
  };

  let remainder = note;

  // 门店名回收：优先匹配「XX门店/XX店」结构（如"上海徐汇门店"）
  if (!hasField('store_id') && !hasField('store_name')) {
    const storeMatch = remainder.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,12}?(?:门店|分店|店))/);
    if (storeMatch) {
      input.store_name = storeMatch[1];
      remainder = remainder.replace(storeMatch[1], '').trim();
    }
  }

  // 员工名回收：「李美容师 / 张技师 / 王店长」这类称谓结构
  if (!hasField('staff_id') && !hasField('staff_name')) {
    const staffMatch = remainder.match(/([\u4e00-\u9fa5]{1,3}(?:美容师|技师|理疗师|师傅|店长|顾问))/);
    if (staffMatch) {
      input.staff_name = staffMatch[1];
      remainder = remainder.replace(staffMatch[1], '').trim();
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
  const cleaned = remainder.replace(/^(的|预约|，|,|。)+|(的|预约|，|,|。)+$/g, '').trim();
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
  if (action === 'create') recoverFieldsFromNote(input);
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
      const required = requireFields(input, ['service_id|service_name', 'store_id|store_name', 'staff_id|staff_name', 'start_at'], '请先补充项目、门店、员工和预约时间后再创建预约。');
      if (required) return required;
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
    name: 'list_booking_reference',
    description: '统一参考数据查询：门店列表。数字人需要先展示门店列表或做门店选择时调用。',
    inputSchema: listBookingReferenceInput,
    handler: referenceHandler,
  },
  {
    name: 'list_store_services',
    description: '列出某门店可预约项目。数字人需要直接展示门店项目时调用。',
    inputSchema: listStoreServicesInput,
    handler: storeServicesHandler,
  },
  {
    name: 'list_store_staff',
    description: '列出某门店员工及其可服务项目。数字人需要直接推荐员工时调用。',
    inputSchema: listStoreStaffInput,
    handler: storeStaffHandler,
  },
  {
    name: 'list_staff_availability',
    description: '查询员工在指定日期范围内的排班。数字人需要直接看某员工班次时调用。',
    inputSchema: listStaffAvailabilityInput,
    handler: staffAvailabilityHandler,
  },
  {
    name: 'manage_staff_schedules',
    description: '员工排班管理（店长场景）。action=list 查门店排班表；upsert_day 建/改某员工某天班次；delete_day 删除；apply_weekly 按周模板铺班。排班决定顾客可约时段。',
    inputSchema: manageStaffSchedulesInput,
    handler: manageSchedulesHandler,
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
