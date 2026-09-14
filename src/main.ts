import 'dotenv/config';
import type { Server } from 'node:http';
import { migrate } from './db/migrate.js';
import { seedDatabase } from './db/seed.js';
import { appointmentTools } from './tools/tools.js';
import { createApiServer } from './server.js';
import { createMcpHttpRouter } from './mcp-http.js';
import { loadConfig } from './config.js';
import { pool, warmupPool } from './db/pool.js';
import { sweepExpiredSessions } from './services/customer-identity.js';
import { startMcpStdio } from './stdio.js';

let httpServer: Server | undefined;
let sweepTimer: ReturnType<typeof setInterval> | undefined;

/** 过期会话后台清扫：每 5min 批量标 expired。
 *  从 getActiveSession 热路径剥离后，未识别工具调用不再白白垫高 1 次 DB 写往返；
 *  解析条件本来就带 expires_at > now()，延迟清扫不影响正确性。 */
const startExpiredSessionSweep = () => {
  const tick = async () => {
    try {
      const swept = await sweepExpiredSessions();
      if (swept > 0) console.log(`[appointment] swept ${swept} expired customer sessions`);
    } catch (error) {
      console.error('[appointment] sweep expired sessions failed (non-fatal):', error instanceof Error ? error.message : String(error));
    }
  };
  sweepTimer = setInterval(() => void tick(), 5 * 60_000);
  sweepTimer.unref?.();
  // 启动 30s 后先清扫一次（migrate 之后），不阻塞 listen
  setTimeout(() => void tick(), 30_000).unref?.();
};

const registerShutdown = () => {
  const shutdown = async (signal: string) => {
    console.log(`[appointment] received ${signal}, shutting down gracefully...`);
    try {
      if (sweepTimer) clearInterval(sweepTimer);
    } catch {
      // ignore
    }
    try {
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
      }
    } catch (error) {
      console.error('[appointment] error while closing http server', error);
    }
    try {
      await pool.end();
      console.log('[appointment] database pool closed');
    } catch (error) {
      console.error('[appointment] error while closing database pool', error);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
};

const boot = async () => {
  const config = loadConfig();
  await migrate();
  const seed = await seedDatabase();
  console.log(`[appointment] seed: ${seed.seeded ? 'initial demo data inserted' : 'data already present'}`);
  // 连接池预热：冷启动首笔工具调用不再承担建连开销（首启卡顿的隐性来源之一）
  await warmupPool();

  const mcpMode = process.env.MCP_MODE ?? 'http';

  if (mcpMode === 'stdio') {
    startMcpStdio();
    console.log(`[appointment] stdio mcp started | tools: ${appointmentTools.map((tool) => tool.name).join(', ')}`);
    startExpiredSessionSweep();
    registerShutdown();
    return;
  }

  const app = createApiServer(appointmentTools, config.adminToken);
  app.use('/mcp', createMcpHttpRouter());

  httpServer = app.listen(config.httpPort, () => {
    console.log(`appointment api listening on ${config.httpPort}`);
    console.log(`mcp http listening on ${config.httpPort}/mcp`);
    console.log(`tools: ${appointmentTools.map((tool) => tool.name).join(', ')}`);
  });

  startExpiredSessionSweep();
  registerShutdown();
};

void boot();