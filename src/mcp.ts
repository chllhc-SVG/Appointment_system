import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appointmentTools } from './tools/tools.js';
import { bindCustomerIdentity, type ParsedIdentity } from './identity.js';
import { getActiveSession } from './services/customer-identity.js';

/**
 * 构建预约 MCP Server（独立实例，供特定宿主复用）。
 * @param identity 数字人身份（agentCode 取自 X-Agent-Code / Bearer sub，sessionId 取自 X-Session-Id）。
 *   personal 模式：agent 身份即顾客身份；
 *   shared 模式：顾客身份来自 manage_customer_session(action=identify) 的活跃会话（外部会话作用域优先），
 *   未识别时顾客级工具返回 IDENTITY_REQUIRED（fail-closed）。
 */
export function createMcpServer(identity: ParsedIdentity = { source: 'none' }): McpServer {
  const server = new McpServer({ name: 'appointment-mcp', version: '1.0.0' });

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
    message: '当前是共享数字人终端，尚未识别顾客身份。请先调用 manage_customer_session(action=identify, customer_phone=...) 完成识别。',
  };

  const resolveSessionCustomer = async (agentCode: string, sessionId?: string) => {
    const session = await getActiveSession(agentCode, sessionId);
    return session ? { customerId: session.customer_id } : null;
  };

  const needsCustomerScope = (toolName: string, args: Record<string, unknown>) => {
    if (!CUSTOMER_SCOPED_TOOLS.has(toolName)) return false;
    if (toolName === 'manage_booking') {
      return typeof args.action === 'string' && CUSTOMER_ACTIONS.has(args.action);
    }
    return true;
  };

  for (const tool of appointmentTools) {
    server.tool(tool.name, tool.description, tool.inputSchema.shape, async (input: unknown) => {
      const args = (input ?? {}) as Record<string, unknown>;
      let executeArgs: Record<string, unknown> = args;

      if (needsCustomerScope(tool.name, args)) {
        const bound = await bindCustomerIdentity(args, identity, resolveSessionCustomer);
        if (bound.needsIdentification) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(IDENTITY_REQUIRED_RESULT, null, 2) }],
            structuredContent: { data: IDENTITY_REQUIRED_RESULT },
          };
        }
        executeArgs = { ...args, customer_id: bound.customerId, agent_code: identity.agentCode };
      } else if (identity.agentCode) {
        executeArgs = { ...args, agent_code: identity.agentCode, external_session_id: identity.sessionId };
      }

      const result = await tool.handler(executeArgs as never);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: { data: result },
      };
    });
  }

  return server;
}
