import { pool } from './pool.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export async function migrate() {
  const migrationsDir = resolve(process.cwd(), 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    throw new Error(`No SQL migration files found in ${migrationsDir}`);
  }

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    console.log(`[migrate] applied ${file}`);
  }
}