export type AppointmentStatus =
  | 'pending'
  | 'confirmed'
  | 'checked_in'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export type ScheduleStatus =
  | 'available'
  | 'unavailable'
  | 'break';

export type OperatorType =
  | 'customer'
  | 'staff'
  | 'system';

export type AuditAction =
  | 'create'
  | 'confirm'
  | 'cancel'
  | 'reschedule'
  | 'check_in'
  | 'complete'
  | 'no_show';

export interface Store {
  id: string;
  name: string;
  timezone: string;
  is_active: boolean;
  /** 本店可做的服务项目 id（来自知识库项目管理勾选） */
  service_ids?: string[];
  created_at: string;
  updated_at: string;
}

export interface Staff {
  id: string;
  store_id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface StaffWithSkills extends Staff {
  service_ids: string[];
  service_names: string[];
}

export interface Service {
  id: string;
  name: string;
  duration_minutes: number;
  price_cents?: number;
  is_active: boolean;
  /** 来源系统：knowledge_base（来自知识库项目管理）| manual（手工维护，不可预约） */
  source_system: string;
  /** 知识库项目 id（source_system = knowledge_base 时） */
  source_key?: string | null;
  sync_status: string;
  sync_error?: string | null;
  last_synced_at?: string | null;
  sync_payload?: Record<string, unknown> | null;
  category?: string | null;
  aliases?: string[];
  created_at: string;
  updated_at: string;
}

export interface ServiceWithStats extends Service {
  store_count?: number;
  staff_count?: number;
}

export interface StaffSchedule {
  id: string;
  staff_id: string;
  start_at: string;
  end_at: string;
  status: ScheduleStatus;
  created_at: string;
  updated_at: string;
}

export interface Appointment {
  id: string;
  appointment_code: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string;
  store_id: string;
  staff_id: string;
  service_id: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  idempotency_key: string;
  note?: string;
  created_at: string;
  updated_at: string;
}

export interface AppointmentAudit {
  id: string;
  appointment_id: string;
  operator_type: OperatorType;
  operator_id: string;
  action: AuditAction;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  created_at: string;
}

export interface AppointmentDetail {
  appointment: Appointment;
  store?: Store;
  staff?: Staff;
  service?: Service;
  audits?: AppointmentAudit[];
}

export interface TimeSlot {
  staff_id: string;
  staff_name: string;
  start_at: string;
  end_at: string;
}

export interface CreateAppointmentInput {
  service_id: string;
  store_id: string;
  staff_id: string;
  start_at: string;
  customer_name?: string;
  customer_phone?: string;
  customer_id?: string;
  note?: string;
  idempotency_key?: string;
  /** 服务名称（可选）：传了则由服务端按名称解析 service_id，供数字人直接说项目名预约 */
  service_name?: string;
}

export interface SearchSlotsInput {
  service_id?: string;
  service_name?: string;
  store_id?: string;
  date: string;
  preferred_staff_id?: string;
}

export interface RescheduleAppointmentInput {
  appointment_id?: string;
  appointment_code?: string;
  customer_id?: string;
  new_start_at: string;
  idempotency_key?: string;
}

export interface CancelAppointmentInput {
  appointment_id?: string;
  appointment_code?: string;
  customer_id?: string;
  reason?: string;
  idempotency_key?: string;
}

export interface QueryAppointmentsInput {
  customer_id?: string;
  from_date?: string;
  to_date?: string;
  status?: AppointmentStatus;
}

export interface ListStoresInput {
  active_only?: boolean;
  keyword?: string;
  limit?: number;
}

export interface ListServicesInput {
  store_id?: string;
  keyword?: string;
  active_only?: boolean;
  limit?: number;
}

export interface ListStaffInput {
  store_id?: string;
  service_id?: string;
  keyword?: string;
  active_only?: boolean;
  limit?: number;
}

export interface AppointmentDetailInput {
  customer_id: string;
  appointment_id?: string;
  appointment_code?: string;
}

export interface ListStaffSchedulesInput {
  staff_id: string;
  date_from: string;
  date_to: string;
}

export interface ListAppointmentAuditsInput {
  customer_id: string;
  appointment_id?: string;
  appointment_code?: string;
}
