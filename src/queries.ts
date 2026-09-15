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

/**
 * 进程内 TTL 缓存：只缓存"几乎不变"的基础资料（门店、项目名解析、员工技能），
 * 绝不缓存排班/占用/预约（那些每次必须查库，否则会双约）。
 * 写操作（catalog 增改停用、kb-sync 同步）统一调 invalidateReferenceCaches()，
 * 版本守卫防止"查询进行中发生了失效"导致旧结果写回。
 */
export const REF_CACHE_TTL_MS = 45_000;
let refCacheVersion = 0;

interface RefCacheEntry<T> { value: T; expiresAt: number; version: number }
const refCache = new Map<string, RefCacheEntry<unknown>>();

/** 清空全部基础资料缓存（门店/项目/员工技能共用），写操作后调用。 */
export function invalidateReferenceCaches() {
  refCacheVersion += 1;
  refCache.clear();
}

async function cachedQuery<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = refCache.get(key) as RefCacheEntry<T> | undefined;
  if (hit && hit.version === refCacheVersion && hit.expiresAt > Date.now()) return hit.value;
  const versionAtStart = refCacheVersion;
  const value = await run();
  if (versionAtStart === refCacheVersion) {
    refCache.set(key, { value, expiresAt: Date.now() + REF_CACHE_TTL_MS, version: refCacheVersion });
  }
  return value;
}

/** 在营门店全量（含 service_ids），门店名匹配与单店兜底共用一份缓存。 */
export async function fetchActiveStores(): Promise<Store[]> {
  return cachedQuery('stores:active', async () => {
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
    return rows.map(mapStore);
  });
}

export const ilikeLike = (pattern: string, value: string) => {
  // pattern 形如 "%武汉%"：转小写包含判断（与 ILIKE %kw% 等价语义），缓存路径内存过滤用
  const kw = pattern.replace(/^%|%$/g, '').toLowerCase();
  return value.toLowerCase().includes(kw);
};

export async function listStores(activeOnly = true, keyword?: string, limit = 20) {
  // 在营门店走缓存（数字人热路径）；带关键字时内存过滤同一份缓存（ILIKE %kw% 等价），
  // 其余组合保持原 SQL，行为不变。返回浅拷贝（service_ids 复制），防缓存被原地污染。
  if (activeOnly) {
    const all = await fetchActiveStores();
    const filtered = keyword?.trim()
      ? all.filter((s) => ilikeLike(`%${keyword.trim()}%`, s.name) || ilikeLike(`%${keyword.trim()}%`, s.timezone))
      : all;
    return filtered
      .slice(0, toPagination(limit))
      .map((s) => ({ ...s, service_ids: s.service_ids ? [...s.service_ids] : s.service_ids }));
  }
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

/** 在营且 id 已知的门店单查：先查缓存命中，未命中（停用/新增 45s 内）再走库兜底。 */
export async function getStore(id: string) {
  const cached = (await fetchActiveStores()).find((s) => s.id === id);
  if (cached) return { ...cached, service_ids: cached.service_ids ? [...cached.service_ids] : cached.service_ids };
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
  return cachedQuery(`service:id:${id}`, async () => {
    const { rows } = await pool.query('SELECT * FROM services WHERE id = $1 AND is_active = true LIMIT 1', [id]);
    return rows[0] ? mapService(rows[0]) : undefined;
  });
}

/** 按名称模糊匹配服务（数字人直接说"皮肤管理"即可解析），匹配多个时返回第一个。
 *  传入 storeId 时限定该店可做范围（store_services，旧数据无勾选时回退"店内在职员工可做项目"），
 *  避免数字人约到该店未开通的项目。
 *  名称+门店的组合键缓存：项目几天才变一次，数字人每次 query_slots 都要解析一次。 */
export async function findServiceByName(name: string, storeId?: string) {
  const cacheKey = `service:name:${name.trim().toLowerCase()}|store:${storeId?.trim() ?? ''}`;
  return cachedQuery(cacheKey, async () => {
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
  });
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
  return cachedQuery(`staff:id:${id}`, async () => {
    const { rows } = await pool.query('SELECT * FROM staff WHERE id = $1 AND is_active = true LIMIT 1', [id]);
    return rows[0] ? mapStaff(rows[0]) : undefined;
  });
}

export async function getAppointment(id: string) {
  const { rows } = await pool.query('SELECT * FROM appointments WHERE id = $1 LIMIT 1', [id]);
  return rows[0] ? mapAppointment(rows[0]) : undefined;
}

export async function getAppointmentByCode(code: string) {
  const { rows } = await pool.query('SELECT * FROM appointments WHERE appointment_code = $1 LIMIT 1', [code]);
  return rows[0] ? mapAppointment(rows[0]) : undefined;
}

/** 顾客「人」作用域：姓名+手机号成对（双重校验通过后使用）。
 *  同一真人建档前以 guest customer_id 落的历史单，姓名+手机号一致 → 应能查到；
 *  仅手机号相同但姓名不同（家人共用号码）→ 不算同一人，必须排除。 */
export type PersonScope = { name: string; phone: string };

/** 手机号存储形态兼容：预约单可能落原文（LLM 传）也可能落掩码（档案补齐），两种都算同号 */
const phoneVariants = (phone: string): string[] => {
  const raw = phone.trim();
  const digits = raw.replace(/\D/g, '');
  const masked = digits.length >= 7 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : raw;
  return [...new Set([raw, masked].filter(Boolean))];
};

/** SQL 片段：a 表上「姓名+手机号」成对命中（两向包含兼容"王女士/王小姐"称呼差异） */
const pushPersonPairCondition = (params: unknown[], person: PersonScope): string => {
  params.push(person.name.trim());
  const nameIdx = params.length;
  params.push(phoneVariants(person.phone));
  const phoneIdx = params.length;
  return `(
    btrim(COALESCE(a.customer_name, '')) <> ''
    AND a.customer_phone = ANY($${phoneIdx}::text[])
    AND (
      lower(btrim(a.customer_name)) = lower($${nameIdx})
      OR lower(btrim(a.customer_name)) LIKE '%' || lower($${nameIdx}) || '%'
      OR lower($${nameIdx}) LIKE '%' || lower(btrim(a.customer_name)) || '%'
    )
  )`;
};

/** 行级等价判定（详情/审计在内存里比对单条记录时用） */
export const appointmentMatchesPerson = (appointment: { customer_name?: string | null; customer_phone?: string | null }, person?: PersonScope) => {
  if (!person?.name?.trim() || !person?.phone?.trim()) return false;
  const name = String(appointment.customer_name ?? '').trim();
  const phone = String(appointment.customer_phone ?? '').trim();
  if (!name || !phone) return false;
  const nameOk = name === person.name || name.includes(person.name) || person.name.includes(name);
  return nameOk && phoneVariants(person.phone).includes(phone);
};

export async function getAppointmentDetailByCustomer(customerId: string, appointmentId?: string, appointmentCode?: string, person?: PersonScope) {
  const appointment = appointmentId
    ? await getAppointment(appointmentId)
    : appointmentCode
      ? await getAppointmentByCode(appointmentCode)
      : undefined;
  if (!appointment) return undefined;
  // 归属：档案 id 命中，或「姓名+手机号」成对命中（建档前的 guest 单同属本人）
  if (appointment.customer_id !== customerId && !appointmentMatchesPerson(appointment, person)) return undefined;
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
  person?: PersonScope,
) {
  // 可选过滤条件（两段 UNION 查询共用同一拼接，保证语义与原单查询一致）
  const extra = {
    conditions: [] as string[],
    params: [] as unknown[],
  };
  if (fromDate) { extra.params.push(fromDate); extra.conditions.push(`a.start_at >= $X`); }
  if (toDate) { extra.params.push(toDate); extra.conditions.push(`a.start_at <= $X`); }
  if (status) { extra.params.push(status); extra.conditions.push(`a.status = $X`); }
  if (serviceName?.trim()) {
    extra.params.push(`%${serviceName.trim()}%`);
    extra.conditions.push(`EXISTS (SELECT 1 FROM services sv WHERE sv.id = a.service_id AND sv.name ILIKE $X)`);
  }
  if (keyword?.trim()) {
    extra.params.push(`%${keyword.trim()}%`);
    extra.conditions.push(`(
      a.appointment_code ILIKE $X
      OR EXISTS (SELECT 1 FROM services sv2 WHERE sv2.id = a.service_id AND sv2.name ILIKE $X)
      OR EXISTS (SELECT 1 FROM staff sf WHERE sf.id = a.staff_id AND sf.name ILIKE $X)
    )`);
  }
  const joinSelect = `
    SELECT a.*, sv.name AS service_name, st.name AS staff_name, st2.name AS store_name
     FROM appointments a
     LEFT JOIN services sv ON sv.id = a.service_id
     LEFT JOIN staff st ON st.id = a.staff_id
     LEFT JOIN stores st2 ON st2.id = a.store_id`;
  const buildSegment = (base: string, baseParams: unknown[], startIndex: number) => {
    const segments: string[] = [base];
    let index = startIndex;
    for (const template of extra.conditions) {
      // ILIKE 模板里 $X 可能出现多次：同一模板内的占位符复用同一参数编号
      const placeholders = (template.match(/\$X/g) ?? []).length;
      let rendered = template;
      for (let i = 0; i < placeholders; i += 1) rendered = rendered.replace('$X', `$${index}`);
      segments.push(rendered);
      index += 1;
    }
    return { where: segments.join(' AND '), params: [...baseParams, ...extra.params], nextIndex: index };
  };

  // 无 person：维持原单查询（customer_id 索引直达），行为与之前逐字一致
  if (!person?.name || !person?.phone) {
    const seg = buildSegment(`a.customer_id = $1`, [customerId], 2);
    const { rows } = await pool.query(
      `${joinSelect} WHERE ${seg.where} ORDER BY a.start_at DESC`,
      seg.params,
    );
    return rows.map((row) => ({
      ...mapAppointment(row),
      service_name: (row.service_name as string) ?? null,
      staff_name: (row.staff_name as string) ?? null,
      store_name: (row.store_name as string) ?? null,
    }));
  }

  // 有 person：两段 UNION ALL 各走各的索引（customer_id 段 + 姓名电话段），内存按 id 去重后排序。
  // 等价于原 `(a.customer_id = $1 OR 姓名电话命中)`，只是避免 OR 让 customer_id 索引失效。
  // 手机号相同不再等于同一人——姓名必须同时匹配（pushPersonPairCondition 内保证）。
  const segId = buildSegment(`a.customer_id = $1`, [customerId], 2);
  const personParams: unknown[] = [];
  const pairCondition = pushPersonPairCondition(personParams, person);
  const segPerson = buildSegment(pairCondition, personParams, 1);
  const shiftPlaceholders = (where: string, offset: number) =>
    where.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
  const personWhere = shiftPlaceholders(segPerson.where, segId.params.length);
  const { rows } = await pool.query(
    `${joinSelect} WHERE ${segId.where}
     UNION ALL
     ${joinSelect} WHERE ${personWhere}
     ORDER BY start_at DESC`,
    [...segId.params, ...segPerson.params],
  );
  const seen = new Set<string>();
  const deduped = rows.filter((row) => {
    const id = String((row as Record<string, unknown>).id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  // 关联服务/员工/门店：数字人对话与日志中心能直接展示项目名、员工名、门店名，而不是只有 id
  return deduped.map((row) => ({
    ...mapAppointment(row),
    service_name: (row.service_name as string) ?? null,
    staff_name: (row.staff_name as string) ?? null,
    store_name: (row.store_name as string) ?? null,
  }));
}

export async function listAppointmentsByFilters(input: {
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
  const params: unknown[] = [];
  const conditions: string[] = ['1=1'];
  // 共享终端「查我的预约」被 LLM 路由到 list 时，必须按人过滤，否则退化成全量列表
  // （线上问题：骨架识别会话查出 3 条，含同手机号下别的档案 2 条）。
  // 管理后台 REST 不传这些字段，行为保持原样（全量 + keyword 搜索）。
  if (input.customer_id?.trim()) { params.push(input.customer_id.trim()); conditions.push(`a.customer_id = $${params.length}`); }
  if (input.customer_name?.trim() && input.customer_phone?.trim()) {
    conditions.push(pushPersonPairCondition(params, { name: input.customer_name, phone: input.customer_phone }));
  }
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
 *
 * 性能：门店缓存走统一 refCache（fetchActiveStores），匹配逻辑逐字不变，
 * 排班/库存/幂等不受影响。
 */
/** @deprecated 统一走 invalidateReferenceCaches()，保留供旧调用兼容 */
export function invalidateStoreCache() {
  invalidateReferenceCaches();
}

export async function findStoreByNameFlexible(text: string): Promise<Store | undefined> {
  const raw = stripStoreNameNoise(text);
  if (!raw) return undefined;
  const stores = await fetchActiveStores();
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
  return cachedQuery(`skills:${serviceId}|${storeId?.trim() ?? ''}`, async () => {
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
  });
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
