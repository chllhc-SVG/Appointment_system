export type AppointmentStatus = 'pending' | 'confirmed' | 'checked_in' | 'completed' | 'cancelled' | 'no_show';
export type ScheduleStatus = 'available' | 'unavailable' | 'break';

export interface Store {
  id: string;
  name: string;
  timezone: string;
  is_active: boolean;
  service_ids?: string[];
  created_at: string;
  updated_at: string;
}

export interface StaffWithSkills {
  id: string;
  store_id: string;
  name: string;
  is_active: boolean;
  service_ids: string[];
  service_names: string[];
  created_at: string;
  updated_at: string;
}

export interface ServiceWithStats {
  id: string;
  name: string;
  duration_minutes: number;
  price_cents?: number;
  is_active: boolean;
  staff_count?: number;
  store_count?: number;
  source_system: string;
  source_key?: string | null;
  sync_status: string;
  sync_error?: string | null;
  last_synced_at?: string | null;
  category?: string | null;
  aliases?: string[];
  created_at: string;
  updated_at: string;
}

export interface EntityAudit {
  id: string;
  entity_type: 'store' | 'staff' | 'service';
  entity_id: string;
  action: string;
  operator: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  created_at: string;
}

export interface SyncRun {
  id: string;
  source_system: string;
  status: 'success' | 'partial' | 'failed';
  total: number;
  created: number;
  updated: number;
  deactivated: number;
  failed: number;
  message: string;
  started_at: string;
  finished_at: string | null;
}

export interface SyncResult {
  source_system: 'knowledge_base';
  status: 'success' | 'partial' | 'failed';
  total: number;
  created: number;
  updated: number;
  deactivated: number;
  failed: number;
  message: string;
  errors: string[];
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

export interface AppointmentListItem {
  appointment: Appointment;
  staff_name: string;
  service_name: string;
  store_name: string;
}

export interface AppointmentAudit {
  id: string;
  appointment_id: string;
  operator_type: string;
  operator_id: string;
  action: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  created_at: string;
}

export interface OverviewStats {
  total: number;
  confirmed: number;
  checked_in: number;
  completed: number;
  cancelled: number;
  no_show: number;
}

export interface TimeSlot {
  staff_id: string;
  staff_name: string;
  start_at: string;
  end_at: string;
}

export interface McpCallLog {
  id: string;
  request_id: string;
  transport: string;
  agent_code: string | null;
  tool_name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  success: boolean;
  error_code: string | null;
  duration_ms: number;
  created_at: string;
}

export interface McpCallLogPage {
  items: McpCallLog[];
  total: number;
  limit: number;
  offset: number;
}

export interface McpCallLogStats {
  total: number;
  success: number;
  failure: number;
  successRate: number;
  avgDurationMs: number;
  dailyTrend: Array<{ date: string; total: number; success: number; failure: number }>;
  topTools: Array<{ tool_name: string; count: number; success: number; failure: number }>;
  topAgents: Array<{ agent_code: string | null; count: number }>;
  topErrorCodes: Array<{ error_code: string | null; count: number }>;
}

interface ApiEnvelope<T> {
  success: boolean;
  error?: string;
  data?: T;
}

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as ApiEnvelope<never>;
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
};

export const api = {
  async health() {
    return request<{ ok: boolean; service: string }>('/api/status');
  },
  async stores() {
    return request<{ success: true; stores: Store[] }>('/api/stores');
  },
  async services(params: { store_id?: string; keyword?: string; bookable?: boolean } = {}) {
    const qs = new URLSearchParams();
    if (params.store_id) qs.set('store_id', params.store_id);
    if (params.keyword) qs.set('keyword', params.keyword);
    if (params.bookable) qs.set('bookable', 'true');
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<{ success: true; services: ServiceWithStats[] }>(`/api/services${suffix}`);
  },
  async staff(params: { store_id?: string; service_id?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.store_id) qs.set('store_id', params.store_id);
    if (params.service_id) qs.set('service_id', params.service_id);
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<{ success: true; staff: StaffWithSkills[] }>(`/api/staff${suffix}`);
  },
  async schedules(staffId: string, from: string, to: string) {
    const qs = new URLSearchParams({ from, to });
    return request<{ success: true; schedules: StaffSchedule[] }>(`/api/staff/${staffId}/schedules?${qs}`);
  },
  async appointments(params: {
    store_id?: string;
    staff_id?: string;
    service_id?: string;
    from_date?: string;
    to_date?: string;
    status?: AppointmentStatus;
    keyword?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== '') qs.set(key, String(value));
    });
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<{ success: true; items: AppointmentListItem[] }>(`/api/appointments${suffix}`);
  },
  async overview() {
    return request<{ success: true; overview: OverviewStats }>('/api/overview');
  },
  async appointmentDetail(id: string) {
    return request<{ success: true; appointment: Appointment; audits: AppointmentAudit[] }>(`/api/appointments/${id}`);
  },
  async createAppointment(body: {
    service_id: string;
    store_id: string;
    staff_id: string;
    start_at: string;
    customer_name: string;
    customer_phone: string;
    customer_id?: string;
    note?: string;
    idempotency_key?: string;
  }) {
    return request<{ success: boolean; appointment?: Appointment; deduplicated?: boolean; error_code?: string; message?: string }>('/api/appointments', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  async transition(id: string, action: 'confirm' | 'cancel' | 'check-in' | 'complete' | 'no-show', body: Record<string, unknown> = {}) {
    return request<{ success: boolean; appointment?: Appointment; error_code?: string; message?: string }>(`/api/appointments/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  async reschedule(id: string, body: { customer_id?: string; new_start_at: string; idempotency_key?: string }) {
    return request<{ success: boolean; appointment?: Appointment; error_code?: string; message?: string }>(`/api/appointments/${id}/reschedule`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  async availableSlots(params: { service_id: string; store_id?: string; date: string; preferred_staff_id?: string }) {
    const qs = new URLSearchParams({ service_id: params.service_id, date: params.date });
    if (params.store_id) qs.set('store_id', params.store_id);
    if (params.preferred_staff_id) qs.set('preferred_staff_id', params.preferred_staff_id);
    return request<{ success: boolean; slots?: TimeSlot[]; service?: { id: string; name: string; duration_minutes: number }; error_code?: string; message?: string }>(`/api/slots?${qs}`);
  },
  async mcpCallLogs(params: {
    agent_code?: string;
    tool_name?: string;
    status?: 'success' | 'failure';
    keyword?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== '') qs.set(key, String(value));
    });
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<McpCallLogPage>(`/api/logs/mcp-calls${suffix}`);
  },
  async mcpCallLogStats() {
    return request<{ success: true; stats: McpCallLogStats }>('/api/logs/mcp-calls/stats');
  },
  async appointmentByCode(code: string) {
    if (!code) return null;
    const qs = new URLSearchParams({ appointment_code: code });
    const res = await request<{ success: boolean; appointments?: Appointment[]; error?: string }>(`/api/appointmentsByCode?${qs}`);
    return res.success && res.appointments && res.appointments.length > 0 ? res.appointments[0] : null;
  },
  // ===== 基础资料管理 =====
  async createStore(body: { name: string; timezone?: string; service_ids?: string[]; operator?: string }) {
    return request<{ success: boolean; store?: Store; error?: string }>('/api/admin/stores', { method: 'POST', body: JSON.stringify(body) });
  },
  async updateStore(id: string, body: { name?: string; timezone?: string; is_active?: boolean; service_ids?: string[]; operator?: string }) {
    return request<{ success: boolean; store?: Store; error?: string }>(`/api/admin/stores/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  },
  async deleteStore(id: string, body: { operator?: string } = {}) {
    return request<{ success: boolean; store?: Store; error?: string }>(`/api/admin/stores/${id}`, { method: 'DELETE', body: JSON.stringify(body) });
  },
  async createStaff(body: { store_id: string; name: string; service_ids?: string[]; operator?: string }) {
    return request<{ success: boolean; staff?: StaffWithSkills; error?: string }>('/api/admin/staff', { method: 'POST', body: JSON.stringify(body) });
  },
  async updateStaff(id: string, body: { store_id?: string; name?: string; is_active?: boolean; service_ids?: string[]; operator?: string }) {
    return request<{ success: boolean; staff?: StaffWithSkills; error?: string }>(`/api/admin/staff/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  },
  async deleteStaff(id: string, body: { operator?: string } = {}) {
    return request<{ success: boolean; staff?: StaffWithSkills; error?: string }>(`/api/admin/staff/${id}`, { method: 'DELETE', body: JSON.stringify(body) });
  },
  async createService(body: { name: string; duration_minutes: number; price_cents?: number; operator?: string }) {
    return request<{ success: boolean; service?: ServiceWithStats; error?: string }>('/api/admin/services', { method: 'POST', body: JSON.stringify(body) });
  },
  async updateService(id: string, body: { name?: string; duration_minutes?: number; price_cents?: number; is_active?: boolean; operator?: string }) {
    return request<{ success: boolean; service?: ServiceWithStats; error?: string }>(`/api/admin/services/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  },
  async deleteService(id: string, body: { operator?: string } = {}) {
    return request<{ success: boolean; service?: ServiceWithStats; error?: string }>(`/api/admin/services/${id}`, { method: 'DELETE', body: JSON.stringify(body) });
  },
  async syncKnowledgeBase(body: { operator?: string } = {}) {
    return request<{ success: boolean; result?: SyncResult; error?: string }>('/api/admin/services/sync', { method: 'POST', body: JSON.stringify(body) });
  },
  async syncRuns(limit = 10) {
    return request<{ success: true; runs: SyncRun[] }>(`/api/admin/services/sync-runs?limit=${limit}`);
  },
  async entityAudits(params: { entity_type?: 'store' | 'staff' | 'service'; entity_id?: string; limit?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.entity_type) qs.set('entity_type', params.entity_type);
    if (params.entity_id) qs.set('entity_id', params.entity_id);
    if (params.limit) qs.set('limit', String(params.limit));
    return request<{ success: true; items: EntityAudit[]; total: number }>(`/api/admin/audits?${qs}`);
  },
};