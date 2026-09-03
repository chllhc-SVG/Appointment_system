import crypto from 'node:crypto';
import type { z } from 'zod';

export const toIso = (value: string | Date) => new Date(value).toISOString();

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