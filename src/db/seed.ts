import { pool } from './pool.js';

/**
 * 幂等种子数据：门店 / 项目 / 员工 / 技能 / 排班 / 咨询室。
 * 任何机器上重复执行都不会产生重复数据（名称维度先查后插，排班依赖唯一约束）。
 * 服务启动时自动调用，保证新环境 `docker compose up` 后即有可用演示数据。
 */
export async function seedDatabase(): Promise<{ seeded: boolean }> {
  let createdAny = false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 门店：按名称维度幂等
    const storeQuery = await client.query(`SELECT id FROM stores WHERE name = '上海徐汇门店' LIMIT 1`);
    let storeId = storeQuery.rows[0]?.id as string | undefined;
    const storeIsNew = !storeId;
    if (!storeId) {
      const inserted = await client.query(`INSERT INTO stores (name, timezone) VALUES ($1, 'Asia/Shanghai') RETURNING id`, ['上海徐汇门店']);
      storeId = inserted.rows[0].id as string;
      createdAny = true;
    }

    // 服务项目：按名称维度幂等（demo 数据模拟"已从知识库同步"，以符合仅知识库项目可预约的约束）
    const serviceNames = [
      { name: '皮肤管理', duration: 60, price: 29900, category: '基础护理' },
      { name: '光子嫩肤', duration: 90, price: 69900, category: '光电类' },
      { name: '热玛吉紧致', duration: 90, price: 1280000, category: '抗衰' },
    ];
    const serviceIdBy = new Map<string, string>();
    for (const { name, duration, price, category } of serviceNames) {
      const existing = await client.query(`SELECT id FROM services WHERE name = $1 LIMIT 1`, [name]);
      if (existing.rows[0]?.id) {
        await client.query(
          `UPDATE services
           SET source_system = 'knowledge_base', source_key = $2, sync_status = 'synced',
               category = $5, duration_minutes = $3, price_cents = COALESCE(price_cents, $4),
               updated_at = now()
           WHERE id = $1`,
          [existing.rows[0].id, name, duration, price, category],
        );
        serviceIdBy.set(name, existing.rows[0].id as string);
      } else {
        const inserted = await client.query(
          `INSERT INTO services (name, duration_minutes, price_cents, source_system, source_key, sync_status, category)
           VALUES ($1, $2, $3, 'knowledge_base', $1, 'synced', $4)
           RETURNING id`,
          [name, duration, price, category],
        );
        serviceIdBy.set(name, inserted.rows[0].id as string);
      }
    }

    // 门店 ↔ 可服务项目：新门店默认绑定全部已同步项目（后续由前台在门店编辑中按分类勾选调整）
    if (storeIsNew) {
      for (const serviceId of serviceIdBy.values()) {
        await client.query(
          `INSERT INTO store_services (store_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [storeId, serviceId],
        );
      }
    }

    // 员工：按 (store_id, name) 维度幂等
    const staffNames = ['李美容师', '王老师'];
    const staffIds: string[] = [];
    const staffIdBy = new Map<string, string>();
    for (const name of staffNames) {
      const existing = await client.query(`SELECT id FROM staff WHERE store_id = $1 AND name = $2 LIMIT 1`, [storeId, name]);
      if (existing.rows[0]?.id) {
        staffIdBy.set(name, existing.rows[0].id as string);
      } else {
        const inserted = await client.query(`INSERT INTO staff (store_id, name) VALUES ($1, $2) RETURNING id`, [storeId, name]);
        staffIdBy.set(name, inserted.rows[0].id as string);
      }
      const id = staffIdBy.get(name)!;
      staffIds.push(id);

      // 员工技能：绑定全部项目
      for (const serviceId of serviceIdBy.values()) {
        await client.query(
          `INSERT INTO staff_service_skills (staff_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, serviceId],
        );
      }
    }

    // 排班：未来 3 天，上午 09:00-12:00 / 下午 13:00-18:00，靠 UNIQUE(staff_id, start_at) 幂等
    const day = (offset: number): string => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    for (const staffId of staffIds) {
      for (let offset = 1; offset <= 3; offset++) {
        const date = day(offset);
        const slots = [
          { start: `${date}T09:00:00+08:00`, end: `${date}T12:00:00+08:00` },
          { start: `${date}T13:00:00+08:00`, end: `${date}T18:00:00+08:00` },
        ];
        for (const slot of slots) {
          await client.query(
            `INSERT INTO staff_schedules (staff_id, start_at, end_at, status)
             VALUES ($1, $2, $3, 'available')
             ON CONFLICT (staff_id, start_at) DO NOTHING`,
            [staffId, slot.start, slot.end],
          );
        }
      }
    }

    // 咨询室（供前台/排班空间展示）
    await client.query(
      `INSERT INTO rooms (room_id, name, area_id, area_name)
       VALUES ('beauty_room_1', '美业咨询室', 'store_1', '上海徐汇门店')
       ON CONFLICT (room_id) DO NOTHING`,
    );

    await client.query('COMMIT');
    return { seeded: createdAny };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}