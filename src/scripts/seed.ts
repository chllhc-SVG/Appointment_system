import { seedDatabase } from '../db/seed.js';
import { pool } from '../db/pool.js';

async function main() {
  const result = await seedDatabase();
  console.log(`seed completed (${result.seeded ? 'inserted initial demo data' : 'data already present, nothing inserted'})`);
  await pool.end();
}

void main();