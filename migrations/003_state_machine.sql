-- 003_state_machine.sql
-- 预约状态机在数据库层强制落地：
--   1) appointment_status_transitions 表声明唯一合法迁移；
--   2) 触发器在 UPDATE 时校验，非法迁移直接抛错回滚；
--   3) 服务层返回友好错误码，数据库层做最终防线。

CREATE TABLE IF NOT EXISTS appointment_status_transitions (
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  operator_type TEXT NOT NULL DEFAULT 'system',
  note TEXT,
  PRIMARY KEY (from_status, to_status)
);

TRUNCATE appointment_status_transitions;

INSERT INTO appointment_status_transitions (from_status, to_status, operator_type, note) VALUES
  ('pending',    'confirmed',  'staff',    '门店确认预约'),
  ('pending',    'cancelled',  'customer', '客户取消'),
  ('confirmed',  'checked_in', 'staff',    '到店签到'),
  ('confirmed',  'cancelled',  'customer', '客户取消'),
  ('confirmed',  'no_show',    'staff',    '爽约标记'),
  ('checked_in', 'completed',  'staff',    '服务完成'),
  ('checked_in', 'cancelled',  'staff',    '到店后取消');
  -- 终态不再允许任何迁移：completed / cancelled / no_show

CREATE OR REPLACE FUNCTION enforce_appointment_status_transition()
RETURNS trigger AS $$
DECLARE
  exists_count INTEGER;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO exists_count
  FROM appointment_status_transitions
  WHERE from_status = OLD.status
    AND to_status = NEW.status;

  IF exists_count = 0 THEN
    RAISE EXCEPTION 'invalid appointment status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_appointments_status_transition ON appointments;
CREATE TRIGGER trg_appointments_status_transition
  BEFORE UPDATE OF status ON appointments
  FOR EACH ROW
  EXECUTE FUNCTION enforce_appointment_status_transition();

-- 服务端时间校验：预约开始时间不能晚于结束时间（冗余保险，索引友好）
ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS chk_appointments_time_sane;

ALTER TABLE appointments
  ADD CONSTRAINT chk_appointments_time_sane
  CHECK (end_at > start_at);

-- 到店后不允许客户侧直接取消/改期（can_cancel 由服务层计算，索引友好）
CREATE INDEX IF NOT EXISTS idx_appointments_customer_status_time
  ON appointments(customer_id, status, start_at);