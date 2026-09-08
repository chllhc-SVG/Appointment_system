-- 007_customer_identity.sql
-- 双层身份模型：数字人（agent）与顾客（customer）分离。
-- 共享终端场景（如一楼门店公共数字人 hsh）下，同一 agent 依次服务不同真实顾客，
-- 顾客身份通过 identify_customer（手机号/会员码）建立会话级绑定，而非沿用 agent 身份。

CREATE TABLE IF NOT EXISTS customer_sessions (
  id           TEXT PRIMARY KEY,
  agent_code   TEXT NOT NULL,
  customer_id  TEXT NOT NULL,
  customer_name TEXT,
  display_name TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  identified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_sessions_agent_active
  ON customer_sessions(agent_code, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer
  ON customer_sessions(customer_id, identified_at DESC);

-- 顾客资料表：identify 建立的顾客档案（手机号为唯一业务键，仅存哈希 + 摘要，避免明文落库）
CREATE TABLE IF NOT EXISTS customer_profiles (
  customer_id   TEXT PRIMARY KEY,
  phone_hash    TEXT NOT NULL UNIQUE,
  phone_masked  TEXT NOT NULL,
  display_name  TEXT,
  source        TEXT NOT NULL DEFAULT 'digital_human',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
