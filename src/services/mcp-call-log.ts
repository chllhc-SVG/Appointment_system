import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';

export interface McpCallLog {
  id: string;
  request_id: string;
  transport: string;
  agent_code?: string | null;
  tool_name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  success: boolean;
  error_code?: string | null;
  duration_ms: number;
  created_at: string;
}

interface NewMcpCallLog {
  transport: string;
  agent_code?: string | null;
  tool_name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  success: boolean;
  error_code?: string | null;
  duration_ms: number;
}

/** 最近调用日志内存副本（DB 查询不可用/前端秒开时兜底展示）。 */
const recentBuffer: McpCallLog[] = [];

const box = (input: NewMcpCallLog): McpCallLog => ({
  id: randomUUID(),
  request_id: `mcp_${randomUUID()}`,
  created_at: new Date().toISOString(),
  ...input,
});

const pushBuffer = (log: McpCallLog) => {
  recentBuffer.unshift(log);
  recentBuffer.splice(200);
  return log;
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
};

/**
 * 记录一次 MCP 工具调用：先入内存缓冲（即时可见），再异步写库（失败不阻塞调用方）。
 * 参数/结果序列化失败时降级为占位符，保证日志写入永不抛错。
 */
export async function recordMcpCall(input: NewMcpCallLog): Promise<void> {
  const log = pushBuffer(box(input));
  try {
    await pool.query(
      `INSERT INTO mcp_call_logs (
        request_id, transport, agent_code, tool_name, arguments, result, success, error_code, duration_ms
      ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)`,
      [
        log.request_id,
        log.transport,
        log.agent_code ?? null,
        log.tool_name,
        safeStringify(log.arguments),
        safeStringify(log.result),
        log.success,
        log.error_code ?? null,
        log.duration_ms,
      ],
    );
  } catch (error) {
    console.error('[mcp-call-log] failed to persist call log', error);
  }
}

export interface McpCallLogQuery {
  agent_code?: string;
  tool_name?: string;
  status?: 'success' | 'failure';
  keyword?: string;
  limit?: number;
  offset?: number;
}

export interface McpCallLogPage {
  items: McpCallLog[];
  total: number;
  limit: number;
  offset: number;
}

const asRecord = (row: Record<string, unknown>): McpCallLog => ({
  ...(row as unknown as McpCallLog),
  agent_code: row.agent_code as string | null,
  arguments: (row.arguments as Record<string, unknown> ?? {}),
  result: row.result,
});

/** 查询已落库的调用日志，含总数用于分页；DB 异常时回退到内存缓冲。 */
export async function queryMcpCallLogs(input: McpCallLogQuery = {}): Promise<McpCallLogPage> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const offset = Math.max(0, input.offset ?? 0);

  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (input.agent_code?.trim()) {
      params.push(input.agent_code.trim());
      conditions.push(`agent_code = $${params.length}`);
    }
    if (input.tool_name?.trim()) {
      params.push(input.tool_name.trim());
      conditions.push(`tool_name = $${params.length}`);
    }
    const statusValue = input.status;
    if (statusValue === 'success' || statusValue === 'failure') {
      params.push(statusValue === 'success');
      conditions.push(`success = $${params.length}`);
    }
    if (input.keyword?.trim()) {
      params.push(`%${input.keyword.trim()}%`);
      conditions.push(`(tool_name ILIKE $${params.length} OR COALESCE(agent_code,'') ILIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);

    const [countRes, pageRes] = await Promise.all([
      pool.query(`SELECT count(*)::int AS total FROM mcp_call_logs ${where}`, params.slice(0, params.length - 2)),
      pool.query(
        `SELECT * FROM mcp_call_logs ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      ),
    ]);

    return {
      items: pageRes.rows.map((row) => asRecord(row)),
      total: (countRes.rows[0]?.total as number) ?? 0,
      limit,
      offset,
    };
  } catch (error) {
    console.error('[mcp-call-log] query failed, falling back to memory buffer', error);
    const filtered = recentBuffer.filter((log) => {
      if (input.agent_code && log.agent_code !== input.agent_code) return false;
      if (input.tool_name && log.tool_name !== input.tool_name) return false;
      if (input.status === 'success' && !log.success) return false;
      if (input.status === 'failure' && log.success) return false;
      return true;
    });
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset };
  }
}

/** 调用日志的最新一条（兜底给 overview 快速展示，DB 异常时返回内存数据）。 */
export async function listRecentMcpCalls(limit = 20): Promise<McpCallLog[]> {
  const page = await queryMcpCallLogs({ limit });
  return page.items;
}

const removeFromBuffer = (ids: Set<string>) => {
  for (let index = recentBuffer.length - 1; index >= 0; index -= 1) {
    if (ids.has(recentBuffer[index].id)) recentBuffer.splice(index, 1);
  }
};

/** 删除单条调用日志（内存缓冲同步移除；DB 异常时视为已删除）。 */
export async function deleteMcpCallLog(id: string): Promise<boolean> {
  if (!id?.trim()) return false;
  const trimmed = id.trim();
  removeFromBuffer(new Set([trimmed]));
  try {
    const result = await pool.query('DELETE FROM mcp_call_logs WHERE id = $1', [trimmed]);
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    console.error('[mcp-call-log] delete failed', error);
    return false;
  }
}

/** 批量删除调用日志，返回实际删除条数。空数组返回 0。 */
export async function deleteMcpCallLogs(ids: string[]): Promise<number> {
  const uniqueIds = Array.from(new Set((ids ?? []).map((id) => id?.trim()).filter(Boolean)));
  if (uniqueIds.length === 0) return 0;
  removeFromBuffer(new Set(uniqueIds));
  try {
    // id 列为 UUID：与 text[] 参数比较需先转文本（否则 uuid=text 无操作符报错）
    const result = await pool.query('DELETE FROM mcp_call_logs WHERE id::text = ANY($1::text[])', [uniqueIds]);
    return result.rowCount ?? 0;
  } catch (error) {
    console.error('[mcp-call-log] batch delete failed', error);
    return 0;
  }
}

/** 调用日志统计分析（给日志中心图表用）。 */
export interface McpCallLogStats {
  total: number;
  success: number;
  failure: number;
  successRate: number;
  avgDurationMs: number;
  /** 近 14 天逐日调用量 */
  dailyTrend: Array<{ date: string; total: number; success: number; failure: number }>;
  /** 工具调用 Top（含成功/失败拆分） */
  topTools: Array<{ tool_name: string; count: number; success: number; failure: number }>;
  /** 调用方 Top */
  topAgents: Array<{ agent_code: string | null; count: number }>;
  /** 失败错误码分布 */
  topErrorCodes: Array<{ error_code: string | null; count: number }>;
}

/** 统计近 14 天的调用日志；DB 异常时回退内存缓冲计算。 */
export async function mcpCallLogStats(days = 14): Promise<McpCallLogStats> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const [overall, trend, tools, agents, errors] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE success)::int AS success,
                count(*) FILTER (WHERE NOT success)::int AS failure,
                round(coalesce(avg(duration_ms), 0))::int AS avg_duration_ms
         FROM mcp_call_logs WHERE created_at >= $1`,
        [since],
      ),
      pool.query(
        `SELECT to_char(created_at AT TIME ZONE COALESCE($2, 'Asia/Shanghai'), 'YYYY-MM-DD') AS date,
                count(*)::int AS total,
                count(*) FILTER (WHERE success)::int AS success,
                count(*) FILTER (WHERE NOT success)::int AS failure
         FROM mcp_call_logs
         WHERE created_at >= $1
         GROUP BY 1 ORDER BY 1`,
        [since, process.env.TZ ?? 'Asia/Shanghai'],
      ),
      pool.query(
        `SELECT tool_name, count(*)::int AS count,
                count(*) FILTER (WHERE success)::int AS success,
                count(*) FILTER (WHERE NOT success)::int AS failure
         FROM mcp_call_logs
         WHERE created_at >= $1
         GROUP BY tool_name ORDER BY count DESC LIMIT 10`,
        [since],
      ),
      pool.query(
        `SELECT agent_code, count(*)::int AS count
         FROM mcp_call_logs
         WHERE created_at >= $1
         GROUP BY agent_code ORDER BY count DESC LIMIT 10`,
        [since],
      ),
      pool.query(
        `SELECT error_code, count(*)::int AS count
         FROM mcp_call_logs
         WHERE created_at >= $1 AND NOT success
         GROUP BY error_code ORDER BY count DESC LIMIT 10`,
        [since],
      ),
    ]);

    const o = overall.rows[0] ?? { total: 0, success: 0, failure: 0, avg_duration_ms: 0 };
    const total = o.total as number;
    return {
      total,
      success: o.success as number,
      failure: o.failure as number,
      successRate: total === 0 ? 0 : Number((((o.success as number) / total) * 100).toFixed(1)),
      avgDurationMs: o.avg_duration_ms as number,
      dailyTrend: trend.rows.map((row) => ({
        date: row.date as string,
        total: row.total as number,
        success: row.success as number,
        failure: row.failure as number,
      })),
      topTools: tools.rows.map((row) => ({
        tool_name: row.tool_name as string,
        count: row.count as number,
        success: row.success as number,
        failure: row.failure as number,
      })),
      topAgents: agents.rows.map((row) => ({ agent_code: row.agent_code as string | null, count: row.count as number })),
      topErrorCodes: errors.rows.map((row) => ({ error_code: row.error_code as string | null, count: row.count as number })),
    };
  } catch (error) {
    console.error('[mcp-call-log] stats query failed, falling back to memory buffer', error);
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const recent = recentBuffer.filter((log) => new Date(log.created_at).getTime() >= sinceMs);
    const success = recent.filter((log) => log.success).length;
    const failure = recent.length - success;
    const byTool = new Map<string, { count: number; success: number; failure: number }>();
    const byAgent = new Map<string, number>();
    const byError = new Map<string, number>();
    for (const log of recent) {
      const tool = byTool.get(log.tool_name) ?? { count: 0, success: 0, failure: 0 };
      tool.count += 1;
      if (log.success) tool.success += 1; else tool.failure += 1;
      byTool.set(log.tool_name, tool);
      byAgent.set(log.agent_code ?? 'anonymous', (byAgent.get(log.agent_code ?? 'anonymous') ?? 0) + 1);
      if (!log.success) byError.set(log.error_code ?? 'UNKNOWN', (byError.get(log.error_code ?? 'UNKNOWN') ?? 0) + 1);
    }
    return {
      total: recent.length,
      success,
      failure,
      successRate: recent.length === 0 ? 0 : Number(((success / recent.length) * 100).toFixed(1)),
      avgDurationMs: recent.length === 0 ? 0 : Math.round(recent.reduce((sum, log) => sum + (log.duration_ms ?? 0), 0) / recent.length),
      dailyTrend: [],
      topTools: [...byTool.entries()].map(([tool_name, value]) => ({ tool_name, ...value })).sort((a, b) => b.count - a.count).slice(0, 10),
      topAgents: [...byAgent.entries()].map(([agent_code, count]) => ({ agent_code, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      topErrorCodes: [...byError.entries()].map(([error_code, count]) => ({ error_code, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const resultSuccessOf = (result: unknown): boolean => {
  if (!isRecord(result)) return true;
  if ('success' in result) return result.success !== false;
  return true;
};

const errorCodeOf = (result: unknown): string | undefined => {
  if (isRecord(result)) {
    if (typeof result.error_code === 'string') return result.error_code;
    if (isRecord(result.error) && typeof result.error.error_code === 'string') return result.error.error_code;
  }
  return undefined;
};

/**
 * 统一执行一次 MCP 工具调用并打日志。
 * handler 正常返回 → 按返回体 success 字段判定成败并记录；
 * handler 抛错 → 记录失败并重新抛出，由上层按协议包装。
 */
export async function wrapToolCall(input: {
  transport: string;
  agentCode?: string | null;
  toolName: string;
  args: Record<string, unknown>;
  execute: () => Promise<unknown>;
}): Promise<unknown> {
  const startedAt = Date.now();
  try {
    const result = await input.execute();
    void recordMcpCall({
      transport: input.transport,
      agent_code: input.agentCode,
      tool_name: input.toolName,
      arguments: input.args,
      result,
      success: resultSuccessOf(result),
      error_code: errorCodeOf(result),
      duration_ms: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    void recordMcpCall({
      transport: input.transport,
      agent_code: input.agentCode,
      tool_name: input.toolName,
      arguments: input.args,
      result: null,
      success: false,
      error_code: error instanceof Error ? error.name : 'INTERNAL_ERROR',
      duration_ms: Date.now() - startedAt,
    });
    throw error;
  }
}
