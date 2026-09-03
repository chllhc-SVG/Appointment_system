import { appointmentTools } from './tools/tools.js';
import { bindIdentity } from './identity.js';
import { toMcpToolDefinition, wrapToolError } from './utils.js';
import { wrapToolCall } from './services/mcp-call-log.js';
import type { z } from 'zod';

/**
 * stdio 模式 MCP 传输（Content-Length 帧协议），
 * 与 @modelcontextprotocol/sdk 的 stdio 客户端兼容，供本地数字人进程直接拉起。
 */

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const jsonRpcResult = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const jsonRpcError = (id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

const parseParams = (params: unknown) => (params && typeof params === 'object' ? params as Record<string, unknown> : {});

export function startMcpStdio(opts?: { verifiedAgentCode?: string; tools?: typeof appointmentTools }): void {
  const tools = opts?.tools ?? appointmentTools;
  const verifiedAgentCode = opts?.verifiedAgentCode;

  const handleRequest = async (request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> => {
    if (!request || request.jsonrpc !== '2.0') return undefined;

    const id = request.id ?? null;
    const params = parseParams(request.params);

    if (request.method === 'initialize') {
      return jsonRpcResult(id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'appointment-mcp', version: '1.0.0' },
        capabilities: { tools: {} },
      });
    }

    if (request.method === 'notifications/initialized') {
      return undefined;
    }

    if (request.method === 'tools/list') {
      return jsonRpcResult(id, { tools: tools.map(toMcpToolDefinition) });
    }

    if (request.method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : undefined;
      if (!toolName) return jsonRpcError(id, -32602, 'Missing tool name');
      const tool = tools.find((item) => item.name === toolName);
      if (!tool) return jsonRpcError(id, -32601, `Tool not found: ${toolName}`);
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      try {
        const bound = bindIdentity(args, { agentCode: verifiedAgentCode });
        const result = await wrapToolCall({
          transport: 'stdio',
          agentCode: verifiedAgentCode,
          toolName,
          args,
          execute: () => tool.handler(bound as never),
        });
        return jsonRpcResult(id, result);
      } catch (error) {
        return jsonRpcResult(id, wrapToolError(error));
      }
    }

    if (request.method === 'ping') {
      return jsonRpcResult(id, {});
    }

    if (id !== null) {
      return jsonRpcError(id, -32601, `Method not found: ${request.method}`);
    }
    return undefined;
  };

  const transport = new StdioJsonRpcTransport(handleRequest);
  transport.start();
  process.stdin.resume();
}

class StdioJsonRpcTransport {
  private buffer = Buffer.alloc(0);

  constructor(private readonly onRequest: (request: JsonRpcRequest) => Promise<JsonRpcResponse | undefined>) {}

  start() {
    process.stdin.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const headerText = this.buffer.slice(0, headerEnd).toString('utf8');
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(match[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) return;

      const body = this.buffer.slice(messageStart, messageEnd).toString('utf8');
      this.buffer = this.buffer.slice(messageEnd);

      let request: JsonRpcRequest | undefined;
      try {
        request = JSON.parse(body) as JsonRpcRequest;
      } catch {
        continue;
      }

      const response = await this.onRequest(request);
      if (response) this.write(response);
    }
  }

  write(message: JsonRpcResponse) {
    const jsonMessage = JSON.stringify(message);
    const payload = `Content-Length: ${Buffer.byteLength(jsonMessage, 'utf8')}\r\n\r\n${jsonMessage}`;
    process.stdout.write(payload);
  }
}

export type { z };