// vitest setup：在业务模块 import 之前先给假库地址，避免 loadConfig 抛错。
// 这些单测只测纯函数，不连库，所以地址永远用不到，只为通过顶层检查。
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5434/appointment_mcp_test';
process.env.MCP_HTTP_PORT ??= '4020';
process.env.TZ ??= 'Asia/Shanghai';
