/**
 * 预约 query_slots 基准：cold 1 次 + hot N 次，输出 cold / hot p50 / p95。
 *
 * 用法（仓库根执行，无需 build，直接跑 TS 源码）：
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5434/appointment_mcp \
 *     npx tsx scripts/bench-slots.ts --date 2026-09-20 --rounds 20
 *
 * 设计说明（为什么这样测）：
 *  - 直接调 searchAvailableSlots（services 层），绕过 HTTP 层：测的是 SQL+缓存真耗时，
 *    不被 express/JSON 序列化污染；HTTP 全链路用 curl 另测。
 *  - cold 单独 1 次：含连接池建连 + 基础资料缓存 miss，是用户第一句话的体感。
 *  - hot N 次取 p50/p95：缓存命中态，p95 比平均值更能暴露长尾（GC/池抖动）。
 *  - 同一入参连跑：控制变量，cold 与 hot 的差值 = 缓存+建连省下的税。
 *  - 跑完 pool.end()：否则进程 hanging，CI 会卡死。
 */
import { searchAvailableSlots } from '../src/services/appointments.js';
import { pool } from '../src/db/pool.js';

const rawTokens = process.argv.slice(2);
const parsedArgs = new Map<string, string>();
for (let i = 0; i < rawTokens.length; i += 1) {
  const token = rawTokens[i] ?? '';
  if (!token.startsWith('--')) continue;
  const cleaned = token.replace(/^--/, '');
  const eq = cleaned.indexOf('=');
  if (eq >= 0) {
    parsedArgs.set(cleaned.slice(0, eq), cleaned.slice(eq + 1));
  } else {
    // 空格形式：--date 2026-09-20，下一个 token 即值
    parsedArgs.set(cleaned, rawTokens[i + 1] ?? '');
    i += 1;
  }
}
const date = parsedArgs.get('date') ?? '2026-09-20';
const serviceId = parsedArgs.get('service-id') ?? undefined;
const storeId = parsedArgs.get('store-id') ?? undefined;
const HOT_ROUNDS = Number(parsedArgs.get('rounds') ?? 20);
const VERBOSE = parsedArgs.has('verbose');

const timeOnce = async (): Promise<{ ms: number; result: unknown }> => {
  const started = performance.now();
  const result = await searchAvailableSlots({
    date,
    ...(serviceId ? { service_id: serviceId } : {}),
    ...(storeId ? { store_id: storeId } : {}),
  });
  return { ms: performance.now() - started, result };
};

const quantile = (sorted: number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

const summarize = (value: unknown): string => {
  if (!value || typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  if (record.success === true) {
    const slots = record.slots;
    return `success slots=${Array.isArray(slots) ? slots.length : '?'}`;
  }
  return `fail ${String(record.error_code ?? '')} ${String(record.message ?? '').slice(0, 60)}`;
};

try {
  const cold = await timeOnce();
  const hots: number[] = [];
  for (let i = 0; i < HOT_ROUNDS; i += 1) hots.push((await timeOnce()).ms);
  hots.sort((a, b) => a - b);

  const p50 = quantile(hots, 0.5);
  const p95 = quantile(hots, 0.95);
  console.log(
    JSON.stringify({
      date,
      cold_ms: Math.round(cold.ms * 100) / 100,
      hot_p50_ms: Math.round(p50 * 100) / 100,
      hot_p95_ms: Math.round(p95 * 100) / 100,
      rounds: HOT_ROUNDS,
      cold_result: summarize(cold.result),
    }),
  );
  if (VERBOSE) console.log(`cold detail: ${JSON.stringify(cold.result).slice(0, 500)}`);
} finally {
  await pool.end().catch(() => undefined);
}
