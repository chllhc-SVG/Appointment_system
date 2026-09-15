import { describe, it, expect } from 'vitest';
import {
  formatBeijing,
  hashIdempotencyKey,
  normalizeDate,
  normalizeTimestamp,
  wrapToolError,
} from './utils.js';

/**
 * 时间守卫：MCP 工具面向 LLM 的时间一律东八区。
 * UTC ISO 一旦直读播报，上午 10 点变凌晨 2 点，用户准时迟到。
 * 这里把时区语义 pin 住：改实现必须同步改断言，否则红。
 */
describe('北京时间口播', () => {
  it('UTC 01:00Z 是北京 09:00，不是凌晨 1 点', () => {
    expect(formatBeijing('2026-09-20T01:00:00.000Z')).toBe('2026-09-20 09:00');
  });

  it('非法日期原样返回不抛，防播报链炸', () => {
    expect(formatBeijing('not-a-date')).toBe('not-a-date');
  });

  it('空格时间按东八区解析：本地 10:00 = UTC 02:00Z', () => {
    expect(normalizeTimestamp('2026-09-20 10:00')).toBe('2026-09-20T02:00:00.000Z');
  });

  it('口语明天上午 10 点能解析且落在 02:00Z', () => {
    expect(normalizeTimestamp('明天上午10点').endsWith('T02:00:00.000Z')).toBe(true);
  });

  it('非法时间抛 INVALID_TIME 且被 wrapToolError 透传错误码', () => {
    try {
      normalizeTimestamp('下个世纪见');
      expect.unreachable();
    } catch (error) {
      const wrapped = wrapToolError(error) as Record<string, unknown>;
      expect(wrapped.error_code).toBe('INVALID_TIME');
    }
  });

  it('normalizeDate 宽容口语：标准直通，明天换算', () => {
    expect(normalizeDate('2026-09-20')).toBe('2026-09-20');
    expect(normalizeDate('明天')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('幂等哈希确定性：同输入同输出，异输入异输出', () => {
    const a = hashIdempotencyKey('create:c1:s1:t1:2026-09-20T02:00Z');
    const b = hashIdempotencyKey('create:c1:s1:t1:2026-09-20T02:00Z');
    const c = hashIdempotencyKey('create:c1:s1:t1:2026-09-20T03:00Z');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
