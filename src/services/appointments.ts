import { pool } from '../db/pool.js';
import { writeAudit } from '../audit.js';
import { withIdempotentOperation } from '../idempotency.js';
import { addMinutes, assertNonEmpty, formatBeijing, hashIdempotencyKey, makeAppointmentCode, normalizeDate, normalizeTimestamp } from '../utils.js';
import type {
  Appointment,
  AppointmentStatus,
  CancelAppointmentInput,
  CompactTimeSlot,
  CreateAppointmentInput,
  QueryAppointmentsInput,
  RescheduleAppointmentInput,
  SearchSlotsInput,
  Staff,
} from '../types.js';
import {
  countAppointmentOverview,
  findServiceByName,
  findStoreByNameFlexible,
  getAppointment,
  getAppointmentByCode,
  getAppointmentDetailByCustomer,
  getService,
  getStaff,
  getStore,
  isWithinAvailableSchedule,
  listAppointmentsByCustomer,
  listAppointmentsByFilters,
  listAvailableScheduleDates,
  listStaffSkillsForService,
  listServices,
  listStaff,
  listStores,
  listStaffSchedules,
  listStaffSchedulesBulk,
  searchAvailableTimeSlots,
} from '../queries.js';
import { deleteDaySchedules, listStoreSchedules, upsertDaySchedules, applyWeeklyScheduleTemplate } from './catalog.js';

const toAppointment = (row: Record<string, unknown>): Appointment => row as unknown as Appointment;

const normalizeIdempotencyKey = (value: string) => hashIdempotencyKey(value.trim());

/** 预约约束：只有知识库项目管理中同步成功且生效的项目才允许被预约。 */
const bookableCheck = (service: { source_system?: string; sync_status?: string; is_active?: boolean } | undefined) => {
  if (!service) return { ok: false, error_code: 'NOT_FOUND', message: 'service not found' as string };
  if (service.source_system !== 'knowledge_base' || service.sync_status !== 'synced') {
    return {
      ok: false,
      error_code: 'SERVICE_NOT_BOOKABLE',
      message: '该项目未同步自知识库项目管理，暂不可预约，请先点击"同步信息"',
    };
  }
  if (!service.is_active) return { ok: false, error_code: 'SERVICE_INACTIVE', message: '该项目已停用，不可预约' };
  return { ok: true, error_code: '', message: '' };
};

/** 数字人直连：customer_id 缺省时由身份注入（mcp 层 bindIdentity），再无则返回 undefined。 */
const resolveCustomerId = (input: CreateAppointmentInput | CancelAppointmentInput | RescheduleAppointmentInput | QueryAppointmentsInput) => {
  if ('customer_id' in input && input.customer_id?.trim()) return input.customer_id.trim();
  return undefined;
};

/** 数字人直接说项目名："我想预约皮肤管理" → service_name 解析 service_id。
 *  门店已配置可做项目时，优先按该店可做范围解析，防止约到门店未开通的项目。 */
const resolveService = async (input: { service_id?: string; service_name?: string; store_id?: string }) => {
  if (input.service_id?.trim()) return getService(input.service_id.trim());
  if (input.service_name?.trim()) return findServiceByName(input.service_name, input.store_id?.trim());
  return undefined;
};

/** 用户直接说门店名（"上海徐汇门店"）→ 门店 id 解析；找不到抛业务错误结构。
 *  走稳健匹配（精确/包含/反向包含/去后缀模糊），LLM 混入"用户确认"等前缀也能命中。 */
const resolveStoreOrError = async (input: { store_id?: string; store_name?: string }) => {
  if (input.store_id?.trim()) {
    const store = await getStore(input.store_id.trim());
    if (!store) return { store: undefined, error: { success: false as const, error_code: 'STORE_NOT_FOUND', message: '门店不存在或已停用' } };
    return { store, error: null };
  }
  if (input.store_name?.trim()) {
    const store = await findStoreByNameFlexible(input.store_name.trim());
    if (!store) {
      const activeStores = await listStores(true, undefined, 8);
      return {
        store: undefined,
        error: {
          success: false as const,
          error_code: 'STORE_NOT_FOUND',
          message: `未找到「${input.store_name.trim()}」对应的门店。可先调用 list_store_catalog(resource=stores) 查门店列表后再重试`,
          ...(activeStores.length > 0 ? { available_stores: activeStores.map((st) => ({ id: st.id, name: st.name })) } : {}),
        },
      };
    }
    return { store, error: null };
  }
  return { store: undefined, error: null };
};

/**
 * 门店解析 + 单店自动兜底：
 *  - 完全未传门店且系统只有一家在营门店时直接采用（消灭单店部署"反复追问哪家门店"的死循环，
 *    该问题源自 LLM 多次把门店名漏传/错放进 note，单店场景下追问毫无信息增益）；
 *  - 多家门店时返回 NEEDS_MORE_INFO 并附门店清单，让数字人问出"是A店还是B店"的具体问题；
 *  - 用户显式传了 store_id/store_name 但解析失败时，仍按 STORE_NOT_FOUND 报错（不静默改写）。
 */
const resolveStoreWithAutoDefault = async (input: { store_id?: string; store_name?: string }) => {
  const resolved = await resolveStoreOrError(input);
  if (resolved.error || resolved.store) return { ...resolved, autoSelected: false as const };
  const activeStores = await listStores(true, undefined, 8);
  if (activeStores.length === 1) {
    return { store: activeStores[0], error: null, autoSelected: true as const };
  }
  if (activeStores.length === 0) {
    return {
      store: undefined,
      error: { success: false as const, error_code: 'STORE_NOT_FOUND', message: '系统尚未配置在营门店，请先在管理后台添加门店' },
      autoSelected: false as const,
    };
  }
  return {
    store: undefined,
    error: {
      success: false as const,
      error_code: 'NEEDS_MORE_INFO',
      message: '该品牌有多家在营门店，请先向用户确认到店门店后再创建预约。',
      missing_fields: ['store_id|store_name'],
      stores: activeStores.map((st) => ({ id: st.id, name: st.name })),
      suggested_question: `请问您想到哪家门店？目前在营门店有：${activeStores.map((st) => st.name).join('、')}`,
    },
    autoSelected: false as const,
  };
};

/** 预约定位：优先 appointment_id，其次 appointment_code（数字人对话中常拿到预约码）。 */
const resolveAppointment = async (input: { appointment_id?: string; appointment_code?: string }) => {
  if (input.appointment_id?.trim()) return getAppointment(input.appointment_id.trim());
  if (input.appointment_code?.trim()) return getAppointmentByCode(input.appointment_code.trim());
  return undefined;
};

type AppointmentLocator = Pick<CancelAppointmentInput, 'appointment_id' | 'appointment_code' | 'service_id' | 'service_name' | 'status' | 'from_date' | 'to_date'>;

/**
 * 数字人对话定位预约：
 *   - 有 appointment_id / appointment_code 时精确命中；
 *   - 否则按"项目 + 日期范围 + 状态"在本人预约中定位；
 *   - 命中多个返回 AMBIGUOUS（附候选预约码），由数字人向用户二次确认，避免误操作。
 */
async function resolveAppointmentForCustomer(
  customerId: string,
  locator: AppointmentLocator,
): Promise<
  | { ok: true; appointment: Appointment }
  | { ok: false; error_code: string; message: string; candidates?: Array<{ appointment_id: string; appointment_code: string; service_id: string; start_at: string; status: AppointmentStatus }> }
> {
  if (locator.appointment_id?.trim() || locator.appointment_code?.trim()) {
    const appointment = await resolveAppointment(locator);
    if (!appointment) return { ok: false, error_code: 'NOT_FOUND', message: '预约不存在' };
    return { ok: true, appointment };
  }
  const matches = await listAppointmentsByCustomer(
    customerId,
    locator.from_date,
    locator.to_date,
    locator.status,
    locator.service_name,
    undefined,
  );
  let filtered = matches;
  if (locator.service_id?.trim()) filtered = filtered.filter((item) => item.service_id === locator.service_id);
  if (locator.status) filtered = filtered.filter((item) => item.status === locator.status);
  if (filtered.length === 0) {
    return { ok: false, error_code: 'NOT_FOUND', message: '未找到匹配的预约，请用 query_bookings(scope=my) 确认预约记录' };
  }
  if (filtered.length > 1) {
    return {
      ok: false,
      error_code: 'AMBIGUOUS',
      message: `找到 ${filtered.length} 个匹配的预约，请提供预约码确认`,
      candidates: filtered.slice(0, 5).map((item) => ({
        appointment_id: item.id,
        appointment_code: item.appointment_code,
        service_id: item.service_id,
        start_at: item.start_at,
        status: item.status,
      })),
    };
  }
  return { ok: true, appointment: filtered[0] };
}

/** 门店可做范围校验：门店已配置可做项目时，目标项目必须在其中（与后台门店勾选一致）。
 *  返回 null 表示通过，否则返回业务错误结构（非抛出，避免 MCP 层序列化异常）。 */
async function checkServiceInStoreScope(store: { id: string; service_ids?: string[] } | undefined, service: { id: string; name: string }) {
  if (!store) return null;
  if (store.service_ids && store.service_ids.length > 0 && !store.service_ids.includes(service.id)) {
    return { success: false as const, error_code: 'STORE_SERVICE_NOT_AVAILABLE', message: `「${service.name}」不在该门店可做项目内，请选择该店其他项目` };
  }
  return null;
}

const appRef = (input: { appointment_id?: string; appointment_code?: string }) =>
  input.appointment_id?.trim() || input.appointment_code?.trim() || 'unknown';

function assertCustomerIdentity(customerId: string | undefined) {
  if (!customerId) throw new Error('当前请求缺少用户身份（customer_id 或 X-Agent-Code），无法确认归属');
}

export async function searchAvailableSlots(input: SearchSlotsInput): Promise<
  | { success: true; service: { id: string; name: string; duration_minutes: number }; store?: { id: string; name: string }; slots: CompactTimeSlot[]; has_slots: boolean; suggestion?: { reason: string; message: string; dates?: string[] } }
  | { success: false; error_code: string; message: string }
> {
  assertNonEmpty(input.date, 'date');
  const date = normalizeDate(input.date);
  // 先解析门店（支持门店名 + 单店自动兜底），再在门店范围内解析项目，保证"门店有这个项目"的链路顺序
  const { store, error: storeError, autoSelected: storeAutoSelected } = await resolveStoreWithAutoDefault(input);
  if (storeError) return storeError;
  const storeId = store?.id ?? input.store_id?.trim();
  const service = await resolveService({ ...input, store_id: storeId });
  const bookable = bookableCheck(service);
  if (!bookable.ok) {
    return { success: false, error_code: bookable.error_code, message: bookable.message };
  }
  if (!service) {
    return { success: false, error_code: 'NOT_FOUND', message: 'service not found（可按 service_id 或 service_name 查询）' };
  }

  if (store) {
    const scopeError = await checkServiceInStoreScope(store, service);
    if (scopeError) return scopeError;
  }

  // 支持按员工名指定（"想让李美容师服务"）。技能列表缓存：空档兜底分支要复用，
  // 避免同一请求内 listStaffSkillsForService 被重复拉 2~3 次。
  let skillsCache: Staff[] | null = null;
  const getSkilledStaff = async (): Promise<Staff[]> => {
    skillsCache ??= await listStaffSkillsForService(service.id, storeId);
    return skillsCache;
  };

  let preferredStaffId = input.preferred_staff_id?.trim();
  if (!preferredStaffId && input.preferred_staff_name?.trim()) {
    const staffList = await getSkilledStaff();
    const matched = staffList.find((staff) => staff.name === input.preferred_staff_name?.trim())
      ?? staffList.find((staff) => staff.name.includes(input.preferred_staff_name!.trim()));
    if (!matched) {
      return { success: false, error_code: 'STAFF_NOT_FOUND', message: `该门店没有名为「${input.preferred_staff_name.trim()}」且会做「${service.name}」的员工` };
    }
    preferredStaffId = matched.id;
  }

  // service 由外层解析直接传入（precomputed），省掉 searchAvailableTimeSlots 内部的重复 getService
  const slots = await searchAvailableTimeSlots(service.id, storeId, date, preferredStaffId, { service });
  let reason = 'NO_AVAILABLE_SLOTS';
  let suggestionDates: string[] | undefined;
  if (slots.length === 0) {
    // 区分"没排班"与"排班已满"，帮数字人给出不同的追问话术
    const skilledStaff = await getSkilledStaff();
    const targetStaff = preferredStaffId
      ? skilledStaff.filter((item) => item.id === preferredStaffId)
      : skilledStaff;
    // 一次批量查询替代逐员工 N+1（原实现每人一次 listStaffSchedules）
    const anyScheduled = targetStaff.length > 0 && await (async () => {
      const schedules = await listStaffSchedulesBulk(
        targetStaff.map((staff) => staff.id),
        `${date}T00:00:00+08:00`,
        `${date}T23:59:59+08:00`,
      );
      return schedules.some((schedule) => schedule.status === 'available');
    })();
    if (targetStaff.length === 0) {
      reason = 'NO_SKILLED_STAFF';
    } else if (!anyScheduled) {
      reason = 'NO_SCHEDULE';
      // 该日期没人排班时，查未来 14 天内有哪些天已排班，数字人可直接建议
      suggestionDates = await listAvailableScheduleDates(
        targetStaff.map((staff) => staff.id),
        date,
        dayjsAddDays(date, 14),
      );
    }
  }
  return {
    success: true,
    service: { id: service.id, name: service.name, duration_minutes: service.duration_minutes },
    ...(store ? { store: { id: store.id, name: store.name } } : {}),
    ...(storeAutoSelected ? { store_auto_selected: true } : {}),
    // 精简 slots：每个 (员工, 开始时间) 只保留 1 个字段。原 7 字段/时段（含 UTC+本地
    // 双时间 + staff_id）在高峰日可达数十 KB pretty-JSON，是"mcp 日志几十 ms、
    // 用户体感几秒"的最大元凶——大载荷直接拖慢 LLM 的 tool-result 解析与二次生成。
    // end_local 可由 start_local+duration_minutes 推导；start_at/end_at 仍传原文
    // 供 manage_booking(action=create) 回填 start_at 用。
    // 不截断：截断会隐藏可约时段，属于行为变化；耗时优化靠减少 DB 往返与走索引解决。
    slots: slots.map((slot) => ({
      staff_name: slot.staff_name,
      start_local: slot.start_local,
      start_at: slot.start_at,
    })),
    has_slots: slots.length > 0,
    suggestion: slots.length > 0
      ? undefined
      : {
          reason,
          ...(suggestionDates && suggestionDates.length > 0 ? { dates: suggestionDates } : {}),
          message: reason === 'NO_SKILLED_STAFF'
            ? '该门店暂无会做此项目的员工，建议更换项目或门店。'
            : reason === 'NO_SCHEDULE'
              ? suggestionDates && suggestionDates.length > 0
                ? `该日期尚未排班，最近有排班的日期：${suggestionDates.slice(0, 5).join('、')}。`
                : '该日期尚未排班，建议改选其他日期，或先在管理后台为员工排班。'
              : '当天可约时段已约满，建议改选其他日期、门店或员工。',
        },
  };
}

/** 东八区日期 + N 天（用于"最近可约日"查询窗口） */
const dayjsAddDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * 建单幂等预查：先按 idempotency_key 唯一索引查（绝大多数命中走这里，一次即回）；
 * 未命中再按「客户+项目+员工+时段」四元组查（idx_appointments_idem4），等价于原
 * `WHERE key=$1 OR (四元组)`，只是把 OR 拆成两次索引查询，避免计划器退化成全表扫。
 * 语义与原 OR 完全等价：任一条件命中即返回同一行。
 */
async function findExistingAppointmentForCreate(input: {
  idempotencyKey: string;
  customerId: string;
  serviceId: string;
  staffId: string;
  startAt: string;
}) {
  const byKey = await pool.query(`SELECT * FROM appointments WHERE idempotency_key = $1 LIMIT 1`, [input.idempotencyKey]);
  if (byKey.rows[0]) return byKey.rows[0];
  const bySlot = await pool.query(
    `SELECT * FROM appointments
     WHERE customer_id = $1 AND service_id = $2 AND staff_id = $3 AND start_at = $4::timestamptz
     LIMIT 1`,
    [input.customerId, input.serviceId, input.staffId, input.startAt],
  );
  return bySlot.rows[0];
}

export async function createAppointment(input: CreateAppointmentInput) {
  // 先解析门店（支持门店名 + 单店自动兜底），项目解析限定在门店可做范围内
  const { store, error: storeError, autoSelected: storeAutoSelected } = await resolveStoreWithAutoDefault(input);
  if (storeError) return storeError;
  const storeId = store?.id ?? input.store_id?.trim();
  if (!storeId) {
    return { success: false as const, error_code: 'NEEDS_MORE_INFO', message: '缺少门店：请传 store_id 或 store_name' };
  }
  const service = await resolveService({ ...input, store_id: storeId });
  const bookable = bookableCheck(service);
  if (!bookable.ok) {
    return { success: false, error_code: bookable.error_code, message: bookable.message };
  }
  if (!service) {
    return { success: false, error_code: 'NOT_FOUND', message: 'service not found（可按 service_id 或 service_name 查询）' };
  }
  if (!store) {
    return { success: false, error_code: 'STORE_NOT_FOUND', message: '门店不存在或已停用' };
  }
  // 员工解析：优先 staff_id，其次在门店内按 staff_name 解析（用户说"让李美容师服务"）。
  // 技能校验与员工是否存在无关，并行发起：getStaff/matched 与技能列表互不依赖。
  // 原串行写法把「技能校验」排在员工解析之后，白白多等一个 DB 往返。
  const staffName = input.staff_name?.trim();
  const skillsPromise = listStaffSkillsForService(service.id, store.id);
  let staff = input.staff_id?.trim() ? await getStaff(input.staff_id.trim()) : undefined;
  if (!staff && staffName) {
    const storeStaff = await listStaff(store.id, undefined, staffName, true, 100);
    const matched = storeStaff.find((item) => item.name === staffName)
      ?? storeStaff.find((item) => item.name.includes(staffName));
    staff = matched ? await getStaff(matched.id) : undefined;
  }
  if (!staff) return { success: false, error_code: 'NOT_FOUND', message: '员工不存在或已停用（可按 staff_id 或 staff_name 指定）' };
  if (staff.store_id !== store.id) {
    return { success: false, error_code: 'STORE_MISMATCH', message: `员工「${staff.name}」不属于门店「${store.name}」` };
  }
  const scopeError = await checkServiceInStoreScope(store, service);
  if (scopeError) return scopeError;

  const staffSkills = await skillsPromise;
  if (!staffSkills.some((item) => item.id === staff.id)) {
    return { success: false, error_code: 'POLICY_DENIED', message: '该员工不支持此项目' };
  }

  const startAt = normalizeTimestamp(input.start_at ?? '');
  const endAt = addMinutes(startAt, service.duration_minutes);
  // 全链路最后一环：预约必须完整落在该员工一个 available 排班窗口内（用户问"某时间有没有空"的落库保证）
  const withinSchedule = await isWithinAvailableSchedule(staff.id, startAt, endAt);
  if (!withinSchedule) {
    return { success: false, error_code: 'OUTSIDE_SCHEDULE', message: `该时间不在员工「${staff.name}」的排班范围内，请先 query_slots 查可约时段` };
  }
  const customerId = resolveCustomerId(input);
  // 顾客来自 manage_customer_session(action=identify) 会话绑定时，从顾客档案补齐姓名/手机号，预约单不再落"到店客户"+空号
  let finalCustomerName = input.customer_name?.trim();
  let finalCustomerPhone = input.customer_phone?.trim();
  if (customerId?.startsWith('cust_')) {
    const profile = await pool.query(
      'SELECT display_name, phone_masked FROM customer_profiles WHERE customer_id = $1 LIMIT 1',
      [customerId],
    );
    if (profile.rows[0]) {
      finalCustomerName = finalCustomerName || (profile.rows[0] as { display_name: string | null }).display_name || undefined;
      finalCustomerPhone = finalCustomerPhone || (profile.rows[0] as { phone_masked: string | null }).phone_masked || undefined;
    }
  }
  // 数字人链路：idempotency_key 缺省时由"客户+项目+员工+时间"确定性生成，
  // 同一客户对同一时段重复确认只会创建一条，天然幂等。
  const idempotencyKey = normalizeIdempotencyKey(
    input.idempotency_key?.trim() ?? `create:${customerId ?? 'anon'}:${service.id}:${staff.id}:${startAt}`,
  );

  const existing = await findExistingAppointmentForCreate({
    idempotencyKey,
    customerId: customerId ?? 'anon',
    serviceId: service.id,
    staffId: staff.id,
    startAt,
  });
  const existingAppointment = existing ? toAppointment(existing as Record<string, unknown>) : undefined;
  const existingActive = existingAppointment != null && ['pending', 'confirmed', 'checked_in'].includes(existingAppointment.status);
  // 同请求重复提交（网络重试/口误重复确认）→ 幂等返回原单；
  // 注意：取消后重约的新单幂等键带 :rebook: 后缀，故同时按「客户+项目+员工+时段」命中活动单。
  if (existingAppointment && existingActive) {
    return {
      success: true,
      appointment: existingAppointment,
      deduplicated: true,
      /** 口播只给时间与到店核实话术：预约码不再下发给数字人（TTS 读码会逐字刷屏） */
      spoken: { time: formatBeijing(existingAppointment.start_at), verification: '预约成功，请凭预约时使用的手机号到店核实身份即可，无需报预约码。' },
      ...(storeAutoSelected ? { store_auto_selected: true, store: { id: store.id, name: store.name } } : {}),
    };
  }
  // 取消/完成/爽约后同一时段重新预约 → 旧单已终结，换新幂等键（DB 唯一约束）正常建新单
  const effectiveIdempotencyKey = existingAppointment ? `${idempotencyKey}:rebook:${Date.now()}` : idempotencyKey;

  const appointmentCode = makeAppointmentCode();
  const finalCustomerId = customerId ?? `cust_${hashIdempotencyKey(`${finalCustomerPhone ?? 'anon'}:${finalCustomerName ?? 'guest'}`).slice(0, 12)}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO appointments (
        appointment_code, customer_id, customer_name, customer_phone,
        store_id, staff_id, service_id, start_at, end_at, status, idempotency_key, note
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10,$11,$12)
      RETURNING *`,
      [appointmentCode, finalCustomerId, finalCustomerName ?? '到店客户', finalCustomerPhone ?? '', store.id, staff.id, service.id, startAt, endAt, 'confirmed', effectiveIdempotencyKey, input.note ?? null],
    );
    const appointment = toAppointment(inserted.rows[0] as Record<string, unknown>);
    await writeAudit({
      appointment_id: appointment.id,
      operator_type: 'customer',
      operator_id: finalCustomerId,
      action: 'create',
      before_data: null,
      after_data: appointment as unknown as Record<string, unknown>,
    }, client);
    await client.query('COMMIT');
    return {
      success: true,
      appointment,
      /** 口播专用：数字人向用户播报时使用。严禁朗读 appointment_code 全文或内部 id，
       *  故此处不再下发 booking_code，只给时间与"凭手机号到店核实"话术。 */
      spoken: {
        time: formatBeijing(startAt),
        verification: '预约成功，请凭预约时使用的手机号到店核实身份即可，无需报预约码。',
      },
      ...(storeAutoSelected ? { store_auto_selected: true, store: { id: store.id, name: store.name } } : {}),
    };
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (String(error?.constraint ?? '') === 'no_staff_booking_overlap') {
      return { success: false, error_code: 'TIME_CONFLICT', message: '该时段已被占用' };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getMyAppointments(input: QueryAppointmentsInput) {
  const customerId = resolveCustomerId(input);
  assertCustomerIdentity(customerId);
  // 「姓名+手机号」成对时按人取并集（覆盖建档前的 guest 单）；不成对则维持 id 作用域。
  // 手机号相同不再等于同一人：姓名必须同时匹配。
  const person = input.customer_name?.trim() && input.customer_phone?.trim()
    ? { name: input.customer_name.trim(), phone: input.customer_phone.trim() }
    : undefined;
  return listAppointmentsByCustomer(customerId!, input.from_date, input.to_date, input.status, input.service_name, input.keyword, person);
}

export async function listAppointments(input: {
  customer_id?: string;
  customer_name?: string;
  customer_phone?: string;
  store_id?: string;
  staff_id?: string;
  service_id?: string;
  service_name?: string;
  from_date?: string;
  to_date?: string;
  status?: AppointmentStatus;
  keyword?: string;
  limit?: number;
  offset?: number;
}) {
  return listAppointmentsByFilters(input);
}

export async function confirmAppointment(input: { appointment_id: string; operator_id?: string; customer_id?: string }) {
  const appointment = await getAppointment(input.appointment_id);
  if (!appointment) return { success: false, error_code: 'NOT_FOUND', message: '预约不存在' };
  if (appointment.status !== 'pending') return { success: false, error_code: 'INVALID_STATE', message: '当前状态不允许确认' };
  const updated = await pool.query(`UPDATE appointments SET status='confirmed', updated_at=now() WHERE id=$1 RETURNING *`, [appointment.id]);
  const next = toAppointment(updated.rows[0] as Record<string, unknown>);
  await writeAudit({
    appointment_id: next.id,
    operator_type: 'staff',
    operator_id: input.operator_id ?? next.staff_id,
    action: 'confirm',
    before_data: appointment as unknown as Record<string, unknown>,
    after_data: next as unknown as Record<string, unknown>,
  });
  return { success: true, appointment: next };
}

export async function getAppointmentByCustomer(input: { customer_id?: string; customer_name?: string; customer_phone?: string; appointment_id?: string; appointment_code?: string }) {
  const customerId = resolveCustomerId(input as QueryAppointmentsInput);
  assertCustomerIdentity(customerId);
  if (!input.appointment_id && !input.appointment_code) throw new Error('appointment_id or appointment_code is required');
  // 「姓名+手机号」成对时允许命中本人 guest 单（建档前历史预约），仍要求姓名一致
  const person = input.customer_name?.trim() && input.customer_phone?.trim()
    ? { name: input.customer_name.trim(), phone: input.customer_phone.trim() }
    : undefined;
  return getAppointmentDetailByCustomer(customerId!, input.appointment_id, input.appointment_code, person);
}

export async function listBookingReferenceData(input: { active_only?: boolean; keyword?: string; limit?: number; store_id?: string; service_id?: string }) {
  const [stores, services, staff] = await Promise.all([
    listStores(input.active_only !== false, input.keyword, input.limit ?? 20),
    listServices(input.store_id, input.keyword, input.active_only !== false, input.limit ?? 20, true),
    listStaff(input.store_id, input.service_id, input.keyword, input.active_only !== false, input.limit ?? 20),
  ]);
  return { stores, services, staff };
}

export async function listStoreServices(input: { store_id: string; keyword?: string; limit?: number }) {
  assertNonEmpty(input.store_id, 'store_id');
  return listServices(input.store_id, input.keyword, true, input.limit ?? 20, true);
}

export async function listStoreStaff(input: { store_id: string; service_id?: string; keyword?: string; limit?: number }) {
  assertNonEmpty(input.store_id, 'store_id');
  return listStaff(input.store_id, input.service_id, input.keyword, true, input.limit ?? 20);
}

export async function listStaffAvailability(input: { staff_id: string; date_from: string; date_to: string }) {
  assertNonEmpty(input.staff_id, 'staff_id');
  assertNonEmpty(input.date_from, 'date_from');
  assertNonEmpty(input.date_to, 'date_to');
  const staff = await getStaff(input.staff_id);
  if (!staff) throw new Error('Staff not found');
  return listStaffSchedules(input.staff_id, input.date_from, input.date_to);
}

/** 管理后台：门店某段时间内的员工排班（带员工名） */
export async function listStoreScheduleGrid(input: { store_id: string; date_from: string; date_to: string; staff_id?: string }) {
  assertNonEmpty(input.store_id, 'store_id');
  assertNonEmpty(input.date_from, 'date_from');
  assertNonEmpty(input.date_to, 'date_to');
  return listStoreSchedules({ store_id: input.store_id, date_from: input.date_from, date_to: input.date_to, staff_id: input.staff_id });
}

export async function upsertDayStaffSchedules(input: { store_id: string; staff_id: string; date: string; shifts: Array<{ start: string; end: string; status?: string }>; operator?: string }) {
  return upsertDaySchedules(input);
}

export async function deleteDayStaffSchedules(input: { store_id: string; staff_id: string; date: string; start?: string; operator?: string }) {
  return deleteDaySchedules(input);
}

export async function applyStaffWeeklySchedule(input: {
  store_id: string;
  staff_id: string;
  date_from: string;
  date_to: string;
  weekdays: number[];
  shifts: Array<{ start: string; end: string; status?: string }>;
  operator?: string;
}) {
  return applyWeeklyScheduleTemplate(input);
}

export async function getAppointmentTimeline(input: { customer_id: string; appointment_id?: string; appointment_code?: string }) {
  const detail = await getAppointmentByCustomer(input);
  return detail;
}

export async function cancelAppointment(input: CancelAppointmentInput) {
  const customerId = resolveCustomerId(input);
  assertCustomerIdentity(customerId);

  const locator = {
    appointment_id: input.appointment_id,
    appointment_code: input.appointment_code,
    service_id: input.service_id,
    service_name: input.service_name,
    status: input.status,
    from_date: input.from_date,
    to_date: input.to_date,
  };
  const resolved = await resolveAppointmentForCustomer(customerId!, locator);
  if (!resolved.ok) return resolved;
  const appointment = resolved.appointment;

  return withIdempotentOperation({
    operationKey: `cancel:${input.idempotency_key?.trim() ?? appRef(input)}:${customerId}:${appointment.id}`,
    appointmentId: appointment.id,
    action: 'cancel',
    requestPayload: { appointment_ref: appRef(input), customer_id: customerId, reason: input.reason ?? null },
    execute: async () => {
      if (appointment.customer_id !== customerId) return { success: false, error_code: 'POLICY_DENIED', message: '无权操作该预约' };
      if (appointment.status === 'cancelled' || appointment.status === 'completed' || appointment.status === 'checked_in' || appointment.status === 'no_show') return { success: false, error_code: 'INVALID_STATE', message: '当前状态不允许取消' };

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(
          `UPDATE appointments
           SET status='cancelled', updated_at=now()
           WHERE id=$1
           RETURNING *`,
          [appointment.id],
        );
        const next = toAppointment(updated.rows[0] as Record<string, unknown>);
        await writeAudit({
          appointment_id: next.id,
          operator_type: 'customer',
          operator_id: next.customer_id,
          action: 'cancel',
          before_data: appointment as unknown as Record<string, unknown>,
          after_data: next as unknown as Record<string, unknown>,
        }, client);
        await client.query('COMMIT');
        return { success: true, appointment: next };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

/** 管理端取消（管理后台/店长）：按 appointment_id 直达，不校验顾客归属。
 *  与顾客取消的区别：操作人记为 staff/operator，且允许取消 checked_in 之外的任意状态。 */
export async function adminCancelAppointment(input: { appointment_id: string; operator?: string; reason?: string }) {
  assertNonEmpty(input.appointment_id, 'appointment_id');
  const appointment = await getAppointment(input.appointment_id);
  if (!appointment) return { success: false as const, error_code: 'NOT_FOUND', message: '预约不存在' };
  if (appointment.status === 'cancelled') return { success: false as const, error_code: 'INVALID_STATE', message: '该预约已是取消状态' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE appointments SET status='cancelled', updated_at=now() WHERE id=$1 RETURNING *`,
      [appointment.id],
    );
    const next = toAppointment(updated.rows[0] as Record<string, unknown>);
    await writeAudit({
      appointment_id: next.id,
      operator_type: 'staff',
      operator_id: input.operator ?? 'admin',
      action: 'cancel',
      before_data: appointment as unknown as Record<string, unknown>,
      after_data: next as unknown as Record<string, unknown>,
    }, client);
    await client.query('COMMIT');
    return { success: true as const, appointment: next };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function rescheduleAppointment(input: RescheduleAppointmentInput) {
  const customerId = resolveCustomerId(input);
  assertCustomerIdentity(customerId);
  const newStartAt = normalizeTimestamp(input.new_start_at);

  const locator = {
    appointment_id: input.appointment_id,
    appointment_code: input.appointment_code,
    service_id: input.service_id,
    service_name: input.service_name,
    status: input.status,
    from_date: input.from_date,
    to_date: input.to_date,
  };
  const resolved = await resolveAppointmentForCustomer(customerId!, locator);
  if (!resolved.ok) return resolved;
  const appointment = resolved.appointment;

  return withIdempotentOperation({
    operationKey: `reschedule:${input.idempotency_key?.trim() ?? appRef(input)}:${customerId}:${appointment.id}:${newStartAt}`,
    appointmentId: appointment.id,
    action: 'reschedule',
    requestPayload: { appointment_ref: appRef(input), customer_id: customerId, new_start_at: newStartAt },
    execute: async () => {
      if (appointment.customer_id !== customerId) return { success: false, error_code: 'POLICY_DENIED', message: '无权操作该预约' };
      if (appointment.status !== 'confirmed' && appointment.status !== 'pending') return { success: false, error_code: 'INVALID_STATE', message: '当前状态不允许改期' };

      const service = await getService(appointment.service_id);
      if (!service) throw new Error('Service not found');
      const newEndAt = addMinutes(newStartAt, service.duration_minutes);

      // 与 create 同一约束：新时段必须完整落在该员工一个 available 排班窗口内，
      // 否则改期会把预约挪到排班外（员工实际不上班的时间）。
      const withinSchedule = await isWithinAvailableSchedule(appointment.staff_id, newStartAt, newEndAt);
      if (!withinSchedule) {
        return { success: false, error_code: 'OUTSIDE_SCHEDULE', message: '新时段不在员工排班范围内，请先 query_slots 查可约时段' };
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const conflict = await client.query(
          `SELECT 1 FROM appointments
           WHERE staff_id = $1
             AND id <> $2
             AND status IN ('pending', 'confirmed', 'checked_in')
             AND tstzrange(start_at, end_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
           LIMIT 1`,
          [appointment.staff_id, appointment.id, newStartAt, newEndAt],
        );
        if ((conflict.rowCount ?? 0) > 0) {
          await client.query('ROLLBACK');
          return { success: false, error_code: 'TIME_CONFLICT', message: '新时段已被占用' };
        }
        const updated = await client.query(
          `UPDATE appointments
           SET start_at=$2::timestamptz,
               end_at=$3::timestamptz,
               updated_at=now()
           WHERE id=$1
           RETURNING *`,
          [appointment.id, newStartAt, newEndAt],
        );
        const next = toAppointment(updated.rows[0] as Record<string, unknown>);
        await writeAudit({
          appointment_id: next.id,
          operator_type: 'customer',
          operator_id: next.customer_id,
          action: 'reschedule',
          before_data: appointment as unknown as Record<string, unknown>,
          after_data: next as unknown as Record<string, unknown>,
        }, client);
        await client.query('COMMIT');
        return { success: true, appointment: next };
      } catch (error: any) {
        await client.query('ROLLBACK');
        if (String(error?.constraint ?? '') === 'no_staff_booking_overlap') {
          return { success: false, error_code: 'TIME_CONFLICT', message: '新时段已被占用' };
        }
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

export async function checkInAppointment(input: { appointment_id: string; customer_id?: string; operator_id?: string }) {
  const customerId = input.customer_id?.trim();
  assertCustomerIdentity(customerId);
  const appointment = await getAppointment(input.appointment_id);
  if (!appointment) return { success: false, error_code: 'NOT_FOUND', message: '预约不存在' };
  if (appointment.customer_id !== customerId) return { success: false, error_code: 'POLICY_DENIED', message: '无权操作该预约' };
  if (appointment.status !== 'confirmed') return { success: false, error_code: 'INVALID_STATE', message: '当前状态不允许到店签到' };
  const updated = await pool.query(`UPDATE appointments SET status='checked_in', updated_at=now() WHERE id=$1 RETURNING *`, [appointment.id]);
  const next = toAppointment(updated.rows[0] as Record<string, unknown>);
  await writeAudit({
    appointment_id: next.id,
    operator_type: 'staff',
    operator_id: input.operator_id ?? next.staff_id,
    action: 'check_in',
    before_data: appointment as unknown as Record<string, unknown>,
    after_data: next as unknown as Record<string, unknown>,
  });
  return { success: true, appointment: next };
}

export async function completeAppointment(input: { appointment_id: string; operator_id?: string }) {
  const appointment = await getAppointment(input.appointment_id);
  if (!appointment) return { success: false, error_code: 'NOT_FOUND', message: '预约不存在' };
  if (appointment.status !== 'checked_in') return { success: false, error_code: 'INVALID_STATE', message: '当前状态不允许完成' };
  const updated = await pool.query(`UPDATE appointments SET status='completed', updated_at=now() WHERE id=$1 RETURNING *`, [appointment.id]);
  const next = toAppointment(updated.rows[0] as Record<string, unknown>);
  await writeAudit({
    appointment_id: next.id,
    operator_type: 'staff',
    operator_id: input.operator_id ?? next.staff_id,
    action: 'complete',
    before_data: appointment as unknown as Record<string, unknown>,
    after_data: next as unknown as Record<string, unknown>,
  });
  return { success: true, appointment: next };
}

export async function markNoShowAppointment(input: { appointment_id: string; operator_id?: string }) {
  const appointment = await getAppointment(input.appointment_id);
  if (!appointment) return { success: false, error_code: 'NOT_FOUND', message: '预约不存在' };
  if (appointment.status !== 'confirmed') return { success: false, error_code: 'INVALID_STATE', message: '当前状态不允许设为爽约' };
  const updated = await pool.query(`UPDATE appointments SET status='no_show', updated_at=now() WHERE id=$1 RETURNING *`, [appointment.id]);
  const next = toAppointment(updated.rows[0] as Record<string, unknown>);
  await writeAudit({
    appointment_id: next.id,
    operator_type: 'staff',
    operator_id: input.operator_id ?? next.staff_id,
    action: 'no_show',
    before_data: appointment as unknown as Record<string, unknown>,
    after_data: next as unknown as Record<string, unknown>,
  });
  return { success: true, appointment: next };
}

export async function getAppointmentByIdentifier(input: { customer_id?: string; appointment_id?: string; appointment_code?: string }) {
  return getAppointmentByCustomer(input);
}

export async function listAppointmentAudits(input: { customer_id?: string; appointment_id?: string; appointment_code?: string }) {
  const detail = await getAppointmentByCustomer(input);
  return detail?.audits ?? [];
}

export async function getAppointmentOverview(input: { from_date?: string; to_date?: string; store_id?: string }) {
  return countAppointmentOverview(input);
}
