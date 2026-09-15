import { describe, it, expect } from 'vitest';
import { appointmentTools, manageBookingInput, queryBookingsInput } from './tools.js';

/**
 * MCP 对外契约锁死：5 工具名、动作枚举、查询范围枚举一旦变更，
 * 数字人侧提示词、平台白名单、后端路由三处同时失联。
 * 这里把"名字不许动"从口头约定变成 CI 可判定断言。
 */
describe('MCP 对外契约锁死', () => {
  it('5 工具名字一个不能变，少一个多一个都红', () => {
    const names = appointmentTools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'list_store_catalog',
        'manage_booking',
        'manage_customer_session',
        'query_bookings',
        'query_slots',
      ].sort(),
    );
  });

  it('每个工具都有 description 和 inputSchema，防裸工具上线', () => {
    for (const tool of appointmentTools) {
      expect((tool.description ?? '').trim().length).toBeGreaterThan(10);
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('manage_booking 的 action 枚举一个不能少，非法动作必须拒', () => {
    for (const action of ['create', 'cancel', 'reschedule', 'check_in', 'confirm', 'complete', 'mark_no_show']) {
      expect(manageBookingInput.safeParse({ action }).success).toBe(true);
    }
    expect(manageBookingInput.safeParse({ action: 'delete_all' }).success).toBe(false);
  });

  it('query_bookings 的 scope 枚举锁死', () => {
    for (const scope of ['my', 'detail', 'audits', 'list', 'overview']) {
      expect(queryBookingsInput.safeParse({ scope }).success).toBe(true);
    }
  });
});
