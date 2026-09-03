import { pool } from '../db/pool.js';
import { writeEntityAudit } from './catalog.js';

/**
 * 知识库（knowledge-platform）项目管理同步适配器。
 * 数据源：GET {KB_URL}/api/kb/projects?page=1&page_size=100 （Bearer ${KB_ADMIN_TOKEN}）
 * 约定：只有知识库项目管理中存在（且同步成功）的项目才允许被预约。
 */

const DEFAULT_KB_URL = process.env.KNOWLEDGE_BASE_URL ?? 'http://localhost:3001';
const DEFAULT_KB_TOKEN = process.env.KNOWLEDGE_BASE_ADMIN_TOKEN ?? 'dev-admin-token';

export interface KbProjectRow {
  id: string;
  project_name: string;
  aliases?: string[];
  project_category?: string | null;
  price?: string;
  duration?: string;
  description?: string;
  is_active?: boolean;
}

export interface SyncResult {
  source_system: 'knowledge_base';
  status: 'success' | 'partial' | 'failed';
  total: number;
  created: number;
  updated: number;
  deactivated: number;
  failed: number;
  message: string;
  errors: string[];
}

const parseDurationMinutes = (raw?: string): number | undefined => {
  if (!raw) return undefined;
  // 支持 "60"、"90分钟"、"1.5小时"、"120 分钟" 等
  const match = raw.trim().match(/(\d+(?:\.\d+)?)\s*(小时|hour|h|分钟|min)?/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = (match[2] ?? '').toLowerCase();
  if (unit === '小时' || unit === 'hour' || unit === 'h') return Math.round(value * 60);
  return Math.round(value);
};

const parsePriceCents = (raw?: string): number | undefined => {
  if (!raw) return undefined;
  const match = raw.trim().match(/(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 100);
};

const safeJson = (value: unknown) => JSON.stringify(value ?? null);

/** 分页拉取知识库全部在管项目。 */
async function fetchAllProjects(): Promise<KbProjectRow[]> {
  const pageSize = 100;
  const projects: KbProjectRow[] = [];
  for (let page = 1; page <= 1000; page++) {
    const url = `${DEFAULT_KB_URL}/api/kb/projects?page=${page}&page_size=${pageSize}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${DEFAULT_KB_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`知识库同步失败：GET ${url} → HTTP ${res.status}`);
    }
    const body = (await res.json()) as { items?: KbProjectRow[]; total?: number };
    const items = body.items ?? [];
    projects.push(...items);
    const total = Number(body.total ?? items.length);
    if (items.length === 0 || projects.length >= total) break;
  }
  return projects;
}

/** 执行一次同步：以知识库项目管理为主数据，upsert 到预约系统 services。 */
export async function syncServicesFromKnowledgeBase(options: { operator?: string } = {}): Promise<SyncResult> {
  const startedAt = new Date();
  const errors: string[] = [];
  let created = 0;
  let updated = 0;
  let deactivated = 0;
  let total = 0;

  const result: SyncResult = {
    source_system: 'knowledge_base',
    status: 'success',
    total: 0,
    created: 0,
    updated: 0,
    deactivated: 0,
    failed: 0,
    message: '',
    errors,
  };

  try {
    const projects = await fetchAllProjects();
    total = projects.length;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fetchedKeys = new Set<string>();

      for (const project of projects) {
        if (!project.id || !project.project_name) {
          errors.push(`跳过无效项目行（缺 id 或 project_name）`);
          continue;
        }
        fetchedKeys.add(project.id);
        const duration = parseDurationMinutes(project.duration);
        const price = parsePriceCents(project.price);
        const name = project.project_name.trim();
        const isActive = project.is_active !== false;

        const existing = await client.query(
          `SELECT id FROM services WHERE source_system = 'knowledge_base' AND source_key = $1 LIMIT 1`,
          [project.id],
        );

        if (existing.rows[0]) {
          await client.query(
            `UPDATE services
             SET name = $2, duration_minutes = $3, price_cents = $4, is_active = $5,
                 category = $6, aliases = $7, sync_status = 'synced', sync_error = NULL,
                 last_synced_at = now(), sync_payload = $8::jsonb, updated_at = now()
             WHERE id = $1`,
            [
              existing.rows[0].id,
              name,
              duration ?? 60,
              price ?? null,
              isActive,
              project.project_category?.trim() || null,
              project.aliases ?? [],
              safeJson(project),
            ],
          );
          await writeEntityAudit({
            entity_type: 'service',
            entity_id: existing.rows[0].id,
            action: isActive ? 'update' : 'deactivate',
            operator: options.operator ?? 'knowledge-base-sync',
            after_data: { source_key: project.id, sync: true },
          });
          updated += 1;
        } else {
          const inserted = await client.query(
            `INSERT INTO services (name, duration_minutes, price_cents, is_active, source_system, source_key, category, aliases, sync_status, last_synced_at, sync_payload)
             VALUES ($1, $2, $3, $4, 'knowledge_base', $5, $6, $7, 'synced', now(), $8::jsonb)
             RETURNING id`,
            [name, duration ?? 60, price ?? null, isActive, project.id, project.project_category?.trim() || null, project.aliases ?? [], safeJson(project)],
          );
          await writeEntityAudit({
            entity_type: 'service',
            entity_id: inserted.rows[0].id,
            action: 'create',
            operator: options.operator ?? 'knowledge-base-sync',
            after_data: { source_key: project.id, sync: true },
          });
          created += 1;
        }
      }

      // 知识库不再存在的已同步项目：停用（不物理删除，保留历史）
      const stale = await client.query(
        `SELECT id FROM services WHERE source_system = 'knowledge_base' AND sync_status = 'synced' AND source_key IS NOT NULL`,
      );
      for (const row of stale.rows as Array<{ id: string }>) {
        const key = await client.query(`SELECT source_key FROM services WHERE id = $1`, [row.id]);
        const sourceKey = key.rows[0]?.source_key as string | undefined;
        if (sourceKey && !fetchedKeys.has(sourceKey)) {
          await client.query(
            `UPDATE services SET is_active = false, sync_status = 'stale', updated_at = now() WHERE id = $1`,
            [row.id],
          );
          await writeEntityAudit({
            entity_type: 'service',
            entity_id: row.id,
            action: 'deactivate',
            operator: options.operator ?? 'knowledge-base-sync',
            after_data: { source_key: sourceKey, reason: 'removed-from-knowledge-base' },
          });
          deactivated += 1;
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    result.total = total;
    result.created = created;
    result.updated = updated;
    result.deactivated = deactivated;
    result.failed = errors.length;
    result.status = errors.length > 0 ? 'partial' : 'success';
    result.message = `同步完成：共 ${total} 个项目，新增 ${created}，更新 ${updated}，停用 ${deactivated}，失败 ${errors.length}`;
  } catch (error) {
    result.status = 'failed';
    result.message = `同步失败：${error instanceof Error ? error.message : String(error)}`;
    errors.push(result.message);
    result.failed = 1;
  } finally {
    await pool.query(
      `INSERT INTO sync_runs (source_system, status, total, created, updated, deactivated, failed, message, started_at, finished_at)
       VALUES ('knowledge_base', $1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [result.status, result.total, result.created, result.updated, result.deactivated, result.failed, result.message, startedAt],
    );
  }

  return result;
}

/** 最近一次/若干次同步历史。 */
export async function listSyncRuns(limit = 20) {
  const { rows } = await pool.query(
    `SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT $1`,
    [Math.max(1, Math.min(Number(limit) || 20, 100))],
  );
  return rows;
}