import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { appointmentTools } from './tools/tools.js';
import { bindCustomerIdentity, parseIdentity, type ParsedIdentity } from './identity.js';
import { getActiveSession, getScanCustomerId, identifyCustomer } from './services/customer-identity.js';
import { toMcpToolDefinition, wrapToolError } from './utils.js';
import { wrapToolCall } from './services/mcp-call-log.js';

type TraceEvent = {
  id: string;
  timestamp: string;
  transport: 'streamable-http' | 'sse' | 'debug';
  agentCode?: string;
  method: string;
  toolName?: string;
  ok: boolean;
  error?: string;
};

const traceEvents: TraceEvent[] = [];

const trace = (event: Omit<TraceEvent, 'id' | 'timestamp'>) => {
  traceEvents.unshift({ id: randomUUID(), timestamp: new Date().toISOString(), ...event });
  traceEvents.splice(100);
};

/**
 * 工具执行前的身份绑定：
 *  - personal 模式：agent 身份即顾客身份（一人一数字人）；
 *  - shared 模式：顾客身份来自 manage_customer_session(action=identify) 的活跃会话；
 *    未识别时，顾客级工具直接返回 IDENTITY_REQUIRED 引导文案（fail-closed）。
 *  - 无 agent 身份（管理端/直连调试）：透传显式 customer_id，行为不变。
 *
 * 注意：manage_customer_session 是身份管理工具，必须放行（先建立身份，再查询/结束身份），
 * 只有消费顾客预约数据的工具才需要 fail-closed。
 */
// HA 风格精简集：顾客级工具（未识别顾客时 fail-closed 返回 IDENTITY_REQUIRED）
const CUSTOMER_SCOPED_TOOLS = new Set([
  'query_slots',
  'query_bookings',
  'manage_booking',
]);

// manage_booking 中面向顾客本人的动作（其余为员工/管理端动作，注入 agent 上下文即可）
const CUSTOMER_ACTIONS = new Set(['create', 'cancel', 'reschedule', 'check_in']);

const IDENTITY_REQUIRED_RESULT = {
  success: false,
  error_code: 'IDENTITY_REQUIRED',
  message: '当前是共享数字人终端，尚未识别您的顾客身份。请口语询问顾客手机号后调用 manage_customer_session(action=identify, customer_phone=...) 完成识别，再继续预约/查询/取消/改期。',
};

/** 会话作用域解析：优先外部会话（X-Session-Id），退回 agent 级活跃会话。 */
const resolveSessionCustomer = async (agentCode: string, sessionId?: string) => {
  const session = await getActiveSession(agentCode, sessionId);
  return session ? { customerId: session.customer_id } : null;
};

/** 动作级顾客作用域判定：manage_booking 仅面向顾客本人的动作需要身份，其余管理端动作放行。 */
const needsCustomerScope = (toolName: string, args: Record<string, unknown>) => {
  if (!CUSTOMER_SCOPED_TOOLS.has(toolName)) return false;
  if (toolName === 'manage_booking') {
    return typeof args.action === 'string' && CUSTOMER_ACTIONS.has(args.action);
  }
  return true;
};

const registerTools = (server: McpServer, identity: ParsedIdentity) => {
  for (const tool of appointmentTools) {
    server.tool(tool.name, tool.description, tool.inputSchema.shape, async (input: unknown) => {
      const args = (input ?? {}) as Record<string, unknown>;

      // 工具执行统一兜底：handler 抛出的异常（如 INVALID_DATE）必须转成结构化
      // JSON 返回给 LLM。裸异常文本会被 SDK 当作 tool result 原文下发，LLM 拿到
      // 非法 JSON 后无法理解错误原因，只能反复重试同样错误 → 数字人「思考中」空回
      // （线上复现：date:"明天" 直抛 INVALID_DATE 裸文本）。
      const runSafe = async (execute: () => Promise<unknown>) => {
        try {
          return await execute();
        } catch (error) {
          return wrapToolError(error);
        }
      };

      if (needsCustomerScope(tool.name, args)) {
        // 扫码直通：客户端已注入 X-Customer-Phone（小程序已确认的强身份）。
        // identifyCustomer 幂等：同手机号重复绑定为 no-op；不同顾客则顶替当前会话绑定。
        if (identity.customerPhone?.trim() && identity.agentCode) {
          const current = await getActiveSession(identity.agentCode, identity.sessionId);
          const sameCustomer = current && current.source === 'scan' && current.customer_id === (await getScanCustomerId(identity.customerPhone));
          if (!sameCustomer) {
            await identifyCustomer({
              agent_code: identity.agentCode,
              customer_phone: identity.customerPhone,
              customer_name: identity.customerName || undefined,
              external_session_id: identity.sessionId,
              source: 'scan',
            });
          }
        }

        const bound = await bindCustomerIdentity(args, identity, resolveSessionCustomer);
        if (bound.needsIdentification) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(IDENTITY_REQUIRED_RESULT, null, 2) }],
            structuredContent: { data: IDENTITY_REQUIRED_RESULT },
          };
        }
        const withCustomer = { ...args, customer_id: bound.customerId, agent_code: identity.agentCode } as Record<string, unknown>;
        const result = await wrapToolCall({
          transport: 'streamable-http',
          agentCode: identity.agentCode,
          toolName: tool.name,
          args,
          execute: () => runSafe(() => tool.handler(withCustomer as never)),
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], structuredContent: { data: result } };
      }

      // 身份管理工具与非顾客级工具：注入 agent 上下文（operator/agent_code），不改写 customer_id
      const withAgent = identity.agentCode
        ? { ...args, agent_code: identity.agentCode, external_session_id: identity.sessionId }
        : args;
      const result = await wrapToolCall({
        transport: 'streamable-http',
        agentCode: identity.agentCode,
        toolName: tool.name,
        args,
        execute: () => runSafe(() => tool.handler(withAgent as never)),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], structuredContent: { data: result } };
    });
  }
};

const createServer = (identity: ParsedIdentity) => {
  const server = new McpServer({ name: 'appointment-mcp', version: '1.0.0' });
  registerTools(server, identity);
  return server;
};

const serverInfo = () => ({ name: 'appointment-mcp', version: '1.0.0' });

const sendSse = (res: Response, event: string, data: unknown) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const jsonRpcResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const jsonRpcError = (id: unknown, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

const handleLegacyJsonRpc = async (req: Request, body: Record<string, unknown>) => {
  const method = typeof body.method === 'string' ? body.method : '';
  const id = body.id;
  const identity = parseIdentity(req);

  try {
    if (method === 'initialize') {
      trace({ transport: 'sse', agentCode: identity.agentCode, method, ok: true });
      return jsonRpcResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: true } },
        serverInfo: serverInfo(),
      });
    }

    if (method === 'notifications/initialized') {
      trace({ transport: 'sse', agentCode: identity.agentCode, method, ok: true });
      return undefined;
    }

    if (method === 'tools/list') {
      trace({ transport: 'sse', agentCode: identity.agentCode, method, ok: true });
      return jsonRpcResult(id, { tools: appointmentTools.map(toMcpToolDefinition) });
    }

    if (method === 'tools/call') {
      const params = body.params && typeof body.params === 'object' ? body.params as Record<string, unknown> : {};
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = appointmentTools.find((item) => item.name === toolName);
      if (!tool) {
        trace({ transport: 'sse', agentCode: identity.agentCode, method, toolName, ok: false, error: `unknown_tool:${toolName}` });
        return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;

      try {
        let executeArgs: Record<string, unknown> = args;

        if (needsCustomerScope(tool.name, args)) {
          // 扫码直通：identifyCustomer 幂等——同手机号 no-op，不同顾客顶替当前会话绑定
          if (identity.customerPhone?.trim() && identity.agentCode) {
            const current = await getActiveSession(identity.agentCode, identity.sessionId);
            const sameCustomer = current && current.source === 'scan' && current.customer_id === (await getScanCustomerId(identity.customerPhone));
            if (!sameCustomer) {
              await identifyCustomer({
                agent_code: identity.agentCode,
                customer_phone: identity.customerPhone,
                customer_name: identity.customerName || undefined,
                external_session_id: identity.sessionId,
                source: 'scan',
              });
            }
          }

          const bound = await bindCustomerIdentity(args, identity, resolveSessionCustomer);
          if (bound.needsIdentification) {
            trace({ transport: 'sse', agentCode: identity.agentCode, method, toolName, ok: true, error: 'identity_required' });
            return jsonRpcResult(id, IDENTITY_REQUIRED_RESULT);
          }
          executeArgs = { ...args, customer_id: bound.customerId, agent_code: identity.agentCode };
        } else if (identity.agentCode) {
          executeArgs = { ...args, agent_code: identity.agentCode, external_session_id: identity.sessionId };
        }

        const result = await wrapToolCall({
          transport: 'sse',
          agentCode: identity.agentCode,
          toolName,
          args,
          execute: () => tool.handler(executeArgs as never),
        });
        trace({ transport: 'sse', agentCode: identity.agentCode, method, toolName, ok: true });
        return jsonRpcResult(id, result);
      } catch (error) {
        trace({ transport: 'sse', agentCode: identity.agentCode, method, toolName, ok: false, error: error instanceof Error ? error.message : String(error) });
        return jsonRpcResult(id, wrapToolError(error));
      }
    }

    if (method === 'ping') {
      trace({ transport: 'sse', agentCode: identity.agentCode, method, ok: true });
      return jsonRpcResult(id, {});
    }

    trace({ transport: 'sse', agentCode: identity.agentCode, method, ok: false, error: 'method_not_found' });
    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    trace({ transport: 'sse', agentCode: identity.agentCode, method, ok: false, error: error instanceof Error ? error.message : String(error) });
    return jsonRpcError(id, -32603, 'MCP request failed', { message: error instanceof Error ? error.message : String(error) });
  }
};

export function createMcpHttpRouter(): express.Router {
  const router = express.Router();

  router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, X-Agent-Code, X-Session-Id, X-Customer-Phone, X-Customer-Name');
    res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  router.get('/healthz', (req, res) => {
    const identity = parseIdentity(req);
    res.json({
      ok: true,
      service: 'appointment-mcp-http',
      endpoint: '/mcp',
      agent: identity.agentCode ?? 'anonymous',
      tools: appointmentTools.map((tool) => tool.name),
    });
  });

  router.get('/debug', (_req, res) => {
    res.json({ ok: true, recent: traceEvents });
  });

  router.post('/', async (req: Request, res: Response) => {
    const identity = parseIdentity(req);
    const server = createServer(identity);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error: unknown) {
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json(jsonRpcError((req.body as { id?: unknown })?.id, -32603, `MCP request failed: ${message}`));
      }
    }
  });

  router.get('/', (req: Request, res: Response) => {
    const sessionId = randomUUID();
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Mcp-Session-Id', sessionId);
    sendSse(res, 'endpoint', { url: `/mcp/messages?session_id=${sessionId}` });
    sendSse(res, 'message', jsonRpcResult(null, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: true } },
      serverInfo: serverInfo(),
    }));
    const identity = parseIdentity(req);
    trace({ transport: 'sse', agentCode: identity.agentCode, method: 'connect', ok: true });
    req.on('close', () => {});
  });

  router.post('/messages', async (req: Request, res: Response) => {
    const response = await handleLegacyJsonRpc(req, req.body ?? {});
    if (!response) {
      res.status(202).end();
      return;
    }
    res.json(response);
  });

  router.delete('/', (_req, res) => {
    res.status(202).end();
  });

  return router;
}
