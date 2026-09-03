/**
 * 调用方身份解析，对齐 knowledge-platform 的 mcpHttp.controller 模式：
 *   1) HTTP 头 X-Agent-Code（数字人客户端 localMcpForwarder / 基座转发层注入，最可信）
 *   2) Authorization: Bearer <JWT> 的 sub 字段（数字人登录令牌，取 sub 作为 agent_code）
 *   3) 都缺失 → 匿名（管理端或直连调试场景）
 * 解析出的身份会作为 verifiedAgentCode 注入工具执行上下文，
 * 写操作（创建/取消/改期/签到）强制使用该身份，防止 LLM 伪造他人身份越权。
 */

export interface ParsedIdentity {
  agentCode?: string;
  source: 'header' | 'bearer' | 'none';
}

const readAuthHeader = (req: { headers?: Record<string, string | string[] | undefined> }): string | undefined => {
  const raw = req.headers?.['authorization'];
  if (Array.isArray(raw)) return raw[0];
  return raw;
};

/** 只解码 JWT payload（不验签：与外层网关/本地转发的信任模型一致，取 sub 而非完整声明）。 */
const decodeJwtSub = (token: string): string | undefined => {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    const sub = typeof payload?.sub === 'string' ? payload.sub.trim() : undefined;
    return sub || undefined;
  } catch {
    return undefined;
  }
};

export function parseIdentity(req: { headers?: Record<string, string | string[] | undefined> }): ParsedIdentity {
  const rawHeaders = req.headers ?? {};
  const headerCode = rawHeaders['x-agent-code'] ?? rawHeaders['X-Agent-Code'];
  const headerValue = Array.isArray(headerCode) ? headerCode[0] : headerCode;
  const trimmed = headerValue?.trim();

  if (trimmed) {
    return { agentCode: trimmed, source: 'header' };
  }

  const auth = readAuthHeader(req)?.trim();
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const sub = decodeJwtSub(auth.slice(7).trim());
    if (sub) return { agentCode: sub, source: 'bearer' };
  }

  return { agentCode: undefined, source: 'none' };
}

/** 写操作工具：身份非空时强制覆盖 customer_id，匿名时允许显式传参（管理端调试）。 */
export function bindIdentity<T extends Record<string, unknown>>(
  input: T,
  identity: { agentCode?: string },
): T {
  if (!identity.agentCode) return input;
  const next = { ...input } as T & { customer_id?: unknown };
  // 无条件绑定：数字人身份即客户身份。对不消费 customer_id 的工具，
  // zod 默认 strip 未知字段，不会造成影响。
  next.customer_id = identity.agentCode;
  return next as T;
}