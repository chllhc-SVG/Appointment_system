-- 008_customer_session_scope.sql
-- 会话作用域增强：把顾客会话绑定到数字人终端会话（X-Session-Id）。
-- 同一台数字人（agent_code 相同）并行多路对话时，各自的外部会话互不串号；
-- 单终端顺序接待（无外部会话 id）时仍按 agent 级唯一活跃会话解析。

ALTER TABLE customer_sessions
  ADD COLUMN IF NOT EXISTS external_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_customer_sessions_external
  ON customer_sessions(agent_code, external_session_id, status, expires_at DESC);

-- 识别来源：manual=对话内口头提供手机号；scan=小程序扫码身份直通
ALTER TABLE customer_sessions
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
