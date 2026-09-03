import 'dotenv/config';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl) throw new Error('DATABASE_URL is required');

await (async () => {
  const url = new URL(databaseUrl);
  const dbName = url.pathname.replace(/^\//, '') || 'postgres';
  url.pathname = '/postgres';
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE ${JSON.stringify(dbName).replace(/"/g, '')}`);
    console.log(`created database ${dbName}`);
  } else {
    console.log(`database ${dbName} already exists`);
  }
  await admin.end();
})();