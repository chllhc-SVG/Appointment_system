-- 009_perf_indexes.sql
-- MCP 工具调用耗时优化：只补真正缺的索引，全部 IF NOT EXISTS，重复执行安全。
-- 注意：本文件由 src/db/migrate.ts 整段 pool.query() 执行（隐式事务），
-- 因此这里不能用 CREATE INDEX CONCURRENTLY；线上表仅几十~几千行，
-- 普通建索引是毫秒级，若将来数据量大可单独在 psql 里用 CONCURRENTLY 重建。

-- 建单幂等兜底查询：customer_id + service_id + staff_id + start_at 四元组
-- （appointments 上现有 customer_id 单列索引选择性不足，OR 拆分后第二段用它）
CREATE INDEX IF NOT EXISTS idx_appointments_idem4
  ON appointments(customer_id, service_id, staff_id, start_at);

-- 错放回收的员工名排除查询（recoverMisplacedStoreName）
CREATE INDEX IF NOT EXISTS idx_staff_name_active
  ON staff(name) WHERE is_active = true;

-- 门店名匹配：在营门店按名排序（findStoreByNameFlexible / listStores）
CREATE INDEX IF NOT EXISTS idx_stores_active_name
  ON stores(is_active, name);

-- 可约时段计算：只扫 available 排班（listStaffSchedulesBulk / isWithinAvailableSchedule）
CREATE INDEX IF NOT EXISTS idx_schedules_available
  ON staff_schedules(staff_id, start_at, end_at) WHERE status = 'available';
