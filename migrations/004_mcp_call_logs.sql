-- 004_mcp_call_logs.sql
-- 大模型/数字人通过 MCP 调用工具的完整记录。
-- 每次 tools/call 落一行：调用方身份、工具、参数、结果、耗时与成败，
-- 供前端"日志中心"可视化与问题排查，也用于统计数字人的真实使用情况。

CREATE TABLE IF NOT EXISTS mcp_call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'streamable-http',
  agent_code TEXT,
  tool_name TEXT NOT NULL,
  arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  success BOOLEAN NOT NULL,
  error_code TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_created_at
  ON mcp_call_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_agent_time
  ON mcp_call_logs(agent_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_tool_time
  ON mcp_call_logs(tool_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_success_time
  ON mcp_call_logs(success, created_at DESC);
