import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

export interface AppConfig {
  databaseUrl: string;
  serverName: string;
  serverVersion: string;
  httpPort: number;
  timezone: string;
  adminToken?: string;
}

const loadEnv = () => {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')]) {
    if (existsSync(candidate)) dotenv.config({ path: candidate, override: false });
  }
};

export const loadConfig = (): AppConfig => {
  loadEnv();
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    databaseUrl,
    serverName: process.env.MCP_SERVER_NAME ?? 'appointment-mcp',
    serverVersion: process.env.MCP_SERVER_VERSION ?? '1.0.0',
    httpPort: Number(process.env.MCP_HTTP_PORT ?? 4020),
    timezone: process.env.TZ ?? 'Asia/Shanghai',
    adminToken: process.env.ADMIN_TOKEN?.trim() || undefined,
  };
};