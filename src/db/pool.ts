import { Pool } from 'pg';
import { loadConfig } from '../config.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

pool.on('error', (error: Error) => {
  console.error('[db] pool error:', error);
});

pool.on('connect', () => {
  console.log('[db] connected to PostgreSQL');
});

export { pool };
