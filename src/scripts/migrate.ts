import 'dotenv/config';
import { migrate } from '../db/migrate.js';

async function main() {
  await migrate();
  console.log('migration completed');
}

void main();
