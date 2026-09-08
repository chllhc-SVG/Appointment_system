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

/** 门店维度的排班视图（含员工名），供管理后台日历展示 */
export interface StaffScheduleWithStaff extends StaffSchedule {
  staff_name: string;
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
  /** 东八区本地时间（YYYY-MM-DD HH:mm），供数字人直接向用户口播，避免把 UTC 误读成凌晨 */
  start_local: string;
  end_local: string;
}

export interface CreateAppointmentInput {
  service_id?: string;
  store_id?: string;
  staff_id?: string;
  /** 门店名（用户直接说门店名时传，服务端模糊解析） */
  store_name?: string;
  /** 员工名（用户指定员工时传，服务端在门店内按名字解析） */
  staff_name?: string;
  start_at?: string;
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
  /** 门店名（数字人用户直接说"上海徐汇门店"时传，服务端模糊解析） */
  store_name?: string;
  date: string;
  preferred_staff_id?: string;
  /** 指定员工名（如"李美容师"），与 preferred_staff_id 二选一 */
  preferred_staff_name?: string;
}

export interface RescheduleAppointmentInput {
  appointment_id?: string;
  appointment_code?: string;
  customer_id?: string;
  new_start_at: string;
  idempotency_key?: string;
  /** 无预约码时按条件定位本人预约（按项目/日期/状态） */
  service_id?: string;
  service_name?: string;
  status?: AppointmentStatus;
  from_date?: string;
  to_date?: string;
}

export interface CancelAppointmentInput {
  appointment_id?: string;
  appointment_code?: string;
  customer_id?: string;
  reason?: string;
  idempotency_key?: string;
  /** 无预约码时按条件定位本人预约（按项目/日期/状态） */
  service_id?: string;
  service_name?: string;
  status?: AppointmentStatus;
  from_date?: string;
  to_date?: string;
}

export interface QueryAppointmentsInput {
  customer_id?: string;
  from_date?: string;
  to_date?: string;
  status?: AppointmentStatus;
  /** 按项目名筛选（ILKE 模糊匹配） */
  service_name?: string;
  /** 关键字：匹配预约码、项目名、员工名 */
  keyword?: string;
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

/** 门店维度排班查询（管理后台日历用） */
export interface ListStoreSchedulesInput {
  store_id: string;
  date_from: string;
  date_to: string;
  /** 可选：只看某个员工 */
  staff_id?: string;
}

/** 按天建/改排班：一天一个或多个班次（早晚班），以日期+门店+员工定位 */
export interface UpsertDaySchedulesInput {
  store_id: string;
  staff_id: string;
  date: string;
  /** 该天的班次列表（本地时区 HH:mm），如 [{start:"09:00",end:"12:00"},{start:"13:00",end:"18:00"}] */
  shifts: Array<{ start: string; end: string; status?: ScheduleStatus }>;
  operator?: string;
}

/** 按天删除排班：删除该员工该天的全部（或指定开始时间）班次 */
export interface DeleteDaySchedulesInput {
  store_id: string;
  staff_id: string;
  date: string;
  /** 省略则删除该天全部班次；传 "09:00" 则只删匹配班次 */
  start?: string;
  operator?: string;
}

export interface ListAppointmentAuditsInput {
  customer_id: string;
  appointment_id?: string;
  appointment_code?: string;
}
