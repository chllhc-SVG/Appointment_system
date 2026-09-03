import { pool } from '../db/pool.js';

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
    if (input.service_ids) await replaceSkills(client, id, input.service_ids);
    await client.query('COMMIT');
    await writeEntityAudit({ entity_type: 'staff', entity_id: id, action: input.is_active === false ? 'deactivate' : 'update', operator: input.operator, before_data: before, after_data: updated.rows[0] });
    return updated.rows[0];
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
  // 软删除：停用，保留历史预约归属
  const updated = await pool.query(`UPDATE staff SET is_active = false, updated_at = now() WHERE id = $1 RETURNING *`, [id]);
  await writeEntityAudit({ entity_type: 'staff', entity_id: id, action: 'delete', operator, before_data: current.rows[0], after_data: updated.rows[0] });
  return updated.rows[0];
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

/** 服务（手工维护；可预约性由知识库同步决定） */
export async function createService(input: {
  name: string;
  duration_minutes: number;
  price_cents?: number;
  operator?: string;
}) {
  const name = input.name.trim();
  if (!name) throw new Error('name is required');
  const duration = Math.max(1, Number(input.duration_minutes) || 60);
  const inserted = await pool.query(
    `INSERT INTO services (name, duration_minutes, price_cents, source_system, sync_status)
     VALUES ($1, $2, $3, 'manual', 'local') RETURNING *`,
    [name, duration, input.price_cents ?? null],
  );
  await writeEntityAudit({ entity_type: 'service', entity_id: inserted.rows[0].id, action: 'create', operator: input.operator, after_data: inserted.rows[0] });
  return inserted.rows[0];
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
  await writeEntityAudit({ entity_type: 'service', entity_id: id, action: input.is_active === false ? 'deactivate' : 'update', operator: input.operator, before_data: before, after_data: updated.rows[0] });
  return updated.rows[0];
}

export async function deleteService(id: string, operator?: string) {
  const current = await pool.query('SELECT * FROM services WHERE id = $1 LIMIT 1', [id]);
  if (!current.rows[0]) return null;
  const updated = await pool.query(`UPDATE services SET is_active = false, updated_at = now() WHERE id = $1 RETURNING *`, [id]);
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