import crypto from 'node:crypto';
import type { z } from 'zod';

export const toIso = (value: string | Date) => new Date(value).toISOString();

const TZ_OFFSET = '+08:00';

/**
 * 数字人口语时间的宽容解析（服务端统一兜底，LLM 不必严格产出 ISO）：
 *  - "2026-06-17"            → 当天 00:00（东八区）
 *  - "2026-06-17 15:30"      → 东八区（空格分隔，LLM 常见输出）
 *  - "2026-06-17T15:30"      → 东八区
 *  - 带时区 ISO（Z / ±hh:mm）→ 原样解析
 *  非法输入抛 INVALID_TIME，提示语可直接回给数字人复述。
 */
export function normalizeTimestamp(value: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('INVALID_TIME: 时间不能为空');
  if (/Z$/i.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw)) {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw new Error(`INVALID_TIME: 无法解析时间「${raw}」`);
    return parsed.toISOString();
  }
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) {
    throw new Error(`INVALID_TIME: 无法解析时间「${raw}」，请使用 YYYY-MM-DD 或 YYYY-MM-DD HH:mm`);
  }
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${TZ_OFFSET}`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`INVALID_TIME: 无法解析时间「${raw}」`);
  return parsed.toISOString();
}

/** 日期参数校验（YYYY-MM-DD），用于按天查询时段。 */
export function normalizeDate(value: string): string {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`INVALID_DATE: 无法解析日期「${raw}」，请使用 YYYY-MM-DD`);
  }
  return raw;
}

export const makeAppointmentCode = () => `apt_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;

export const hashIdempotencyKey = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export const addMinutes = (start: string | Date, minutes: number) => new Date(new Date(start).getTime() + minutes * 60_000).toISOString();

export const assertNonEmpty = (value: string, name: string) => {
  if (!String(value ?? '').trim()) {
    throw new Error(`${name} is required`);
  }
};

/** 把 zod 输入 schema 转成 MCP tools/list 需要的 JSON Schema 描述。 */
export function toMcpToolDefinition(tool: {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
}) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool.inputSchema),
  };
}

const toJsonSchema = (schema: z.ZodTypeAny): Record<string, unknown> => {
  const description = (schema._def as { description?: string }).description;
  const result: Record<string, unknown> = {};
  if (description) result.description = description;

  const type = (schema as unknown as { _type?: string | string[] })._type;
  const def = schema._def as Record<string, unknown>;

  if (typeof schema.parse === 'function' && def.typeName === 'ZodString') {
    result.type = 'string';
    const min = (def as { minLength?: number }).minLength;
    if (min) result.minLength = min;
  } else if ((def.typeName as string) === 'ZodNumber') {
    result.type = 'number';
    const min = (def as { minimum?: number }).minimum;
    if (min !== undefined) result.minimum = min;
    const max = (def as { maximum?: number }).maximum;
    if (max !== undefined) result.maximum = max;
  } else if ((def.typeName as string) === 'ZodBoolean') {
    result.type = 'boolean';
  } else if ((def.typeName as string) === 'ZodEnum') {
    result.type = 'string';
    result.enum = (def as { values?: unknown }).values ?? [];
  } else if ((def.typeName as string) === 'ZodOptional') {
    const inner = (def as { innerType?: z.ZodTypeAny }).innerType;
    const innerSchema = inner ? toJsonSchema(inner) : {};
    Object.assign(result, innerSchema);
    delete result.description;
    if (description) result.description = description;
  } else if ((def.typeName as string) === 'ZodObject') {
    result.type = 'object';
    const shape = (def as { shape?: () => Record<string, z.ZodTypeAny> }).shape?.();
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    if (shape) {
      for (const [key, value] of Object.entries(shape)) {
        props[key] = toJsonSchema(value);
        const innerDef = (value._def as { typeName?: string; innerType?: { _def: { typeName?: string } } });
        if (innerDef.typeName !== 'ZodOptional') required.push(key);
      }
    }
    result.properties = props;
    if (required.length > 0) result.required = required;
  }
  return result;
};

/** 把工具执行抛出的异常包装成统一结构，避免 MCP 返回裸 500。 */
export function wrapToolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { success: false, error_code: 'INTERNAL_ERROR', message };
}