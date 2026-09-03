import { z } from 'zod';
import {
  cancelAppointment,
  checkInAppointment,
  completeAppointment,
  confirmAppointment,
  createAppointment,
  getAppointmentByIdentifier,
  getAppointmentOverview,
  getMyAppointments,
  listAppointmentAudits,
  listAppointments,
  listBookingReferenceData,
  listStaffAvailability,
  listStoreServices,
  listStoreStaff,
  markNoShowAppointment,
  rescheduleAppointment,
  searchAvailableSlots,
} from '../services/appointments.js';

export const searchAvailableSlotsInput = z.object({
  service_id: z.string().min(1).optional(),
  service_name: z.string().min(1).optional(),
  store_id: z.string().min(1).optional(),
  date: z.string().min(1).describe('日期，格式建议 YYYY-MM-DD'),
  preferred_staff_id: z.string().min(1).optional(),
}).describe('用于数字人把“我想预约某个项目”先转成可用时段');

export const createAppointmentInput = z.object({
  service_id: z.string().min(1).optional(),
  service_name: z.string().min(1).describe('项目名，如“小气泡”“皮肤管理”。数字人从用户话术中提取后传入，服务端自动解析'),
  store_id: z.string().min(1),
  staff_id: z.string().min(1),
  start_at: z.string().min(1).describe('ISO 8601 格式，从 search_available_slots 的结果中获取'),
  customer_name: z.string().min(1).optional(),
  customer_phone: z.string().min(1).optional(),
  customer_id: z.string().min(1).optional(),
  note: z.string().optional(),
  idempotency_key: z.string().min(1).optional().describe('幂等键，不传则服务端按“客户+项目+员工+时间”自动生成，重复调用不会创建重复预约'),
}).describe('数字人预约流程：① 先调 search_available_slots 查可用时段；② 向用户确认后调本工具创建；③ 身份由上下文自动注入，无需传 customer_id');

export const getMyAppointmentsInput = z.object({
  customer_id: z.string().min(1).optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  status: z.enum(['pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show']).optional(),
  service_name: z.string().optional().describe('按项目名筛选（如"小气泡"），LLM 从用户话术中提取'),
  keyword: z.string().optional().describe('关键字：匹配预约码、项目名、员工名'),
});

export const listAppointmentsInput = z.object({
  customer_id: z.string().optional(),
  store_id: z.string().optional(),
  staff_id: z.string().optional(),
  service_id: z.string().optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  status: z.enum(['pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show']).optional(),
  keyword: z.string().optional(),
  service_name: z.string().optional().describe('按项目名筛选（如"小气泡"），LLM 从用户话术中提取'),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

export const cancelAppointmentInput = z.object({
  appointment_id: z.string().min(1).optional(),
  appointment_code: z.string().min(1).optional(),
  customer_id: z.string().min(1).optional(),
  reason: z.string().optional(),
  idempotency_key: z.string().min(1).optional(),
  service_id: z.string().optional(),
  service_name: z.string().optional(),
  status: z.enum(['pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show']).optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

export const rescheduleAppointmentInput = z.object({
  appointment_id: z.string().min(1).optional(),
  appointment_code: z.string().min(1).optional(),
  customer_id: z.string().min(1).optional(),
  new_start_at: z.string().min(1),
  idempotency_key: z.string().min(1).optional(),
  service_id: z.string().optional(),
  service_name: z.string().optional(),
  status: z.enum(['pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show']).optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

export const listBookingReferenceDataInput = z.object({
  active_only: z.boolean().optional(),
  keyword: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  store_id: z.string().optional(),
  service_id: z.string().optional(),
});

export const listStoreServicesInput = z.object({
  store_id: z.string().min(1),
  keyword: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const listStoreStaffInput = z.object({
  store_id: z.string().min(1),
  service_id: z.string().optional(),
  keyword: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const listStaffAvailabilityInput = z.object({
  staff_id: z.string().min(1),
  date_from: z.string().min(1),
  date_to: z.string().min(1),
});

export const appointmentIdentifierInput = z.object({
  customer_id: z.string().min(1).optional(),
  appointment_id: z.string().optional(),
  appointment_code: z.string().optional(),
});

export const appointmentAuditInput = appointmentIdentifierInput;

export const checkInAppointmentInput = z.object({
  appointment_id: z.string().min(1),
  customer_id: z.string().min(1).optional(),
  operator_id: z.string().optional(),
});

export const completeAppointmentInput = z.object({
  appointment_id: z.string().min(1),
  operator_id: z.string().optional(),
});

export const markNoShowAppointmentInput = z.object({
  appointment_id: z.string().min(1),
  operator_id: z.string().optional(),
});

export const confirmAppointmentInput = z.object({
  appointment_id: z.string().min(1),
  operator_id: z.string().optional(),
});

export const appointmentOverviewInput = z.object({
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  store_id: z.string().optional(),
});

export const appointmentTools = [
  {
    name: 'search_available_slots',
    description: '查询指定服务在某天可预约的时段，返回可用员工与时间槽。支持直接传 service_name（如"皮肤管理"），数字人可先用 list_booking_reference_data / list_store_services 拿到项目名；如果用户说的是某门店里的项目，优先把 store_id 一起传入，服务端会自动限制为该店可做项目。',
    inputSchema: searchAvailableSlotsInput,
    handler: searchAvailableSlots,
  },
  {
    name: 'create_appointment',
    description: '创建预约，必须在用户明确确认后调用。支持传 service_name（项目名）+ store_id + staff_id + start_at，或 service_id。数字人如果是“预约某个项目”，先调用 search_available_slots 再创建；idempotency_key 可不传（服务端按"客户+项目+员工+时间"自动幂等）。身份来自调用上下文（X-Agent-Code / Bearer sub），无需自行传 customer_id。',
    inputSchema: createAppointmentInput,
    handler: createAppointment,
  },
  {
    name: 'get_my_appointments',
    description: '查看当前用户自己的预约列表。数字人识别到“查看预约 / 看我某个项目的预约 / 我最近的预约 / 我某天的预约”时优先调用这个工具；无需传 customer_id，身份从上下文自动注入。支持 from_date/to_date/status/service_name/keyword 过滤。',
    inputSchema: getMyAppointmentsInput,
    handler: getMyAppointments,
  },
  {
    name: 'get_appointment_detail',
    description: '查看当前用户某一条预约详情。数字人听到“这个预约详情 / 订单详情 / 预约码是xxx”时调用；优先用 appointment_code 定位，拿到门店、员工、项目与审计轨迹。',
    inputSchema: appointmentIdentifierInput,
    handler: getAppointmentByIdentifier,
  },
  {
    name: 'cancel_appointment',
    description: '取消当前用户自己的预约。数字人听到“取消这个预约 / 取消小气泡 / 帮我退掉这次预约”时调用；支持 appointment_id、appointment_code，或结合 service_name/service_id + 日期范围从本人预约中自动定位。仅 pending/confirmed 可取消。',
    inputSchema: cancelAppointmentInput,
    handler: cancelAppointment,
  },
  {
    name: 'reschedule_appointment',
    description: '修改当前用户自己的预约时间。数字人听到“改到明天上午 / 改期 / 换个时间”时调用；传 appointment_id 或 appointment_code + new_start_at。若用户只说项目名，可结合 service_name/service_id + 日期范围定位对应预约。',
    inputSchema: rescheduleAppointmentInput,
    handler: rescheduleAppointment,
  },
  {
    name: 'list_booking_reference_data',
    description: '列出预约业务基础数据：门店、项目和员工，用于数字人在预约前推荐与筛选。',
    inputSchema: listBookingReferenceDataInput,
    handler: listBookingReferenceData,
  },
  {
    name: 'list_store_services',
    description: '列出某门店可预约项目。',
    inputSchema: listStoreServicesInput,
    handler: listStoreServices,
  },
  {
    name: 'list_store_staff',
    description: '列出某门店员工及其可服务项目。',
    inputSchema: listStoreStaffInput,
    handler: listStoreStaff,
  },
  {
    name: 'list_staff_availability',
    description: '查询员工在指定时间范围内的排班。',
    inputSchema: listStaffAvailabilityInput,
    handler: listStaffAvailability,
  },
  {
    name: 'list_appointments',
    description: '按条件查询预约列表（支持门店/员工/项目/状态/日期/关键字过滤）。',
    inputSchema: listAppointmentsInput,
    handler: listAppointments,
  },
  {
    name: 'get_appointment_overview',
    description: '查询预约概览统计：总量及各状态数量。',
    inputSchema: appointmentOverviewInput,
    handler: getAppointmentOverview,
  },
  {
    name: 'list_appointment_audits',
    description: '查询预约审计轨迹，用于查看预约流转。',
    inputSchema: appointmentAuditInput,
    handler: listAppointmentAudits,
  },
  {
    name: 'confirm_appointment',
    description: '员工/管理端将待确认预约置为已确认。数字人通常不直接调用，除非是前台确认到店前的待确认单。',
    inputSchema: confirmAppointmentInput,
    handler: confirmAppointment,
  },
  {
    name: 'check_in_appointment',
    description: '员工/管理端到店签到。需预约状态为 confirmed。',
    inputSchema: checkInAppointmentInput,
    handler: checkInAppointment,
  },
  {
    name: 'complete_appointment',
    description: '员工/管理端完成预约。需预约状态为 checked_in。',
    inputSchema: completeAppointmentInput,
    handler: completeAppointment,
  },
  {
    name: 'mark_no_show_appointment',
    description: '员工/管理端标记爽约。需预约状态为 confirmed。',
    inputSchema: markNoShowAppointmentInput,
    handler: markNoShowAppointment,
  },
] as const;

export type AppointmentToolSet = typeof appointmentTools;