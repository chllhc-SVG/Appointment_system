-- 005_admin_catalog.sql
-- 1) services 增加“来源/同步”字段，支撑“仅知识库项目管理的项目可预约”的业务约束
ALTER TABLE IF EXISTS services
  ADD COLUMN IF NOT EXISTS source_system TEXT NOT NULL DEFAULT 'manual',   -- knowledge_base | manual
  ADD COLUMN IF NOT EXISTS source_key TEXT,                                 -- 知识库项目 id
  ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'local',       -- local | synced | pending | failed
  ADD COLUMN IF NOT EXISTS sync_error TEXT,
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_payload JSONB,
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_services_source
  ON services(source_system, sync_status);

-- 2) 基础资料审计表：门店 / 员工 / 服务的增删改留痕
CREATE TABLE IF NOT EXISTS entity_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,          -- store | staff | service
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,               -- create | update | deactivate | activate | delete | sync
  operator TEXT,
  before_data JSONB,
  after_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entity_audits_entity
  ON entity_audits(entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_audits_time
  ON entity_audits(created_at DESC);

-- 3) 知识库同步运行记录
CREATE TABLE IF NOT EXISTS sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system TEXT NOT NULL DEFAULT 'knowledge_base',
  status TEXT NOT NULL DEFAULT 'success',          -- success | partial | failed
  total INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  deactivated INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_time
  ON sync_runs(started_at DESC);