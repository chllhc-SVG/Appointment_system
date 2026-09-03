import { pool } from '../db/pool.js';
import { writeAudit } from '../audit.js';
import { withIdempotentOperation } from '../idempotency.js';
import { addMinutes, assertNonEmpty, hashIdempotencyKey, makeAppointmentCode } from '../utils.js';
import type {
  Appointment,
  AppointmentStatus,
  CancelAppointmentInput,
  CreateAppointmentInput,
  QueryAppointmentsInput,
  RescheduleAppointmentInput,
  SearchSlotsInput,
  TimeSlot,
} from '../types.js';
import {
  countAppointmentOverview,
  findServiceByName,
  getAppointment,
  getAppointmentByCode,
  getAppointmentDetailByCustomer,
  getService,
  getStaff,
  getStore,
  listAppointmentsByCustomer,
  listAppointmentsByFilters,
  listBusyAppointments,
  listStaffSkillsForService,
  listServices,
  listStaff,
  listStores,
  listStaffSchedules,
  searchAvailableTimeSlots,
} from '../queries.js';

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

/** 数字人直接说项目名："我想预约皮肤管理" → service_name 解析 service_id。 */
const resolveService = async (input: { service_id?: string; service_name?: string }) => {
  if (input.service_id?.trim()) return getService(input.service_id.trim());
  if (input.service_name?.trim()) return findServiceByName(input.service_name);
  return undefined;
};

/** 预约定位：优先 appointment_id，其次 appointment_code（数字人对话中常拿到预约码）。 */
const resolveAppointment = async (input: { appointment_id?: string; appointment_code?: string }) => {
  if (input.appointment_id?.trim()) return getAppointment(input.appointment_id.trim());
  if (input.appointment_code?.trim()) return getAppointmentByCode(input.appointment_code.trim());
  return undefined;
};

const appRef = (input: { appointment_id?: string; appointment_code?: string }) =>
  input.appointment_id?.trim() || input.appointment_code?.trim() || 'unknown';

function assertCustomerIdentity(customerId: string | undefined) {
  if (!customerId) throw new Error('当前请求缺少用户身份（customer_id 或 X-Agent-Code），无法确认归属');
}

export async function searchAvailableSlots(input: SearchSlotsInput): Promise<
  | { success: true; service: { id: string; name: string; duration_minutes: number }; slots: TimeSlot[] }
  | { success: false; error_code: string; message: string }
> {
  assertNonEmpty(input.date, 'date');
  const service = await resolveService(input);
  const bookable = bookableCheck(service);
  if (!bookable.ok) {
    return { success: false, error_code: bookable.error_code, message: bookable.message };
  }
  if (!service) {
    return { success: false, error_code: 'NOT_FOUND', message: 'service not found（可按 service_id 或 service_name 查询）' };
  }

  const slots = await searchAvailableTimeSlots(service.id, input.store_id, input.date, input.preferred_staff_id);
  return {
    success: true,
    service: { id: service.id, name: service.name, duration_minutes: service.duration_minutes },
    slots,
  };
}

export async function createAppointment(input: CreateAppointmentInput) {
  const service = await resolveService(input);
  const bookable = bookableCheck(service);
  if (!bookable.ok) {
    return { success: false, error_code: bookable.error_code, message: bookable.message };
  }
  const store = await getStore(input.store_id);
  const staff = await getStaff(input.staff_id);
  if (!service || !store || !staff) throw new Error('Service/store/staff not found');

  const staffSkills = await listStaffSkillsForService(service.id, store.id);
  if (!staffSkills.some((item) => item.id === staff.id)) {
    return { success: false, error_code: 'POLICY_DENIED', message: '该员工不支持此项目' };
  }

  const endAt = addMinutes(input.start_at, service.duration_minutes);
  const customerId = resolveCustomerId(input);
  // 数字人链路：idempotency_key 缺省时由"客户+项目+员工+时间"确定性生成，
  // 同一客户对同一时段重复确认只会创建一条，天然幂等。
  const idempotencyKey = normalizeIdempotencyKey(
    input.idempotency_key?.trim() ?? `create:${customerId ?? 'anon'}:${service.id}:${input.staff_id}:${input.start_at}`,
  );

  const existing = await pool.query('SELECT * FROM appointments WHERE idempotency_key = $1 LIMIT 1', [idempotencyKey]);
  if (existing.rows[0]) return { success: true, appointment: toAppointment(existing.rows[0]), deduplicated: true };

  const appointmentCode = makeAppointmentCode();
  const finalCustomerId = customerId ?? `cust_${hashIdempotencyKey(`${input.customer_phone ?? 'anon'}:${input.customer_name ?? 'guest'}`).slice(0, 12)}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO appointments (
        appointment_code, customer_id, customer_name, customer_phone,
        store_id, staff_id, service_id, start_at, end_at, status, idempotency_key, note
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10,$11,$12)
      RETURNING *`,
      [appointmentCode, finalCustomerId, input.customer_name ?? '到店客户', input.customer_phone ?? '', store.id, staff.id, service.id, input.start_at, endAt, 'confirmed', idempotencyKey, input.note ?? null],
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
    return { success: true, appointment };
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
  return listAppointmentsByCustomer(customerId!, input.from_date, input.to_date, input.status);
}

export async function listAppointments(input: {
  customer_id?: string;
  store_id?: string;
  staff_id?: string;
  service_id?: string;
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

export async function getAppointmentByCustomer(input: { customer_id?: string; appointment_id?: string; appointment_code?: string }) {
  const customerId = resolveCustomerId(input as QueryAppointmentsInput);
  assertCustomerIdentity(customerId);
  if (!input.appointment_id && !input.appointment_code) throw new Error('appointment_id or appointment_code is required');
  return getAppointmentDetailByCustomer(customerId!, input.appointment_id, input.appointment_code);
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

export async function getAppointmentTimeline(input: { customer_id: string; appointment_id?: string; appointment_code?: string }) {
  const detail = await getAppointmentByCustomer(input);
  return detail;
}

export async function cancelAppointment(input: CancelAppointmentInput) {
  const customerId = resolveCustomerId(input);
  assertCustomerIdentity(customerId);

  return withIdempotentOperation({
    operationKey: `cancel:${input.idempotency_key?.trim() ?? appRef(input)}:${customerId}`,
    appointmentId: input.appointment_id ?? input.appointment_code ?? undefined,
    action: 'cancel',
    requestPayload: { appointment_ref: appRef(input), customer_id: customerId, reason: input.reason ?? null },
    execute: async () => {
      const appointment = await resolveAppointment(input);
      if (!appointment) return { success: false, error_code: 'NOT_FOUND', message: '预约不存在' };
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

export async function rescheduleAppointment(input: RescheduleAppointmentInput) {
  const customerId = resolveCustomerId(input);
  assertCustomerIdentity(customerId);

  return withIdempotentOperation({
    operationKey: `reschedule:${input.idempotency_key?.trim() ?? appRef(input)}:${customerId}:${input.new_start_at}`,
    appointmentId: input.appointment_id ?? input.appointment_code ?? undefined,
    action: 'reschedule',
    requestPayload: { appointment_ref: appRef(input), customer_id: customerId, new_start_at: input.new_start_at },
    execute: async () => {
      const appointment = await resolveAppointment(input);
      if (!appointment) return { success: false, error_code: 'NOT_FOUND', message: '预约不存在' };
      if (appointment.customer_id !== customerId) return { success: false, error_code: 'POLICY_DENIED', message: '无权操作该预约' };
      if (appointment.status !== 'confirmed' && appointment.status !== 'pending') return { success: false, error_code: 'INVALID_STATE', message: '当前状态不允许改期' };

      const service = await getService(appointment.service_id);
      if (!service) throw new Error('Service not found');
      const newEndAt = addMinutes(input.new_start_at, service.duration_minutes);

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
          [appointment.staff_id, appointment.id, input.new_start_at, newEndAt],
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
          [appointment.id, input.new_start_at, newEndAt],
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
