import crypto from 'node:crypto';
import type { z } from 'zod';

export const toIso = (value: string | Date) => new Date(value).toISOString();

const TZ_OFFSET = '+08:00';

/** 东八区当天 YYYY-MM-DD（口语日期换算的基准） */
const beijingToday = (): string => formatBeijing(new Date()).slice(0, 10);

const addBeijingDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const pad2 = (n: number) => String(n).padStart(2, '0');

const RELATIVE_DAYS: Record<string, number> = {
  '今天': 0, '今日': 0, '明天': 1, '明日': 1, '后天': 2, '大后天': 3,
};

const WEEKDAY_NAMES: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0,
};

/** 口语日期短语 → YYYY-MM-DD（东八区）。
 *  支持：今天/明天/后天/大后天、周X/星期X/礼拜X（下一个）、YYYY-MM-DD、
 *  2026年9月9日、9月9日 / 09-09（无年份自动补当年，已过去则顺延一年）。
 *  这是 LLM 回填 date 参数的主路径——用户口语说"明天"，LLM 在不知道今天
 *  几号时也会原样传"明天"，服务端必须兜底换算，否则工具报错引发空回。 */
function parseDatePhrase(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const relative = RELATIVE_DAYS[text];
  if (relative !== undefined) return addBeijingDays(beijingToday(), relative);

  const weekday = text.match(/^(?:周|星期|礼拜)([一二三四五六日天])$/);
  if (weekday) {
    const target = WEEKDAY_NAMES[weekday[1] ?? ''] ?? -1;
    if (target >= 0) {
      const todayDow = new Date(`${beijingToday()}T00:00:00+08:00`).getUTCDay();
      return addBeijingDays(beijingToday(), (target - todayDow + 7) % 7);
    }
  }

  const full = text.match(/^(\d{4})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})[日号]?$/);
  if (full) return `${full[1]}-${pad2(Number(full[2]))}-${pad2(Number(full[3]))}`;

  const short = text.match(/^(\d{1,2})[月\-\/.](\d{1,2})[日号]?$/);
  if (short) {
    const year = Number(beijingToday().slice(0, 4));
    const candidate = `${year}-${pad2(Number(short[1]))}-${pad2(Number(short[2]))}`;
    return candidate < beijingToday() ? `${year + 1}-${candidate.slice(5)}` : candidate;
  }
  return null;
}

/**
 * 口语时间戳宽容解析（服务端统一兜底，LLM 不必严格产出 ISO）：
 *  - "2026-06-17"            → 当天 00:00（东八区）
 *  - "2026-06-17 15:30"      → 东八区（空格分隔，LLM 常见输出）
 *  - "2026-06-17T15:30"      → 东八区
 *  - 带时区 ISO（Z / ±hh:mm）→ 原样解析
 *  - "明天/后天/周X"          → 按东八区换算日期
 *  - "明天 10:00 / 明天上午10点 / 明天下午3点半" → 日期+时刻合并解析
 *  非法输入抛 INVALID_TIME，由 wrapToolError 转成结构化错误回给数字人。
 */
export function normalizeTimestamp(value: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('INVALID_TIME: 时间不能为空');
  if (/Z$/i.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw)) {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw new Error(`INVALID_TIME: 无法解析时间「${raw}」`);
    return parsed.toISOString();
  }
  const strict = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (strict) {
    const [, year, month, day, hour = '00', minute = '00', second = '00'] = strict;
    const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${TZ_OFFSET}`);
    if (Number.isNaN(parsed.getTime())) throw new Error(`INVALID_TIME: 无法解析时间「${raw}」`);
    return parsed.toISOString();
  }

  // 口语短语：[日期词] [时段词] 时刻。时刻支持 "10:30" / "10点" / "10点半" /
  // "10点30分" / 中文数字"十点"。日期与时刻之间的空格可有可无，时段词与数字
  // 之间可粘连（"上午10点"）。
  const phrase = raw.match(
    /^(今天|今日|明天|明日|后天|大后天|(?:周|星期|礼拜)[一二三四五六日天]|\d{4}[年\-\/.]\d{1,2}[月\-\/.]\d{1,2}[日号]?|\d{1,2}[月\-\/.]\d{1,2}[日号]?)?\s*(上午|早上|清晨|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2}|[一二两三四五六七八九十]+)\s*[点时:：]\s*(半|\d{1,2})?\s*分?\s*$/,
  );
  if (phrase) {
    const datePart = phrase[1] ? parseDatePhrase(phrase[1]) : beijingToday();
    const meridiem = phrase[2] ?? '';
    let hour = phrase[3] ?? '';
    if (/[一二两三四五六七八九十]/.test(hour)) {
      const cjk: Record<string, number> = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
      if (hour === '十') hour = '10';
      else if (hour.startsWith('十')) hour = String(10 + (cjk[hour.slice(1)] ?? 0));
      else if (hour.endsWith('十')) hour = String((cjk[hour.slice(0, -1)] ?? 1) * 10);
      else hour = String(cjk[hour] ?? NaN);
    }
    let hourNum = Number(hour);
    const minuteRaw = phrase[4] ?? '';
    let minuteNum = minuteRaw === '半' ? 30 : minuteRaw ? Number(minuteRaw) : 0;
    if (Number.isNaN(hourNum) || Number.isNaN(minuteNum) || hourNum > 24 || minuteNum > 59) {
      throw new Error(`INVALID_TIME: 无法解析时间「${raw}」，请使用 YYYY-MM-DD HH:mm`);
    }
    if ((meridiem === '下午' || meridiem === '傍晚' || meridiem === '晚上' || meridiem === '夜里') && hourNum < 12) hourNum += 12;
    if (meridiem === '中午' && hourNum === 1) hourNum = 13;
    if (hourNum === 24) hourNum = 0;
    const parsed = new Date(`${datePart}T${pad2(hourNum)}:${pad2(minuteNum)}:00${TZ_OFFSET}`);
    if (Number.isNaN(parsed.getTime())) throw new Error(`INVALID_TIME: 无法解析时间「${raw}」`);
    return parsed.toISOString();
  }

  throw new Error(`INVALID_TIME: 无法解析时间「${raw}」，请使用 YYYY-MM-DD HH:mm（或 明天上午10点 这类口语）`);
}

/** 日期参数校验（宽容版）：YYYY-MM-DD 直通；今天/明天/后天/大后天/周X/M月D日/2026年9月9日
 *  自动换算东八区。LLM 在不知道今天几号时常把用户口语"明天"原样传入，
 *  这里不兜底就会 throw → 数字人空回（线上已复现），必须服务端换算。 */
export function normalizeDate(value: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('INVALID_DATE: 日期不能为空，请使用 YYYY-MM-DD 或 今天/明天/后天');
  const normalized = parseDatePhrase(raw);
  if (!normalized) {
    throw new Error(`INVALID_DATE: 无法解析日期「${raw}」，请使用 YYYY-MM-DD（也可传 今天/明天/后天/周X）`);
  }
  return normalized;
}

export const makeAppointmentCode = () => `apt_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;

/**
 * 东八区本地时间字符串（YYYY-MM-DD HH:mm）。
 * MCP 工具面向 LLM 的时间一律用本地时区：裸 UTC ISO（如 2026-09-08T01:00:00Z）
 * 会被 LLM 误读成"凌晨1点"（实际是北京时间 09:00），导致预约时间张冠李戴。
 */
export function formatBeijing(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

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

/** 把工具执行抛出的异常包装成统一结构，避免 MCP 返回裸 500。
 *  INVALID_DATE / INVALID_TIME 是参数校验类错误，error_code 透传原始码
 *  （LLM 依据错误码能区分"参数错了要重问用户"和"服务内部异常"）。 */
export function wrapToolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const paramError = message.match(/^(INVALID_DATE|INVALID_TIME|NEEDS_MORE_INFO):\s*(.*)$/);
  if (paramError) {
    return { success: false, error_code: paramError[1], message: paramError[2] };
  }
  return { success: false, error_code: 'INTERNAL_ERROR', message };
}