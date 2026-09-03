-- 006_store_services.sql
-- 门店与可服务项目的多对多关联：
-- 门店通过勾选知识库项目管理中的项目（按分类）声明"本店能做什么项目"。
CREATE TABLE IF NOT EXISTS store_services (
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (store_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_store_services_service
  ON store_services(service_id, store_id);