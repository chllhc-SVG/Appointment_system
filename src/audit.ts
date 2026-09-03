import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Appointment, AuditAction } from './types.js';
import { pool } from './db/pool.js';

export interface AppointmentOperationInput {
  appointment_id?: string;
  operator_type: 'customer' | 'staff' | 'system';
  operator_id: string;
  action: AuditAction;
  before_data?: Record<string, unknown> | null;
  after_data?: Record<string, unknown> | null;
}

export async function writeAudit(input: AppointmentOperationInput, client?: Pool | import('pg').PoolClient) {
  const executor = client ?? pool;
  await executor.query(
    `INSERT INTO appointment_audits (appointment_id, operator_type, operator_id, action, before_data, after_data)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      input.appointment_id ?? null,
      input.operator_type,
      input.operator_id,
      input.action,
      JSON.stringify(input.before_data ?? null),
      JSON.stringify(input.after_data ?? null),
    ],
  );
}
