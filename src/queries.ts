import { pool } from './db/pool.js';
import type {
  Appointment,
  AppointmentAudit,
  AppointmentStatus,
  AppointmentDetail,
  ListServicesInput,
  ListStaffInput,
  ListStaffSchedulesInput,
  ListStoresInput,
  Service,
  ServiceWithStats,
  Staff,
  StaffSchedule,
  StaffWithSkills,
  Store,
  TimeSlot,
} from './types.js';

const mapStore = (row: Record<string, unknown>): Store => row as unknown as Store;
const mapStaff = (row: Record<string, unknown>): Staff => row as unknown as Staff;
const mapService = (row: Record<string, unknown>): Service => row as unknown as Service;
const mapSchedule = (row: Record<string, unknown>): StaffSchedule => row as unknown as StaffSchedule;
const mapAppointment = (row: Record<string, unknown>): Appointment => row as unknown as Appointment;
const mapAudit = (row: Record<string, unknown>): AppointmentAudit => row as unknown as AppointmentAudit;

const toPagination = (limit?: number) => Math.max(1, Math.min(Number(limit ?? 20), 100));

export async function listStores(activeOnly = true, keyword?: string, limit = 20) {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (activeOnly) conditions.push(`st.is_active = true`);
  if (keyword?.trim()) {
    params.push(`%${keyword.trim()}%`);
    conditions.push(`(st.name ILIKE $${params.length} OR st.timezone ILIKE $${params.length})`);
  }
  params.push(toPagination(limit));
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(`
    SELECT
      st.*,
      COALESCE(array_agg(ss.service_id) FILTER (WHERE ss.service_id IS NOT NULL), '{}') AS service_ids
    FROM stores st
    LEFT JOIN store_services ss ON ss.store_id = st.id
    ${where}
    GROUP BY st.id
    ORDER BY st.updated_at DESC, st.name ASC
    LIMIT $${params.length}`,
  params);
  return rows.map(mapStore);
}

export async function getStore(id: string) {
  const { rows } = await pool.query(
    `SELECT
       st.*,
       COALESCE(array_agg(ss.service_id) FILTER (WHERE ss.service_id IS NOT NULL), '{}') AS service_ids
     FROM stores st
     LEFT JOIN store_services ss ON ss.store_id = st.id
     WHERE st.id = $1 AND st.is_active = true
     GROUP BY st.id
     LIMIT 1`,
    [id],
  );
  return rows[0] ? mapStore(rows[0]) : undefined;
}

export async function listServices(storeId?: string, keyword?: string, activeOnly = true, limit = 20, bookableOnly = false): Promise<ServiceWithStats[]> {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (activeOnly) conditions.push(`s.is_active = true`);
  if (bookableOnly) {
    // 预约约束：仅知识库项目管理中同步成功的项目可预约
    conditions.push(`s.source_system = 'knowledge_base'`);
    conditions.push(`s.sync_status = 'synced'`);
  }
  if (storeId?.trim()) {
    params.push(storeId.trim());
    // 门店可做的项目 = 门店勾选的 store_services；旧数据尚无勾选时回退为"店内在职员工具备技能的项目"
    conditions.push(`(
      CASE WHEN EXISTS (SELECT 1 FROM store_services ss2 WHERE ss2.store_id = $${params.length})
        THEN EXISTS (SELECT 1 FROM store_services ss3 WHERE ss3.store_id = $${params.length} AND ss3.service_id = s.id)
        ELSE EXISTS (
          SELECT 1 FROM staff_service_skills sk
          JOIN staff st ON st.id = sk.staff_id
          WHERE sk.service_id = s.id AND st.store_id = $${params.length} AND st.is_active = true
        )
      END
    )`);
  }
  if (keyword?.trim()) {
    params.push(`%${keyword.trim()}%`);
    conditions.push(`s.name ILIKE $${params.length}`);
  }
  params.push(toPagination(limit));
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query<ServiceWithStats>(`
    SELECT
      s.*,
      COUNT(DISTINCT sk.staff_id)::int AS staff_count,
      COUNT(DISTINCT st.store_id)::int AS store_count
    FROM services s
    LEFT JOIN staff_service_skills sk ON sk.service_id = s.id
    LEFT JOIN staff st ON st.id = sk.staff_id AND st.is_active = true
    ${where}
    GROUP BY s.id
    ORDER BY s.updated_at DESC, s.name ASC
    LIMIT $${params.length}`,
  params);
  return rows;
}

export async function getService(id: string) {
  const { rows } = await pool.query('SELECT * FROM services WHERE id = $1 AND is_active = true LIMIT 1', [id]);
  return rows[0] ? mapService(rows[0]) : undefined;
}

/** 按名称模糊匹配服务（数字人直接说"皮肤管理"即可解析），匹配多个时返回第一个。
 *  传入 storeId 时限定该店可做范围（store_services，旧数据无勾选时回退"店内在职员工可做项目"），
 *  避免数字人约到该店未开通的项目。 */
export async function findServiceByName(name: string, storeId?: string) {
  const params: unknown[] = [name.trim()];
  const conditions: string[] = [`s.is_active = true`];
  if (storeId?.trim()) {
    params.push(storeId.trim());
    conditions.push(`(
      CASE WHEN EXISTS (SELECT 1 FROM store_services ss2 WHERE ss2.store_id = $${params.length})
        THEN EXISTS (SELECT 1 FROM store_services ss3 WHERE ss3.store_id = $${params.length} AND ss3.service_id = s.id)
        ELSE EXISTS (
          SELECT 1 FROM staff_service_skills sk
          JOIN staff st ON st.id = sk.staff_id
          WHERE sk.service_id = s.id AND st.store_id = $${params.length} AND st.is_active = true
        )
      END
    )`);
  }
  params.push(`%${name.trim()}%`);
  const { rows } = await pool.query(
    `SELECT * FROM services s
     WHERE ${conditions.join(' AND ')} AND s.name ILIKE $${params.length}
     ORDER BY s.name ASC LIMIT 1`,
    params,
  );
  return rows[0] ? mapService(rows[0]) : undefined;
}

export async function listStaff(storeId?: string, serviceId?: string, keyword?: string, activeOnly = true, limit = 20): Promise<StaffWithSkills[]> {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (activeOnly) conditions.push(`s.is_active = true`);
  if (storeId?.trim()) {
    params.push(storeId.trim());
    conditions.push(`s.store_id = $${params.length}`);
  }
  if (serviceId?.trim()) {
    params.push(serviceId.trim());
    conditions.push(`EXISTS (SELECT 1 FROM staff_service_skills sk WHERE sk.staff_id = s.id AND sk.service_id = $${params.length})`);
  }
  if (keyword?.trim()) {
    params.push(`%${keyword.trim()}%`);
    conditions.push(`s.name ILIKE $${params.length}`);
  }
  params.push(toPagination(limit));
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query<StaffWithSkills>(`
    SELECT
      s.*,
      COALESCE(array_agg(DISTINCT sk.service_id) FILTER (WHERE sk.service_id IS NOT NULL), '{}') AS service_ids,
      COALESCE(array_agg(DISTINCT sv.name) FILTER (WHERE sv.name IS NOT NULL), '{}') AS service_names
    FROM staff s
    LEFT JOIN staff_service_skills sk ON sk.staff_id = s.id
    LEFT JOIN services sv ON sv.id = sk.service_id
    ${where}
    GROUP BY s.id
    ORDER BY s.updated_at DESC, s.name ASC
    LIMIT $${params.length}`,
  params);
  return rows;
}

export async function getStaff(id: string) {
  const { rows } = await pool.query('SELECT * FROM staff WHERE id = $1 AND is_active = true LIMIT 1', [id]);
  return rows[0] ? mapStaff(rows[0]) : undefined;
}

export async function getAppointment(id: string) {
  const { rows } = await pool.query('SELECT * FROM appointments WHERE id = $1 LIMIT 1', [id]);
  return rows[0] ? mapAppointment(rows[0]) : undefined;
}

export async function getAppointmentByCode(code: string) {
  const { rows } = await pool.query('SELECT * FROM appointments WHERE appointment_code = $1 LIMIT 1', [code]);
  return rows[0] ? mapAppointment(rows[0]) : undefined;
}

export async function getAppointmentDetailByCustomer(customerId: string, appointmentId?: string, appointmentCode?: string) {
  const appointment = appointmentId
    ? await getAppointment(appointmentId)
    : appointmentCode
      ? await getAppointmentByCode(appointmentCode)
      : undefined;
  if (!appointment || appointment.customer_id !== customerId) return undefined;
  const [store, staff, service, audits] = await Promise.all([
    getStore(appointment.store_id),
    getStaff(appointment.staff_id),
    getService(appointment.service_id),
    listAuditsByAppointment(appointment.id),
  ]);
  return { appointment, store, staff, service, audits } satisfies AppointmentDetail;
}

export async function listAppointmentsByCustomer(
  customerId: string,
  fromDate?: string,
  toDate?: string,
  status?: AppointmentStatus,
  serviceName?: string,
  keyword?: string,
) {
  const conditions: string[] = ['customer_id = $1'];
  const params: unknown[] = [customerId];
  if (fromDate) { params.push(fromDate); conditions.push(`start_at >= $${params.length}`); }
  if (toDate) { params.push(toDate); conditions.push(`start_at <= $${params.length}`); }
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (serviceName?.trim()) {
    params.push(`%${serviceName.trim()}%`);
    conditions.push(`EXISTS (SELECT 1 FROM services sv WHERE sv.id = appointments.service_id AND sv.name ILIKE $${params.length})`);
  }
  if (keyword?.trim()) {
    params.push(`%${keyword.trim()}%`);
    conditions.push(`(
      appointment_code ILIKE $${params.length}
      OR EXISTS (SELECT 1 FROM services sv2 WHERE sv2.id = appointments.service_id AND sv2.name ILIKE $${params.length})
      OR EXISTS (SELECT 1 FROM staff sf WHERE sf.id = appointments.staff_id AND sf.name ILIKE $${params.length})
    )`);
  }
  const { rows } = await pool.query(`SELECT * FROM appointments WHERE ${conditions.join(' AND ')} ORDER BY start_at DESC`, params);
  return rows.map(mapAppointment);
}

export async function listAppointmentsByFilters(input: {
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
  const params: unknown[] = [];
  const conditions: string[] = ['1=1'];
  if (input.store_id?.trim()) { params.push(input.store_id.trim()); conditions.push(`a.store_id = $${params.length}`); }
  if (input.staff_id?.trim()) { params.push(input.staff_id.trim()); conditions.push(`a.staff_id = $${params.length}`); }
  if (input.service_id?.trim()) { params.push(input.service_id.trim()); conditions.push(`a.service_id = $${params.length}`); }
  if (input.service_name?.trim()) { params.push(`%${input.service_name.trim()}%`); conditions.push(`sv.name ILIKE $${params.length}`); }
  if (input.from_date?.trim()) { params.push(input.from_date.trim()); conditions.push(`a.start_at >= $${params.length}`); }
  if (input.to_date?.trim()) { params.push(input.to_date.trim()); conditions.push(`a.start_at <= $${params.length}`); }
  if (input.status) { params.push(input.status); conditions.push(`a.status = $${params.length}`); }
  if (input.keyword?.trim()) { params.push(`%${input.keyword.trim()}%`); conditions.push(`(a.customer_name ILIKE $${params.length} OR a.customer_phone ILIKE $${params.length} OR a.appointment_code ILIKE $${params.length} OR sv.name ILIKE $${params.length} OR s.name ILIKE $${params.length})`); }
  const limit = toPagination(input.limit ?? 20);
  const offset = Math.max(0, Number(input.offset ?? 0));
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT a.*, s.name AS staff_name, sv.name AS service_name, st.name AS store_name
     FROM appointments a
     JOIN staff s ON s.id = a.staff_id
     JOIN services sv ON sv.id = a.service_id
     JOIN stores st ON st.id = a.store_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.start_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    appointment: mapAppointment(row),
    staff_name: row.staff_name as string,
    service_name: row.service_name as string,
    store_name: row.store_name as string,
  }));
}

export async function listStaffSchedules(staffId: string, dateFrom: string, dateTo: string) {
  const { rows } = await pool.query(
    `SELECT *
     FROM staff_schedules
     WHERE staff_id = $1
       AND start_at < $3
       AND end_at > $2
     ORDER BY start_at ASC`,
    [staffId, dateFrom, dateTo],
  );
  return rows.map(mapSchedule);
}

export async function listBusyAppointments(staffId: string, startAt: string, endAt: string) {
  const { rows } = await pool.query(
    `SELECT * FROM appointments
     WHERE staff_id = $1
       AND status IN ('pending', 'confirmed', 'checked_in')
       AND tstzrange(start_at, end_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
     ORDER BY start_at ASC`,
    [staffId, startAt, endAt],
  );
  return rows.map(mapAppointment);
}

export async function listStaffSkillsForService(serviceId: string, storeId?: string) {
  const params: unknown[] = [serviceId];
  const conditions: string[] = ['sk.service_id = $1'];
  if (storeId?.trim()) {
    params.push(storeId.trim());
    conditions.push(`s.store_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT s.*
     FROM staff s
     JOIN staff_service_skills sk ON sk.staff_id = s.id
     WHERE ${conditions.join(' AND ')}
       AND s.is_active = true
     ORDER BY s.name ASC`,
    params,
  );
  return rows.map(mapStaff);
}

export async function searchAvailableTimeSlots(serviceId: string, storeId: string | undefined, date: string, preferredStaffId?: string): Promise<TimeSlot[]> {
  const service = await getService(serviceId);
  if (!service) return [];

  const dateStart = new Date(`${date}T00:00:00+08:00`).toISOString();
  const dateEnd = new Date(`${date}T23:59:59+08:00`).toISOString();

  const staffList = preferredStaffId ? [await getStaff(preferredStaffId)].filter(Boolean) as Staff[] : await listStaffSkillsForService(serviceId, storeId);
  const slots: TimeSlot[] = [];

  for (const staff of staffList) {
    const schedules = await listStaffSchedules(staff.id, dateStart, dateEnd);
    for (const schedule of schedules) {
      if (schedule.status !== 'available') continue;
      const busy = await listBusyAppointments(staff.id, schedule.start_at, schedule.end_at);
      const cursor = new Date(schedule.start_at).getTime();
      const end = new Date(schedule.end_at).getTime();
      const step = Math.max(service.duration_minutes, 30) * 60_000;
      for (let current = cursor; current + service.duration_minutes * 60_000 <= end; current += step) {
        const startAt = new Date(current).toISOString();
        const slotEnd = new Date(current + service.duration_minutes * 60_000).toISOString();
        const overlaps = busy.some((appointment) =>
          new Date(appointment.start_at).getTime() < new Date(slotEnd).getTime() &&
          new Date(appointment.end_at).getTime() > new Date(startAt).getTime(),
        );
        if (!overlaps) {
          slots.push({ staff_id: staff.id, staff_name: staff.name, start_at: startAt, end_at: slotEnd });
        }
      }
    }
  }

  return slots;
}

export async function listAuditsByAppointment(appointmentId: string) {
  const { rows } = await pool.query('SELECT * FROM appointment_audits WHERE appointment_id = $1 ORDER BY created_at DESC', [appointmentId]);
  return rows.map(mapAudit);
}

export async function countAppointmentOverview(input: {
  from_date?: string;
  to_date?: string;
  store_id?: string;
}) {
  const params: unknown[] = [];
  const conditions: string[] = ['1=1'];
  if (input.store_id?.trim()) { params.push(input.store_id.trim()); conditions.push(`store_id = $${params.length}`); }
  if (input.from_date?.trim()) { params.push(input.from_date.trim()); conditions.push(`start_at >= $${params.length}`); }
  if (input.to_date?.trim()) { params.push(input.to_date.trim()); conditions.push(`start_at <= $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
       COUNT(*) FILTER (WHERE status = 'checked_in')::int AS checked_in,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
       COUNT(*) FILTER (WHERE status = 'no_show')::int AS no_show
     FROM appointments
     WHERE ${conditions.join(' AND ')}`,
    params,
  );
  return rows[0] as { total: number; confirmed: number; checked_in: number; completed: number; cancelled: number; no_show: number };
}
