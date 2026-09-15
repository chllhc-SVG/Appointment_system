import { pool } from '../db/pool.js';
import { invalidateReferenceCaches, listStaff, listStaffSchedulesBulk } from '../queries.js';

export type EntityType = 'store' | 'staff' | 'service';

/** 基础资料审计：门店 / 员工 / 服务 的任何管理动作都留痕。 */
export async function writeEntityAudit(input: {
  entity_type: EntityType;
  entity_id: string;
  action: string;
  operator?: string;
  before_data?: unknown;
  after_data?: unknown;
}) {
  try {
    await pool.query(
      `INSERT INTO entity_audits (entity_type, entity_id, action, operator, before_data, after_data)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [
        input.entity_type,
        input.entity_id,
        input.action,
        input.operator ?? null,
        input.before_data === undefined ? null : safeJson(input.before_data),
        input.after_data === undefined ? null : safeJson(input.after_data),
      ],
    );
  } catch (error) {
    console.error('[catalog] failed to write entity audit', error);
  }
}

const safeJson = (value: unknown) => JSON.stringify(value ?? null);

/** 门店 */
export async function createStore(input: { name: string; timezone?: string; service_ids?: string[]; operator?: string }) {
  const name = input.name.trim();
  if (!name) throw new Error('name is required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO stores (name, timezone) VALUES ($1, $2) RETURNING *`,
      [name, input.timezone?.trim() || 'Asia/Shanghai'],
    );
    const store = inserted.rows[0];
    await setStoreServices(client, store.id, input.service_ids ?? []);
    await client.query('COMMIT');
    invalidateReferenceCaches();
    store.service_ids = input.service_ids ?? [];
    await writeEntityAudit({ entity_type: 'store', entity_id: store.id, action: 'create', operator: input.operator, after_data: store });
    return store;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateStore(id: string, input: { name?: string; timezone?: string; is_active?: boolean; service_ids?: string[]; operator?: string }) {
  const current = await pool.query('SELECT * FROM stores WHERE id = $1 LIMIT 1', [id]);
  if (!current.rows[0]) return null;
  const before = current.rows[0];
  const name = input.name?.trim() || before.name;
  const timezone = input.timezone?.trim() || before.timezone;
  const isActive = input.is_active ?? before.is_active;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE stores SET name = $2, timezone = $3, is_active = $4, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, name, timezone, isActive],
    );
    let serviceIds = before.service_ids as string[] | undefined;
    if (input.service_ids) {
      await setStoreServices(client, id, input.service_ids);
      serviceIds = input.service_ids;
    }
    await client.query('COMMIT');
    const store = updated.rows[0];
    store.service_ids = serviceIds ?? [];
    invalidateReferenceCaches();
    await writeEntityAudit({ entity_type: 'store', entity_id: id, action: isActive ? 'update' : 'deactivate', operator: input.operator, before_data: before, after_data: store });
    return store;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteStore(id: string, operator?: string) {
  const current = await pool.query('SELECT * FROM stores WHERE id = $1 LIMIT 1', [id]);
  if (!current.rows[0]) return null;
  const before = current.rows[0];
  // 软删除：停用而非物理删除，避免破坏历史预约外键（store_services 由 ON DELETE CASCADE 清理）
  const updated = await pool.query(`UPDATE stores SET is_active = false, updated_at = now() WHERE id = $1 RETURNING *`, [id]);
  invalidateReferenceCaches();
  await writeEntityAudit({ entity_type: 'store', entity_id: id, action: 'delete', operator, before_data: before, after_data: updated.rows[0] });
  return updated.rows[0];
}

async function setStoreServices(client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }, storeId: string, serviceIds: string[]) {
  await client.query('DELETE FROM store_services WHERE store_id = $1', [storeId]);
  for (const serviceId of serviceIds) {
    await client.query(
      `INSERT INTO store_services (store_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [storeId, serviceId],
    );
  }
}

/** 校验员工技能必须属于所属门店可做范围（门店未配置时跳过，兼容旧数据）。 */
async function assertStaffSkillsInStore(storeId: string, serviceIds: string[]) {
  if (serviceIds.length === 0) return;
  const { rows } = await pool.query(
    `SELECT service_id FROM store_services WHERE store_id = $1`,
    [storeId],
  );
  if (rows.length === 0) return;
  const allowed = new Set(rows.map((row) => row.service_id as string));
  const denied = serviceIds.filter((id) => !allowed.has(id));
  if (denied.length > 0) {
    const names = await pool.query(
      `SELECT id, name FROM services WHERE id = ANY($1)`,
      [denied],
    );
    const nameMap = new Map(names.rows.map((row) => [row.id as string, row.name as string]));
    const labels = denied.map((id) => nameMap.get(id) ?? id).join('、');
    throw new Error(`员工可服务项目必须属于所属门店可做范围，超出范围：${labels}`);
  }
}

async function replaceSkills(client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }, staffId: string, serviceIds: string[]) {
  await client.query('DELETE FROM staff_service_skills WHERE staff_id = $1', [staffId]);
  for (const serviceId of serviceIds) {
    await client.query(
      `INSERT INTO staff_service_skills (staff_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [staffId, serviceId],
    );
  }
}

/** 员工（含技能绑定） */
export async function createStaff(input: { store_id: string; name: string; service_ids?: string[]; operator?: string }) {
  const name = input.name.trim();
  if (!name) throw new Error('name is required');
  const store = await pool.query('SELECT id FROM stores WHERE id = $1 LIMIT 1', [input.store_id]);
  if (!store.rows[0]) throw new Error('store not found');
  await assertStaffSkillsInStore(input.store_id, input.service_ids ?? []);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO staff (store_id, name) VALUES ($1, $2) RETURNING *`,
      [input.store_id, name],
    );
    const staff = inserted.rows[0];
    await replaceSkills(client, staff.id, input.service_ids ?? []);
    await client.query('COMMIT');
    invalidateReferenceCaches();
    await writeEntityAudit({ entity_type: 'staff', entity_id: staff.id, action: 'create', operator: input.operator, after_data: { staff, service_ids: input.service_ids ?? [] } });
    return staff;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateStaff(id: string, input: { store_id?: string; name?: string; is_active?: boolean; service_ids?: string[]; operator?: string }) {
  const current = await pool.query('SELECT * FROM staff WHERE id = $1 LIMIT 1', [id]);
  if (!current.rows[0]) return null;
  const before = current.rows[0];
  const storeId = input.store_id?.trim() || before.store_id;
  const name = input.name?.trim() || before.name;
  const isActive = input.is_active ?? before.is_active;
  if (input.store_id?.trim()) {
    const store = await pool.query('SELECT id FROM stores WHERE id = $1 LIMIT 1', [storeId]);
    if (!store.rows[0]) throw new Error('store not found');
  }
  if (input.service_ids) await assertStaffSkillsInStore(storeId, input.service_ids);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE staff SET store_id = $2, name = $3, is_active = $4, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, storeId, name, isActive],
    );
    let serviceIds = input.service_ids ? [...input.service_ids] : undefined;
    if (input.service_ids) {
      await replaceSkills(client, id, input.service_ids);
    }
    await client.query('COMMIT');
    const staff = updated.rows[0];
    invalidateReferenceCaches();
    await writeEntityAudit({ entity_type: 'staff', entity_id: id, action: isActive ? 'update' : 'deactivate', operator: input.operator, before_data: before, after_data: { staff, service_ids: serviceIds ?? before.service_ids ?? [] } });
    return staff;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteStaff(id: string, operator?: string) {
  const current = await pool.query('SELECT * FROM staff WHERE id = $1 LIMIT 1', [id]);
  if (!current.rows[0]) return null;
  const updated = await pool.query(`UPDATE staff SET is_active = false, updated_at = now() WHERE id = $1 RETURNING *`, [id]);
  invalidateReferenceCaches();
  await writeEntityAudit({ entity_type: 'staff', entity_id: id, action: 'delete', operator, before_data: current.rows[0], after_data: updated.rows[0] });
  return updated.rows[0];
}

/** 服务项目 */
export async function createService(input: {
  name: string;
  duration_minutes: number;
  price_cents?: number;
  category?: string;
  aliases?: string[];
  operator?: string;
}) {
  const name = input.name.trim();
  if (!name) throw new Error('name is required');
  const duration = Math.max(1, Number(input.duration_minutes) || 0);
  if (!duration) throw new Error('duration_minutes is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO services (name, duration_minutes, price_cents, category, aliases) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, duration, input.price_cents ?? null, input.category ?? null, input.aliases ?? []],
    );
    await client.query('COMMIT');
    invalidateReferenceCaches();
    await writeEntityAudit({ entity_type: 'service', entity_id: inserted.rows[0].id, action: 'create', operator: input.operator, after_data: inserted.rows[0] });
    return inserted.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateService(id: string, input: { name?: string; duration_minutes?: number; price_cents?: number; is_active?: boolean; operator?: string }) {
  const current = await pool.query('SELECT * FROM services WHERE id = $1 LIMIT 1', [id]);
  if (!current.rows[0]) return null;
  const before = current.rows[0];
  const name = input.name?.trim() || before.name;
  const duration = input.duration_minutes !== undefined ? Math.max(1, Number(input.duration_minutes) || before.duration_minutes) : before.duration_minutes;
  const price = input.price_cents !== undefined ? input.price_cents : before.price_cents;
  const isActive = input.is_active ?? before.is_active;
  const updated = await pool.query(
    `UPDATE services SET name = $2, duration_minutes = $3, price_cents = $4, is_active = $5, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, name, duration, price, isActive],
  );
  invalidateReferenceCaches();
  await writeEntityAudit({ entity_type: 'service', entity_id: id, action: input.is_active === false ? 'deactivate' : 'update', operator: input.operator, before_data: before, after_data: updated.rows[0] });
  return updated.rows[0];
}

export async function deleteService(id: string, operator?: string) {
  const current = await pool.query('SELECT * FROM services WHERE id = $1 LIMIT 1', [id]);
  if (!current.rows[0]) return null;
  const updated = await pool.query(`UPDATE services SET is_active = false, updated_at = now() WHERE id = $1 RETURNING *`, [id]);
  invalidateReferenceCaches();
  await writeEntityAudit({ entity_type: 'service', entity_id: id, action: 'delete', operator, before_data: current.rows[0], after_data: updated.rows[0] });
  return updated.rows[0];
}

/** 查询基础资料审计记录 */
export async function listEntityAudits(input: { entity_type?: EntityType; entity_id?: string; limit?: number; offset?: number }) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.entity_type) {
    params.push(input.entity_type);
    conditions.push(`entity_type = $${params.length}`);
  }
  if (input.entity_id) {
    params.push(input.entity_id);
    conditions.push(`entity_id = $${params.length}`);
  }
  const limit = Math.max(1, Math.min(Number(input.limit ?? 50), 200));
  const offset = Math.max(0, Number(input.offset ?? 0));
  params.push(limit, offset);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [list, count] = await Promise.all([
    pool.query(`SELECT * FROM entity_audits ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
    pool.query(`SELECT count(*)::int AS total FROM entity_audits ${where}`, params.slice(0, params.length - 2)),
  ]);
  return { items: list.rows, total: count.rows[0]?.total ?? 0, limit, offset };
}

export async function listStaffSchedulesForStaff(staffId?: string) {
  const { rows } = await pool.query(
    `SELECT * FROM staff_schedules ${staffId ? 'WHERE staff_id = $1' : ''} ORDER BY staff_id ASC, start_at ASC`,
    staffId ? [staffId] : [],
  );
  return rows;
}

export async function createStaffSchedules(input: { staff_id: string; schedules: Array<{ start_at: string; end_at: string; status?: string }>; operator?: string }) {
  const staff = await pool.query('SELECT id, name FROM staff WHERE id = $1 LIMIT 1', [input.staff_id]);
  if (!staff.rows[0]) throw new Error('staff not found');
  const created: unknown[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of input.schedules) {
      const startAt = new Date(item.start_at).toISOString();
      const endAt = new Date(item.end_at).toISOString();
      // upsert：同一员工同一开始时间重复生成时覆盖，保证"一键排班"可反复执行
      const inserted = await client.query(
        `INSERT INTO staff_schedules (staff_id, start_at, end_at, status) VALUES ($1, $2, $3, $4)
         ON CONFLICT (staff_id, start_at) DO UPDATE SET end_at = EXCLUDED.end_at, status = EXCLUDED.status, updated_at = now()
         RETURNING *`,
        [input.staff_id, startAt, endAt, item.status ?? 'available'],
      );
      created.push(inserted.rows[0]);
    }
    await client.query('COMMIT');
    await writeEntityAudit({ entity_type: 'staff', entity_id: input.staff_id, action: 'sync', operator: input.operator, after_data: { schedules: created } });
    return created;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ===== 按天排班（日历式管理）：日期 + 门店 + 员工 定位，一天多班次 =====

const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 管理后台统一东八区；与 seed / slot 计算一致 */
const TZ_SUFFIX = '+08:00';

const toIso = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00${TZ_SUFFIX}`).toISOString();

/** 校验同一天内的班次：时间格式、先后顺序、互不重叠（允许 12:00 结束与 13:00 开始相邻） */
function validateShifts(shifts: Array<{ start: string; end: string; status?: string }>) {
  if (shifts.length === 0) throw new Error('该天至少需要一个班次');
  const normalized = shifts.map((shift) => {
    if (!TIME_HHMM.test(shift.start) || !TIME_HHMM.test(shift.end)) {
      throw new Error(`班次时间格式应为 HH:mm，收到：${shift.start} ~ ${shift.end}`);
    }
    const startMinutes = Number(shift.start.slice(0, 2)) * 60 + Number(shift.start.slice(3));
    const endMinutes = Number(shift.end.slice(0, 2)) * 60 + Number(shift.end.slice(3));
    if (endMinutes <= startMinutes) throw new Error(`班次结束必须晚于开始：${shift.start} ~ ${shift.end}`);
    const status = shift.status === 'unavailable' || shift.status === 'break' ? shift.status : 'available';
    return { start: shift.start, end: shift.end, status, startMinutes, endMinutes };
  });
  normalized.sort((a, b) => a.startMinutes - b.startMinutes);
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].startMinutes < normalized[i - 1].endMinutes) {
      throw new Error(`班次时间重叠：${normalized[i - 1].start}~${normalized[i - 1].end} 与 ${normalized[i].start}~${normalized[i].end}`);
    }
  }
  return normalized;
}

/** 员工必须属于该门店（防止日历上把班排到别家店的员工身上） */
async function assertStaffInStore(storeId: string, staffId: string) {
  const { rows } = await pool.query('SELECT id FROM staff WHERE id = $1 AND store_id = $2 LIMIT 1', [staffId, storeId]);
  if (!rows[0]) throw new Error('员工不存在或不属于该门店');
}

/** 建立或覆盖某员工某天的全部班次；shifts 为空数组时等价于清空（删除）该天全部班次。
 *  返回 { schedules, affected_appointments }：affected 为保存后不再被任何班次覆盖的有效预约，
 *  UI 据此提示"这些预约已悬空，请处理"，由管理者决定是否取消/改期。 */
export async function upsertDaySchedules(input: { store_id: string; staff_id: string; date: string; shifts: Array<{ start: string; end: string; status?: string }>; operator?: string }) {
  assertNonEmptyDate(input.date);
  await assertStaffInStore(input.store_id, input.staff_id);
  if (input.shifts.length === 0) {
    const result = await deleteDaySchedules({ store_id: input.store_id, staff_id: input.staff_id, date: input.date, operator: input.operator });
    return { schedules: result.deleted, affected_appointments: result.affected_appointments };
  }
  const shifts = validateShifts(input.shifts);
  const dayStartIso = `${input.date}T00:00:00${TZ_SUFFIX}`;
  const dayEndIso = `${input.date}T23:59:59${TZ_SUFFIX}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 覆盖式：先删该天旧班次再插入，UI 语义即"编辑某天"
    await client.query(
      `DELETE FROM staff_schedules
       WHERE staff_id = $1
         AND start_at >= $2::timestamptz AND start_at < $3::timestamptz`,
      [input.staff_id, dayStartIso, dayEndIso],
    );
    const created: unknown[] = [];
    for (const shift of shifts) {
      const inserted = await client.query(
        `INSERT INTO staff_schedules (staff_id, start_at, end_at, status)
         VALUES ($1, $2::timestamptz, $3::timestamptz, $4)
         ON CONFLICT (staff_id, start_at) DO UPDATE
           SET end_at = EXCLUDED.end_at, status = EXCLUDED.status, updated_at = now()
         RETURNING *`,
        [input.staff_id, toIso(input.date, shift.start), toIso(input.date, shift.end), shift.status],
      );
      created.push(inserted.rows[0]);
    }
    await client.query('COMMIT');
    // 保存后检查该天有效预约是否仍在（新）班次范围内，悬空的列出来提示
    const { rows: dayAppointments } = await pool.query(
      `SELECT id, appointment_code, start_at, end_at, customer_name FROM appointments
       WHERE staff_id = $1
         AND status IN ('pending', 'confirmed', 'checked_in')
         AND start_at >= $2::timestamptz AND start_at < $3::timestamptz`,
      [input.staff_id, dayStartIso, dayEndIso],
    );
    const affectedAppointments = dayAppointments.filter((row) => {
      const start = new Date(row.start_at as string).getTime();
      const end = new Date(row.end_at as string).getTime();
      return !created.some((schedule) => {
        const scheduleStart = new Date((schedule as { start_at: string }).start_at).getTime();
        const scheduleEnd = new Date((schedule as { end_at: string }).end_at).getTime();
        // 仅 available 班次可承接预约；break/unavailable 不算覆盖
        if ((schedule as { status: string }).status !== 'available') return false;
        return start >= scheduleStart && end <= scheduleEnd;
      });
    });
    await writeEntityAudit({
      entity_type: 'staff',
      entity_id: input.staff_id,
      action: 'schedule_upsert_day',
      operator: input.operator,
      after_data: { date: input.date, shifts, affected_appointments: affectedAppointments.map((row) => row.appointment_code) },
    });
    return { schedules: created, affected_appointments: affectedAppointments };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** 删除某员工某天的班次（全部或指定开始时间），供日历上点"删除" */
export async function deleteDaySchedules(input: { store_id: string; staff_id: string; date: string; start?: string; operator?: string }) {
  assertNonEmptyDate(input.date);
  await assertStaffInStore(input.store_id, input.staff_id);
  const params: unknown[] = [input.staff_id, `${input.date}T00:00:00${TZ_SUFFIX}`, `${input.date}T23:59:59${TZ_SUFFIX}`];
  let where = `staff_id = $1 AND start_at >= $2::timestamptz AND start_at < $3::timestamptz`;
  if (input.start?.trim()) {
    if (!TIME_HHMM.test(input.start.trim())) throw new Error(`start 格式应为 HH:mm，收到：${input.start}`);
    params.push(toIso(input.date, input.start.trim()));
    where += ` AND start_at = $${params.length}::timestamptz`;
  }
  const { rows } = await pool.query(`DELETE FROM staff_schedules WHERE ${where} RETURNING *`, params);
  // 删除后重查该天剩余班次，找出不再被任何班次覆盖的有效预约（悬空预约）
  const { rows: remaining } = await pool.query(
    `SELECT start_at, end_at FROM staff_schedules WHERE staff_id = $1 AND start_at >= $2::timestamptz AND start_at < $3::timestamptz`,
    params.slice(0, 3),
  );
  const { rows: dayAppointments } = await pool.query(
    `SELECT id, appointment_code, start_at, end_at, customer_name FROM appointments
     WHERE staff_id = $1
       AND status IN ('pending', 'confirmed', 'checked_in')
       AND start_at >= $2::timestamptz AND start_at < $3::timestamptz`,
    params.slice(0, 3),
  );
  const affected = dayAppointments.filter((row) => {
    const start = new Date(row.start_at as string).getTime();
    const end = new Date(row.end_at as string).getTime();
    return !remaining.some((schedule) => {
      const scheduleStart = new Date(schedule.start_at as string).getTime();
      const scheduleEnd = new Date(schedule.end_at as string).getTime();
      return start >= scheduleStart && end <= scheduleEnd;
    });
  });
  await writeEntityAudit({
    entity_type: 'staff',
    entity_id: input.staff_id,
    action: 'schedule_delete_day',
    operator: input.operator,
    before_data: { date: input.date, deleted: rows },
    after_data: { affected_appointments: affected.map((row) => row.appointment_code) },
  });
  return { deleted: rows, affected_appointments: affected };
}

/** 门店维度排班查询（日历按周/按月渲染，一次拉全店员工班次） */
export async function listStoreSchedules(input: { store_id: string; date_from: string; date_to: string; staff_id?: string }) {
  assertNonEmptyDate(input.date_from);
  assertNonEmptyDate(input.date_to);
  const staff = await listStaff(input.store_id, undefined, undefined, true, 100);
  const staffIds = (input.staff_id?.trim() ? staff.filter((item) => item.id === input.staff_id?.trim()) : staff).map((item) => item.id);
  const schedules = await listStaffSchedulesBulk(staffIds, `${input.date_from}T00:00:00+08:00`, `${input.date_to}T23:59:59+08:00`);
  return { staff, schedules };
}

function assertNonEmptyDate(value: string) {
  if (!value?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error(`日期格式应为 YYYY-MM-DD，收到：${value}`);
  }
}

/**
 * 排班变更前的"有效预约占用"检查：
 * 计算该员工在 dateFrom~dateTo 内的有效预约（pending/confirmed/checked_in），
 * 与给定的保留窗口比对，返回落在保留窗口之外的预约列表。
 * 供"删除班次/缩短班次"时判定是否需要先处理已有预约。
 */
export async function listSchedulesAffectedAppointments(input: {
  staff_id: string;
  date_from: string;
  date_to: string;
  /** 保留窗口列表（ISO 时间戳），预约落在其中任一窗口内即视为不受影响 */
  keepWindows?: Array<{ start_at: string; end_at: string }>;
}) {
  assertNonEmptyDate(input.date_from);
  assertNonEmptyDate(input.date_to);
  const { rows } = await pool.query(
    `SELECT * FROM appointments
     WHERE staff_id = $1
       AND status IN ('pending', 'confirmed', 'checked_in')
       AND start_at >= $2::timestamptz AND start_at < $3::timestamptz
     ORDER BY start_at ASC`,
    [input.staff_id, `${input.date_from}T00:00:00+08:00`, `${input.date_to}T23:59:59+08:00`],
  );
  const keep = input.keepWindows ?? [];
  return rows.filter((row) => {
    const start = new Date(row.start_at as string).getTime();
    const end = new Date(row.end_at as string).getTime();
    return !keep.some((window) => {
      const winStart = new Date(window.start_at).getTime();
      const winEnd = new Date(window.end_at).getTime();
      return start >= winStart && end <= winEnd;
    });
  });
}

/**
 * 周模板排班：把每周固定班（如"周一到周五 09:00-18:00"）批量铺到日期范围。
 * 只在【没有任何班次的日期】落班，不覆盖已有排班；已排班的天保留原样。
 */
export async function applyWeeklyScheduleTemplate(input: {
  store_id: string;
  staff_id: string;
  date_from: string;
  date_to: string;
  /** weekday: 1=周一 ... 7=周日（与 UI 一致） */
  weekdays: number[];
  shifts: Array<{ start: string; end: string; status?: string }>;
  operator?: string;
}) {
  assertNonEmptyDate(input.date_from);
  assertNonEmptyDate(input.date_to);
  await assertStaffInStore(input.store_id, input.staff_id);
  const weekdays = [...new Set(input.weekdays.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))];
  if (weekdays.length === 0) throw new Error('weekdays 至少选择一个（1=周一 ... 7=周日）');
  const shifts = validateShifts(input.shifts);

  const from = new Date(`${input.date_from}T00:00:00+08:00`);
  const to = new Date(`${input.date_to}T23:59:59+08:00`);
  if (to.getTime() < from.getTime()) throw new Error('date_to 不能早于 date_from');

  // 已有班次的日期跳过（一次查出该范围内全部班次，按天分组）
  const { rows: existing } = await pool.query(
    `SELECT DISTINCT to_char(start_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day
     FROM staff_schedules
     WHERE staff_id = $1 AND start_at >= $2::timestamptz AND start_at < $3::timestamptz`,
    [input.staff_id, `${input.date_from}T00:00:00+08:00`, `${input.date_to}T23:59:59+08:00`],
  );
  const daysWithSchedules = new Set(existing.map((row) => row.day as string));

  const applied: Array<{ date: string; shifts: number }> = [];
  const skipped: string[] = [];
  const cursor = new Date(from);
  while (cursor.getTime() <= to.getTime()) {
    // Date#getDay(): 0=周日；转为 1=周一 ... 7=周日
    const weekday = ((cursor.getDay() + 6) % 7) + 1;
    const date = cursor.toISOString().slice(0, 10);
    if (weekdays.includes(weekday) && !daysWithSchedules.has(date)) {
      await upsertDaySchedules({
        store_id: input.store_id,
        staff_id: input.staff_id,
        date,
        shifts: shifts.map((shift) => ({ start: shift.start, end: shift.end, status: shift.status })),
        operator: input.operator,
      });
      applied.push({ date, shifts: shifts.length });
    } else if (weekdays.includes(weekday)) {
      skipped.push(date);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  await writeEntityAudit({
    entity_type: 'staff',
    entity_id: input.staff_id,
    action: 'schedule_apply_weekly_template',
    operator: input.operator,
    after_data: { date_from: input.date_from, date_to: input.date_to, weekdays, shifts: shifts.length, applied, skipped_count: skipped.length },
  });
  return { applied, skipped };
}
