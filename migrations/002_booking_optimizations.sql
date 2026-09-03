-- 002_booking_optimizations.sql
-- 预约系统第二版优化：状态机约束、幂等操作表、查询索引补全。

-- 1) 预约状态只允许已知值（数据库层防脏数据）
ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS chk_appointments_status;

ALTER TABLE appointments
  ADD CONSTRAINT chk_appointments_status
  CHECK (status IN ('pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show'));

-- 2) 排班状态只允许已知值
ALTER TABLE staff_schedules
  DROP CONSTRAINT IF EXISTS chk_staff_schedules_status;

ALTER TABLE staff_schedules
  ADD CONSTRAINT chk_staff_schedules_status
  CHECK (status IN ('available', 'unavailable', 'break'));

-- 3) 幂等操作表：让取消/改期/签到/完成/爽约等写操作可重复调用且结果一致。
--    数字人端在超时重试时传同一个 idempotency_key，系统返回首次执行的结果，不重复生效。
CREATE TABLE IF NOT EXISTS appointment_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key TEXT NOT NULL UNIQUE,
  appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'applied',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appointment_operations_appointment_id
  ON appointment_operations(appointment_id, created_at DESC);

-- 4) 员工技能按服务反向查询的索引
CREATE INDEX IF NOT EXISTS idx_staff_service_skills_service_id
  ON staff_service_skills(service_id);

-- 5) 门店员工按门店查询的索引（已有 idx_staff_store_id 的补充复合）
CREATE INDEX IF NOT EXISTS idx_staff_store_active
  ON staff(store_id, is_active);

-- 6) 客户手机号查询预约（改期/提醒场景）
CREATE INDEX IF NOT EXISTS idx_appointments_customer_phone
  ON appointments(customer_phone);

-- 7) 员工某时间段预约快速查询（排班冲突校验热路径）
CREATE INDEX IF NOT EXISTS idx_appointments_staff_status_range
  ON appointments(staff_id, status, start_at, end_at);