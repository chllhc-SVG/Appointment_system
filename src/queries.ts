import { pool } from './db/pool.js';
import { formatBeijing } from './utils.js';
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
  const params: unknown[] = [];
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
  const conditions: string[] = ['a.customer_id = $1'];
  const params: unknown[] = [customerId];
  if (fromDate) { params.push(fromDate); conditions.push(`a.start_at >= $${params.length}`); }
  if (toDate) { params.push(toDate); conditions.push(`a.start_at <= $${params.length}`); }
  if (status) { params.push(status); conditions.push(`a.status = $${params.length}`); }
  if (serviceName?.trim()) {
    params.push(`%${serviceName.trim()}%`);
    conditions.push(`EXISTS (SELECT 1 FROM services sv WHERE sv.id = a.service_id AND sv.name ILIKE $${params.length})`);
  }
  if (keyword?.trim()) {
    params.push(`%${keyword.trim()}%`);
    conditions.push(`(
      a.appointment_code ILIKE $${params.length}
      OR EXISTS (SELECT 1 FROM services sv2 WHERE sv2.id = a.service_id AND sv2.name ILIKE $${params.length})
      OR EXISTS (SELECT 1 FROM staff sf WHERE sf.id = a.staff_id AND sf.name ILIKE $${params.length})
    )`);
  }
  // 关联服务/员工/门店：数字人对话与日志中心能直接展示项目名、员工名、门店名，而不是只有 id
  const { rows } = await pool.query(
    `SELECT a.*, sv.name AS service_name, st.name AS staff_name, st2.name AS store_name
     FROM appointments a
     LEFT JOIN services sv ON sv.id = a.service_id
     LEFT JOIN staff st ON st.id = a.staff_id
     LEFT JOIN stores st2 ON st2.id = a.store_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.start_at DESC`,
    params,
  );
  return rows.map((row) => ({
    ...mapAppointment(row),
    service_name: (row.service_name as string) ?? null,
    staff_name: (row.staff_name as string) ?? null,
    store_name: (row.store_name as string) ?? null,
  }));
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
    `SELECT a.*,
            COALESCE(s.name, '')  AS staff_name,
            COALESCE(sv.name, '') AS service_name,
            COALESCE(st.name, '') AS store_name
     FROM appointments a
     LEFT JOIN staff s    ON s.id  = a.staff_id
     LEFT JOIN services sv ON sv.id = a.service_id
     LEFT JOIN stores st  ON st.id = a.store_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.created_at DESC, a.start_at DESC
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

/** 按名称模糊匹配门店（数字人用户直接说"上海徐汇门店"即可解析），多命中取第一个 */
export async function findStoreByName(name: string) {
  const { rows } = await pool.query(
    `SELECT
       st.*,
       COALESCE(array_agg(ss.service_id) FILTER (WHERE ss.service_id IS NOT NULL), '{}') AS service_ids
     FROM stores st
     LEFT JOIN store_services ss ON ss.store_id = st.id
     WHERE st.is_active = true AND st.name ILIKE $1
     GROUP BY st.id
     ORDER BY st.name ASC
     LIMIT 1`,
    [`%${name.trim()}%`],
  );
  return rows[0] ? mapStore(rows[0]) : undefined;
}

/** 门店名规一化：去空白/括号/引号并小写，用于稳健比对 */
const normalizeStoreName = (value: string) =>
  value.replace(/\s+/g, '').replace(/[（）()【】\[\]「」『』]/g, '').toLowerCase();

/**
 * 剥离门店名里的对话噪音前缀/后缀（LLM 转述用户话术时常混入）：
 * "用户确认上海徐汇门店" → "上海徐汇门店"；"那就去上海徐汇门店吧" → "上海徐汇门店"。
 * 只剥对话动词/指代词，绝不剥地名（"上海"是门店名的一部分）。
 */
export const stripStoreNameNoise = (value: string): string => {
  let text = value.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = text
      .replace(/^(?:用户|顾客|客人|客户|他|她|我|我们)/, '')
      .replace(/^(?:已经|已|最终|最后|然后|接着|所以|那么|那|就说|说|讲|提到)?(?:确认|选定|选择|选了|挑选|挑了|确定|敲定|决定|定了|就选|就要|想要|想去|想约|要去|会去|选|定)/, '')
      .replace(/^(?:的话|就是|就|是|在|去|到|约|来)/, '')
      .replace(/^(?:说|讲)/, '')
      .replace(/(?:吧|呗|哦|呢|了)+$/, '')
      .replace(/(?:。|，|,|；|;|！|!|？|\?|、)+$/g, '')
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
};

/**
 * 稳健门店解析（note 兜底回收与服务层解析共用）：
 *  1) 规一化精确匹配 → 2) 门店名包含文本（ILIKE 语义）→ 3) 反向包含：文本包含门店全名
 *     （"用户确认上海徐汇门店" 命中 "上海徐汇门店"）→ 4) 去「门店/店」后缀的模糊匹配
 *     （"徐汇店" 命中 "上海徐汇门店"）。
 * 仅在在营门店中匹配；同名多店时按名称稳定排序取第一。
 */
export async function findStoreByNameFlexible(text: string): Promise<Store | undefined> {
  const raw = stripStoreNameNoise(text);
  if (!raw) return undefined;
  const { rows } = await pool.query(
    `SELECT
       st.*,
       COALESCE(array_agg(ss.service_id) FILTER (WHERE ss.service_id IS NOT NULL), '{}') AS service_ids
     FROM stores st
     LEFT JOIN store_services ss ON ss.store_id = st.id
     WHERE st.is_active = true
     GROUP BY st.id
     ORDER BY st.name ASC, st.id ASC
     LIMIT 100`,
  );
  const stores = rows.map(mapStore);
  const nText = normalizeStoreName(raw);
  if (!nText) return undefined;
  const exact = stores.find((store) => normalizeStoreName(store.name) === nText);
  if (exact) return exact;
  const contains = stores.find((store) => normalizeStoreName(store.name).includes(nText));
  if (contains) return contains;
  const reverse = stores.find((store) => {
    const nName = normalizeStoreName(store.name);
    return nName.length >= 2 && nText.includes(nName);
  });
  if (reverse) return reverse;
  const bareText = nText.replace(/(门店|分店|店)$/u, '');
  if (bareText.length >= 2) {
    const fuzzy = stores.find((store) => {
      const bareName = normalizeStoreName(store.name).replace(/(门店|分店|店)$/u, '');
      return bareName.length >= 2 && (bareName.includes(bareText) || bareText.includes(bareName));
    });
    if (fuzzy) return fuzzy;
  }
  return undefined;
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

/** 批量查询多名员工的排班（一次查询替代 N+1），附员工名供日历/诊断直接展示 */
export async function listStaffSchedulesBulk(staffIds: string[], dateFrom: string, dateTo: string): Promise<(StaffSchedule & { staff_name: string })[]> {
  if (staffIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT sch.*, st.name AS staff_name
     FROM staff_schedules sch
     JOIN staff st ON st.id = sch.staff_id
     WHERE sch.staff_id = ANY($1)
       AND sch.start_at < $3
       AND sch.end_at > $2
     ORDER BY sch.start_at ASC`,
    [staffIds, dateFrom, dateTo],
  );
  return rows.map((row) => ({ ...mapSchedule(row), staff_name: row.staff_name as string }));
}

/** 批量查询多名员工在时间窗内的占用预约（一次查询替代 N+1） */
export async function listBusyAppointmentsBulk(staffIds: string[], startAt: string, endAt: string) {
  if (staffIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT * FROM appointments
     WHERE staff_id = ANY($1)
       AND status IN ('pending', 'confirmed', 'checked_in')
       AND tstzrange(start_at, end_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
     ORDER BY start_at ASC`,
    [staffIds, startAt, endAt],
  );
  return rows.map(mapAppointment);
}

/**
 * 统一的可约时段计算：员工排班 ∩（排除已占预约）。
 * 排班步长 = max(项目时长, 30min)，与预约重叠即排除该起点。
 */
export async function computeAvailableSlots(service: Service, staffList: Staff[], date: string): Promise<TimeSlot[]> {
  if (staffList.length === 0) return [];
  const dateStart = new Date(`${date}T00:00:00+08:00`).toISOString();
  const dateEnd = new Date(`${date}T23:59:59+08:00`).toISOString();
  const staffIds = staffList.map((staff) => staff.id);
  const [schedules, busy] = await Promise.all([
    listStaffSchedulesBulk(staffIds, dateStart, dateEnd),
    listBusyAppointmentsBulk(staffIds, dateStart, dateEnd),
  ]);
  const busyByStaff = new Map<string, Appointment[]>();
  for (const appointment of busy) {
    const list = busyByStaff.get(appointment.staff_id) ?? [];
    list.push(appointment);
    busyByStaff.set(appointment.staff_id, list);
  }
  const slots: TimeSlot[] = [];
  const stepMs = Math.max(service.duration_minutes, 30) * 60_000;
  const durationMs = service.duration_minutes * 60_000;
  for (const staff of staffList) {
    const busyForStaff = busyByStaff.get(staff.id) ?? [];
    for (const schedule of schedules.filter((item) => item.staff_id === staff.id)) {
      if (schedule.status !== 'available') continue;
      const cursor = new Date(schedule.start_at).getTime();
      const end = new Date(schedule.end_at).getTime();
      for (let current = cursor; current + durationMs <= end; current += stepMs) {
        const startAt = new Date(current).toISOString();
        const slotEnd = new Date(current + durationMs).toISOString();
        const overlaps = busyForStaff.some((appointment) =>
          new Date(appointment.start_at).getTime() < new Date(slotEnd).getTime() &&
          new Date(appointment.end_at).getTime() > new Date(startAt).getTime(),
        );
        if (!overlaps) {
          slots.push({
            staff_id: staff.id,
            staff_name: staff.name,
            start_at: startAt,
            end_at: slotEnd,
            start_local: formatBeijing(startAt),
            end_local: formatBeijing(slotEnd),
          });
        }
      }
    }
  }
  return slots;
}

/** 校验预约时段是否完整落在该员工一个 available 排班窗口内（"在相应的时间段有时间"的落库保证） */
export async function isWithinAvailableSchedule(staffId: string, startAt: string, endAt: string) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM staff_schedules
     WHERE staff_id = $1
       AND status = 'available'
       AND start_at <= $2::timestamptz
       AND end_at >= $3::timestamptz
     LIMIT 1`,
    [staffId, startAt, endAt],
  );
  return (rowCount ?? 0) > 0;
}

/** 查询某员工在日期范围内（含边界）的可用排班日期（YYYY-MM-DD，东八区），用于"最近可约日"建议 */
export async function listAvailableScheduleDates(staffIds: string[], dateFrom: string, dateTo: string): Promise<string[]> {
  if (staffIds.length === 0) return [];
  const fromIso = new Date(`${dateFrom}T00:00:00+08:00`).toISOString();
  const toIso = new Date(`${dateTo}T23:59:59+08:00`).toISOString();
  const { rows } = await pool.query(
    `SELECT DISTINCT to_char(start_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day
     FROM staff_schedules
     WHERE staff_id = ANY($1)
       AND status = 'available'
       AND start_at >= $2::timestamptz
       AND start_at < $3::timestamptz
     ORDER BY day ASC`,
    [staffIds, fromIso, toIso],
  );
  return rows.map((row) => row.day as string);
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
  const params: unknown[] = [];
  const conditions: string[] = ['sk.service_id = $1'];
  params.push(serviceId);
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

export async function searchAvailableTimeSlots(
  serviceId: string,
  storeId: string | undefined,
  date: string,
  preferredStaffId?: string,
  precomputed?: { service?: Service },
): Promise<TimeSlot[]> {
  // precomputed.service：上层 searchAvailableSlots 已解析过同 service_id，直接复用，
  // 省掉一次 DB 往返（同 id 同请求内结果一致，无状态漂移）。
  const service = precomputed?.service ?? await getService(serviceId);
  if (!service) return [];
  const staffList = preferredStaffId
    ? [await getStaff(preferredStaffId)].filter(Boolean) as Staff[]
    : await listStaffSkillsForService(serviceId, storeId);
  return computeAvailableSlots(service, staffList, date);
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
