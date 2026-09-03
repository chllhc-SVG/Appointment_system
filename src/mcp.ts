import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appointmentTools } from './tools/tools.js';
import { bindIdentity } from './identity.js';

/**
 * 构建预约 MCP Server。
 * @param verifiedAgentCode 从 HTTP 层解析出的调用方数字人身份（X-Agent-Code / Bearer sub）。
 *   非空时：写操作/查询预约强制以该身份作为 customer_id，防止 LLM 伪造他人身份越权；
 *   为空时（管理端或直连调试）：保留工具参数中的 customer_id。
 */
export function createMcpServer(verifiedAgentCode?: string): McpServer {
  const server = new McpServer({ name: 'appointment-mcp', version: '1.0.0' });

  for (const tool of appointmentTools) {
    server.tool(tool.name, tool.description, tool.inputSchema.shape, async (input: unknown) => {
      const bound = bindIdentity(
        (input ?? {}) as Record<string, unknown>,
        { agentCode: verifiedAgentCode },
      ) as never;
      const result = await tool.handler(bound);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: { data: result },
      };
    });
  }

  return server;
}