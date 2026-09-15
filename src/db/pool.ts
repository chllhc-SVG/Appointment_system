import { Pool } from 'pg';
import { loadConfig } from '../config.js';

const config = loadConfig();
/** 连接池上限：NaN/越界兜底回 10（原 pg 默认值），范围 1~50；
 *  显式声明防止后续误改，且支持 POOL_MAX 环境变量扩容。 */
const parsedPoolMax = Number(process.env.POOL_MAX ?? 10);
const poolMax = Number.isFinite(parsedPoolMax)
  ? Math.min(50, Math.max(1, Math.floor(parsedPoolMax)))
  : 10;
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: poolMax,
  // 空闲客户端 30s 回收；连接获取超时 5s（池耗尽时快速失败而非无限挂起）
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // 单条语句 10s 超时：慢查询快速失败，不占着池里的连接把后续工具调用全拖住
  statement_timeout: 10_000,
  query_timeout: 10_000,
  // 保持 TCP 活跃，避免空闲期被 Docker NAT 悄悄断链后下一笔重新建连
  keepAlive: true,
});

pool.on('error', (error: Error) => {
  console.error('[db] pool error:', error);
});

pool.on('connect', () => {
  console.log('[db] connected to PostgreSQL');
});

/** 启动期连接预热：冷启动后第一笔工具调用不再承担 TCP+TLS+认证的建连开销。
 *  预热失败只打日志，不阻塞服务启动（main.ts 的 migrate/seed 会照常建连兜底）。 */
export async function warmupPool(): Promise<void> {
  try {
    await pool.query('SELECT 1');
    console.log('[db] pool warmed up');
  } catch (error) {
    console.error('[db] pool warmup failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }
}

export { pool };
