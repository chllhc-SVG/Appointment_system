import { pool } from './db/pool.js';
import { hashIdempotencyKey } from './utils.js';

/**
 * 幂等写操作辅助：对同一 operation_key 的重复调用只执行一次，
 * 后续调用直接返回首次执行的结果，避免数字人超时重试产生重复副作用。
 */
export async function withIdempotentOperation<T>(input: {
  operationKey: string;
  appointmentId?: string;
  action: string;
  requestPayload: Record<string, unknown>;
  execute: () => Promise<T>;
}): Promise<{ success: true; replay: boolean; result: T } | { success: false; error_code: string; message: string }> {
  const operationKey = hashIdempotencyKey(input.operationKey.trim());

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT result_payload, status FROM appointment_operations WHERE operation_key = $1 LIMIT 1`,
      [operationKey],
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      if (existing.rows[0].status !== 'applied') {
        return { success: false, error_code: 'IDEMPOTENCY_ABORTED', message: '该操作此前已失败，请更换操作标识后重试' };
      }
      return { success: true, replay: true, result: existing.rows[0].result_payload as T };
    }

    const result = await input.execute();

    await client.query(
      `INSERT INTO appointment_operations (operation_key, appointment_id, action, request_payload, result_payload, status)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'applied')`,
      [operationKey, input.appointmentId ?? null, input.action, JSON.stringify(input.requestPayload), JSON.stringify(result)],
    );

    await client.query('COMMIT');
    return { success: true, replay: false, result };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}