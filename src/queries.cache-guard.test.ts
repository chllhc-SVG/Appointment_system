import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { REF_CACHE_TTL_MS, ilikeLike, invalidateReferenceCaches } from './queries.js';

/**
 * 缓存红线守卫：cachedQuery 只允许包"几乎不变"的基础资料（门店/项目/技能）。
 * 排班/占用/预约一旦缓存，并发下必双约（两顾客同查空位同建单）。
 * 这里把架构评审自动化：越界调用点出现即红。
 */
describe('缓存红线', () => {
  it('TTL 是 45 秒，改了要显式评审', () => {
    expect(REF_CACHE_TTL_MS).toBe(45_000);
  });

  it('ilikeLike 与 ILIKE %kw% 同语义', () => {
    expect(ilikeLike('%徐汇%', '上海徐汇门店')).toBe(true);
    expect(ilikeLike('%徐汇%', '武汉门店')).toBe(false);
  });

  it('invalidate 可重复调不抛', () => {
    expect(() => {
      invalidateReferenceCaches();
      invalidateReferenceCaches();
    }).not.toThrow();
  });

  it('cachedQuery 调用点只包基础资料，排班预约出现即红', () => {
    const src = fs.readFileSync('src/queries.ts', 'utf8');
    const keys = [...src.matchAll(/cachedQuery\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1] ?? '');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key, `缓存 key 越界: ${key}`).not.toMatch(/schedule|appointment|busy|slot|occup/i);
    }
  });
});
