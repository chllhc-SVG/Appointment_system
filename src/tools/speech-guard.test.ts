import { describe, it, expect } from 'vitest';
import {
  CODE_FIELDS,
  VERIFICATION_HINT,
  decorateAppointmentsForSpeech,
  missing,
  requireFields,
  stripCodes,
} from './tools.js';

/**
 * 播报去码守卫：线上事故——数字人把 apt_20260915_xxxx 整串念给 TTS，
 * 十六进制逐字刷屏。修复是剥离返回体双码 + 凭手机核实话术。
 * 这里把事故报告翻译成断言：谁把码加回来，测试即红。
 */
describe('播报去码：TTS 防刷屏', () => {
  it('CODE_FIELDS 覆盖双码字段', () => {
    expect([...CODE_FIELDS].sort()).toEqual(['appointment_code', 'booking_code'].sort());
  });

  it('stripCodes 删掉双码，其他字段原样保留', () => {
    const out = stripCodes({
      appointment_code: 'apt_20260915_abc123',
      booking_code: 'abc123',
      start_at: '2026-09-20T02:00:00.000Z',
      status: 'pending',
    });
    expect(out).not.toHaveProperty('appointment_code');
    expect(out).not.toHaveProperty('booking_code');
    expect(out.status).toBe('pending');
  });

  it('decorate 后列表项补 start_local 且无码', () => {
    const out = decorateAppointmentsForSpeech({
      success: true,
      items: [{ appointment_code: 'apt_xxx', start_at: '2026-09-20T01:00:00.000Z' }],
    }) as { items: Array<Record<string, unknown>> };
    expect(out.items[0]).not.toHaveProperty('appointment_code');
    expect(typeof out.items[0]['start_local']).toBe('string');
    // UTC 01:00Z = 北京时间 09:00，绝不能播成凌晨 1 点
    expect(String(out.items[0]['start_local'])).toContain('09:00');
  });

  it('VERIFICATION_HINT 是凭手机核实口径，不含任何码', () => {
    expect(VERIFICATION_HINT).toContain('手机号');
    expect(VERIFICATION_HINT).not.toMatch(/apt_/);
  });

  it('missing 带 retry_hint，告诉 LLM 答案填哪个参数', () => {
    const result = missing(['store_id|store_name'], '请问哪家门店？') as Record<string, unknown>;
    expect(result.error_code).toBe('NEEDS_MORE_INFO');
    expect(String(result.retry_hint)).toContain('store_id');
  });

  it('requireFields 复合字段任一存在即通过', () => {
    expect(requireFields({ service_name: '光子嫩肤' }, ['service_id|service_name'], '缺项目')).toBeNull();
    const result = requireFields({}, ['service_id|service_name'], '缺项目') as Record<string, unknown>;
    expect(result?.['error_code']).toBe('NEEDS_MORE_INFO');
  });
});
