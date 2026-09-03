import 'dotenv/config';
import type { Server } from 'node:http';
import { migrate } from './db/migrate.js';
import { seedDatabase } from './db/seed.js';
import { appointmentTools } from './tools/tools.js';
import { createApiServer } from './server.js';
import { createMcpHttpRouter } from './mcp-http.js';
import { loadConfig } from './config.js';
import { pool } from './db/pool.js';
import { startMcpStdio } from './stdio.js';

let httpServer: Server | undefined;

const registerShutdown = () => {
  const shutdown = async (signal: string) => {
    console.log(`[appointment] received ${signal}, shutting down gracefully...`);
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

  const mcpMode = process.env.MCP_MODE ?? 'http';

  if (mcpMode === 'stdio') {
    startMcpStdio();
    console.log(`[appointment] stdio mcp started | tools: ${appointmentTools.map((tool) => tool.name).join(', ')}`);
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

  registerShutdown();
};

void boot();
