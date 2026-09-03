import { Client } from 'pg';

const combos = [
  ['postgres', 'postgres'],
  ['postgres', '123456'],
  ['postgres', 'admin'],
  ['postgres', 'password'],
  ['postgres', 'root'],
  ['17653', ''],
  ['laptop-22phjdo4', ''],
  ['postgres', ''],
];

for (const [user, password] of combos) {
  const c = new Client({ host: '127.0.0.1', port: 5432, database: 'postgres', user, password });
  try {
    await c.connect();
    console.log(`OK user=${user} password=${JSON.stringify(password)}`);
    await c.end();
    process.exit(0);
  } catch {
    // try next
  }
}
console.log('no combo worked');
process.exit(1);