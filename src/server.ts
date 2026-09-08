import express, { type Express } from 'express';
import type { AppointmentToolSet } from './tools/tools.js';
import { listStaff, listServices, listStores } from './queries.js';
import { getAppointment, getAppointmentByCode, listStaffSchedules, listAuditsByAppointment } from './queries.js';
import { confirmAppointment, createAppointment, cancelAppointment, rescheduleAppointment, checkInAppointment, completeAppointment, markNoShowAppointment, listAppointments, getAppointmentOverview, searchAvailableSlots } from './services/appointments.js';
import { deleteMcpCallLog, deleteMcpCallLogs, listRecentMcpCalls, mcpCallLogStats, queryMcpCallLogs } from './services/mcp-call-log.js';
import {
  createService,
  createStaff,
  createStaffSchedules,
  createStore,
  deleteService,
  deleteStaff,
  deleteStore,
  listEntityAudits,
  listStaffSchedulesForStaff,
  updateService,
  updateStaff,
  updateStore,
} from './services/catalog.js';
import { applyStaffWeeklySchedule, adminCancelAppointment, deleteDayStaffSchedules, listStoreScheduleGrid, upsertDayStaffSchedules } from './services/appointments.js';
import { listSyncRuns, syncServicesFromKnowledgeBase } from './services/kb-sync.js';

const asString = (value: unknown) => (typeof value === 'string' ? value : undefined);
const asNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const requireAdminToken = (token?: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!token) {
    next();
    return;
  }
  const header = asString(req.headers.authorization) ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (bearer !== token) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  next();
};

export function createApiServer(tools: AppointmentToolSet, adminToken?: string): Express {
  const app = express();
  app.use(express.json());
  app.use('/api', requireAdminToken(adminToken));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'appointment-mcp' });
  });

  app.get('/api/status', (_req, res) => {
    res.json({ ok: true, tools: tools.map((tool) => tool.name) });
  });

  // ===== 基础资料管理（门店 / 员工 / 服务）=====
  app.post('/api/admin/stores', async (req, res) => {
    try {
      const store = await createStore({
        name: asString(req.body?.name) ?? '',
        timezone: asString(req.body?.timezone),
        service_ids: Array.isArray(req.body?.service_ids) ? req.body.service_ids.filter((v: unknown): v is string => typeof v === 'string') : [],
        operator: asString(req.body?.operator),
      });
      res.json({ success: true, store });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch('/api/admin/stores/:storeId', async (req, res) => {
    try {
      const store = await updateStore(req.params.storeId, {
        name: asString(req.body?.name),
        timezone: asString(req.body?.timezone),
        is_active: typeof req.body?.is_active === 'boolean' ? req.body.is_active : undefined,
        service_ids: Array.isArray(req.body?.service_ids) ? req.body.service_ids.filter((v: unknown): v is string => typeof v === 'string') : undefined,
        operator: asString(req.body?.operator),
      });
      if (!store) {
        res.status(404).json({ success: false, error: 'Store not found' });
        return;
      }
      res.json({ success: true, store });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/api/admin/stores/:storeId', async (req, res) => {
    try {
      const store = await deleteStore(req.params.storeId, asString(req.body?.operator));
      if (!store) {
        res.status(404).json({ success: false, error: 'Store not found' });
        return;
      }
      res.json({ success: true, store });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/admin/staff', async (req, res) => {
    try {
      const staff = await createStaff({
        store_id: asString(req.body?.store_id) ?? '',
        name: asString(req.body?.name) ?? '',
        service_ids: Array.isArray(req.body?.service_ids) ? req.body.service_ids.filter((v: unknown): v is string => typeof v === 'string') : [],
        operator: asString(req.body?.operator),
      });
      res.json({ success: true, staff });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch('/api/admin/staff/:staffId', async (req, res) => {
    try {
      const staff = await updateStaff(req.params.staffId, {
        store_id: asString(req.body?.store_id),
        name: asString(req.body?.name),
        is_active: typeof req.body?.is_active === 'boolean' ? req.body.is_active : undefined,
        service_ids: Array.isArray(req.body?.service_ids) ? req.body.service_ids.filter((v: unknown): v is string => typeof v === 'string') : undefined,
        operator: asString(req.body?.operator),
      });
      if (!staff) {
        res.status(404).json({ success: false, error: 'Staff not found' });
        return;
      }
      res.json({ success: true, staff });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/api/admin/staff/:staffId', async (req, res) => {
    try {
      const staff = await deleteStaff(req.params.staffId, asString(req.body?.operator));
      if (!staff) {
        res.status(404).json({ success: false, error: 'Staff not found' });
        return;
      }
      res.json({ success: true, staff });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/admin/services', async (req, res) => {
    try {
      const service = await createService({
        name: asString(req.body?.name) ?? '',
        duration_minutes: asNumber(req.body?.duration_minutes) ?? 60,
        price_cents: asNumber(req.body?.price_cents),
        operator: asString(req.body?.operator),
      });
      res.json({ success: true, service });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch('/api/admin/services/:serviceId', async (req, res) => {
    try {
      const service = await updateService(req.params.serviceId, {
        name: asString(req.body?.name),
        duration_minutes: asNumber(req.body?.duration_minutes),
        price_cents: asNumber(req.body?.price_cents),
        is_active: typeof req.body?.is_active === 'boolean' ? req.body.is_active : undefined,
        operator: asString(req.body?.operator),
      });
      if (!service) {
        res.status(404).json({ success: false, error: 'Service not found' });
        return;
      }
      res.json({ success: true, service });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/api/admin/services/:serviceId', async (req, res) => {
    try {
      const service = await deleteService(req.params.serviceId, asString(req.body?.operator));
      if (!service) {
        res.status(404).json({ success: false, error: 'Service not found' });
        return;
      }
      res.json({ success: true, service });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // 知识库项目管理同步
  app.post('/api/admin/services/sync', async (req, res) => {
    try {
      const result = await syncServicesFromKnowledgeBase({ operator: asString(req.body?.operator) });
      res.status(result.status === 'failed' ? 502 : 200).json({ success: result.status !== 'failed', result });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/admin/services/sync-runs', async (req, res) => {
    try {
      const runs = await listSyncRuns(asNumber(req.query.limit));
      res.json({ success: true, runs });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/admin/audits', async (req, res) => {
    try {
      const page = await listEntityAudits({
        entity_type: asString(req.query.entity_type) as 'store' | 'staff' | 'service' | undefined,
        entity_id: asString(req.query.entity_id),
        limit: asNumber(req.query.limit),
        offset: asNumber(req.query.offset),
      });
      res.json({ success: true, ...page });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/logs/mcp-calls', async (req, res) => {
    try {
      const page = await queryMcpCallLogs({
        agent_code: asString(req.query.agent_code),
        tool_name: asString(req.query.tool_name),
        status: asString(req.query.status) === 'success' || asString(req.query.status) === 'failure' ? asString(req.query.status) as 'success' | 'failure' : undefined,
        keyword: asString(req.query.keyword),
        limit: asNumber(req.query.limit),
        offset: asNumber(req.query.offset),
      });
      res.json({ success: true, ...page });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/logs/mcp-calls/recent', async (_req, res) => {
    try {
      const recent = await listRecentMcpCalls(20);
      res.json({ success: true, recent });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/api/logs/mcp-calls/:logId', async (req, res) => {
    try {
      const deleted = await deleteMcpCallLog(req.params.logId);
      res.json({ success: true, deleted });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/logs/mcp-calls/delete', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((v: unknown): v is string => typeof v === 'string') : [];
      if (ids.length === 0) {
        res.status(400).json({ success: false, error: 'ids is required' });
        return;
      }
      const deleted = await deleteMcpCallLogs(ids);
      res.json({ success: true, deleted });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/logs/mcp-calls/stats', async (_req, res) => {
    try {
      const stats = await mcpCallLogStats(14);
      res.json({ success: true, stats });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/stores', async (_req, res) => {
    try {
      const stores = await listStores(true, undefined, 100);
      res.json({ success: true, stores });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/services', async (req, res) => {
    try {
      const services = await listServices(
        asString(req.query.store_id),
        asString(req.query.keyword),
        true,
        100,
        asString(req.query.bookable) === 'true',
      );
      res.json({ success: true, services });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/staff', async (req, res) => {
    try {
      const staff = await listStaff(asString(req.query.store_id), asString(req.query.service_id), asString(req.query.keyword), true, 100);
      res.json({ success: true, staff });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/staff/:staffId/schedules', async (req, res) => {
    try {
      const from = asString(req.query.from) ?? '';
      const to = asString(req.query.to) ?? '';
      if (!from || !to) {
        res.status(400).json({ success: false, error: 'from and to are required' });
        return;
      }
      const schedules = await listStaffSchedules(req.params.staffId, from, to);
      res.json({ success: true, schedules });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/staff/:staffId/schedules', async (req, res) => {
    try {
      const body = req.body ?? {};
      const schedules = Array.isArray(body.schedules) ? body.schedules : [];
      if (schedules.length === 0) {
        res.status(400).json({ success: false, error: 'schedules is required' });
        return;
      }
      const created = await createStaffSchedules({
        staff_id: req.params.staffId,
        schedules,
        operator: asString(body.operator),
      });
      res.json({ success: true, created: created.length, schedules: created });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/staff-schedules', async (req, res) => {
    try {
      const rows = await listStaffSchedulesForStaff(asString(req.query.staff_id));
      res.json({ success: true, schedules: rows });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ===== 日历式排班（门店维度）：一次拉全店员工班次；按天建/改/删 =====
  app.get('/api/store-schedules', async (req, res) => {
    try {
      const storeId = asString(req.query.store_id);
      const from = asString(req.query.date_from) ?? asString(req.query.from) ?? '';
      const to = asString(req.query.date_to) ?? asString(req.query.to) ?? '';
      if (!storeId || !from || !to) {
        res.status(400).json({ success: false, error: 'store_id, date_from, date_to are required' });
        return;
      }
      const grid = await listStoreScheduleGrid({ store_id: storeId, date_from: from, date_to: to, staff_id: asString(req.query.staff_id) });
      res.json({ success: true, ...grid });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put('/api/store-schedules/day', async (req, res) => {
    try {
      const body = req.body ?? {};
      const storeId = asString(body.store_id);
      const staffId = asString(body.staff_id);
      const date = asString(body.date);
      const shifts = Array.isArray(body.shifts) ? body.shifts : [];
      if (!storeId || !staffId || !date) {
        res.status(400).json({ success: false, error: 'store_id, staff_id, date are required' });
        return;
      }
      // shifts 为空数组 = 清空该员工该天全部班次（UI "清空后保存" 语义），等价于按天删除
      if (shifts.length === 0) {
        const result = await deleteDayStaffSchedules({
          store_id: storeId,
          staff_id: staffId,
          date,
          operator: asString(body.operator),
        });
        res.json({
          success: true,
          created: 0,
          deleted: Array.isArray(result.deleted) ? result.deleted.length : 0,
          affected_appointments: result.affected_appointments,
          schedules: [],
        });
        return;
      }
      const result = await upsertDayStaffSchedules({
        store_id: storeId,
        staff_id: staffId,
        date,
        shifts: shifts.map((item: { start?: unknown; end?: unknown; status?: unknown }) => ({
          start: asString(item.start) ?? '',
          end: asString(item.end) ?? '',
          status: asString(item.status),
        })),
        operator: asString(body.operator),
      });
      res.json({ success: true, created: result.schedules.length, schedules: result.schedules, affected_appointments: result.affected_appointments });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/api/store-schedules/day', async (req, res) => {
    try {
      const body = req.body ?? {};
      const storeId = asString(body.store_id);
      const staffId = asString(body.staff_id);
      const date = asString(body.date);
      if (!storeId || !staffId || !date) {
        res.status(400).json({ success: false, error: 'store_id, staff_id, date are required' });
        return;
      }
      const result = await deleteDayStaffSchedules({
        store_id: storeId,
        staff_id: staffId,
        date,
        start: asString(body.start),
        operator: asString(body.operator),
      });
      res.json({
        success: true,
        deleted: Array.isArray(result.deleted) ? result.deleted.length : 0,
        affected_appointments: result.affected_appointments,
        schedules: Array.isArray(result.deleted) ? result.deleted : [],
      });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // 周模板排班：把每周固定班批量铺到日期范围（只填空白天，不覆盖已有排班）
  app.post('/api/store-schedules/weekly', async (req, res) => {
    try {
      const body = req.body ?? {};
      const storeId = asString(body.store_id);
      const staffId = asString(body.staff_id);
      const dateFrom = asString(body.date_from);
      const dateTo = asString(body.date_to);
      const weekdays = Array.isArray(body.weekdays) ? body.weekdays.map(Number).filter(Number.isInteger) : [];
      const shifts = Array.isArray(body.shifts) ? body.shifts : [];
      if (!storeId || !staffId || !dateFrom || !dateTo) {
        res.status(400).json({ success: false, error: 'store_id, staff_id, date_from, date_to are required' });
        return;
      }
      if (weekdays.length === 0) {
        res.status(400).json({ success: false, error: 'weekdays is required（1=周一 ... 7=周日）' });
        return;
      }
      const result = await applyStaffWeeklySchedule({
        store_id: storeId,
        staff_id: staffId,
        date_from: dateFrom,
        date_to: dateTo,
        weekdays,
        shifts: shifts.map((item: { start?: unknown; end?: unknown; status?: unknown }) => ({
          start: asString(item.start) ?? '',
          end: asString(item.end) ?? '',
          status: asString(item.status),
        })),
        operator: asString(body.operator),
      });
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/appointments', async (req, res) => {
    try {
      const items = await listAppointments({
        customer_id: asString(req.query.customer_id),
        store_id: asString(req.query.store_id),
        staff_id: asString(req.query.staff_id),
        service_id: asString(req.query.service_id),
        from_date: asString(req.query.from_date),
        to_date: asString(req.query.to_date),
        status: asString(req.query.status) as any,
        keyword: asString(req.query.keyword),
        limit: asNumber(req.query.limit),
        offset: asNumber(req.query.offset),
      });
      res.json({ success: true, items });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/overview', async (req, res) => {
    try {
      const overview = await getAppointmentOverview({
        from_date: asString(req.query.from_date),
        to_date: asString(req.query.to_date),
        store_id: asString(req.query.store_id),
      });
      res.json({ success: true, overview });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/slots', async (req, res) => {
    try {
      const result = await searchAvailableSlots({
        service_id: asString(req.query.service_id) ?? '',
        store_id: asString(req.query.store_id),
        date: asString(req.query.date) ?? '',
        preferred_staff_id: asString(req.query.preferred_staff_id),
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/appointments/code/:code', async (req, res) => {
    try {
      const appointment = await getAppointmentByCode(req.params.code);
      res.json({ success: true, appointments: appointment ? [appointment] : [] });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/appointments/:appointmentId', async (req, res) => {
    try {
      const appointment = await getAppointment(req.params.appointmentId);
      if (!appointment) {
        res.status(404).json({ success: false, error: 'Appointment not found' });
        return;
      }
      const audits = await listAuditsByAppointment(appointment.id);
      res.json({ success: true, appointment, audits });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/appointments', async (req, res) => {
    try {
      const result = await createAppointment(req.body ?? {});
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/appointments/:appointmentId/confirm', async (req, res) => {
    try {
      const result = await confirmAppointment({ appointment_id: req.params.appointmentId, operator_id: asString(req.body?.operator_id) });
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/appointments/:appointmentId/cancel', async (req, res) => {
    try {
      // 管理端取消（带 operator 或 customer_id 缺省时）：按 id 直达，不校验顾客归属
      if (asString(req.body?.operator) || !asString(req.body?.customer_id)) {
        const result = await adminCancelAppointment({
          appointment_id: req.params.appointmentId,
          operator: asString(req.body?.operator),
          reason: asString(req.body?.reason),
        });
        res.json(result);
        return;
      }
      const result = await cancelAppointment({ appointment_id: req.params.appointmentId, customer_id: asString(req.body?.customer_id) ?? '', reason: asString(req.body?.reason), idempotency_key: asString(req.body?.idempotency_key) ?? req.params.appointmentId });
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/appointments/:appointmentId/reschedule', async (req, res) => {
    try {
      const result = await rescheduleAppointment({ appointment_id: req.params.appointmentId, customer_id: asString(req.body?.customer_id) ?? '', new_start_at: asString(req.body?.new_start_at) ?? '', idempotency_key: asString(req.body?.idempotency_key) ?? req.params.appointmentId });
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/appointments/:appointmentId/check-in', async (req, res) => {
    try {
      const result = await checkInAppointment({ appointment_id: req.params.appointmentId, customer_id: asString(req.body?.customer_id) ?? '', operator_id: asString(req.body?.operator_id) });
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/appointments/:appointmentId/complete', async (req, res) => {
    try {
      const result = await completeAppointment({ appointment_id: req.params.appointmentId, operator_id: asString(req.body?.operator_id) });
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/appointments/:appointmentId/no-show', async (req, res) => {
    try {
      const result = await markNoShowAppointment({ appointment_id: req.params.appointmentId, operator_id: asString(req.body?.operator_id) });
      res.json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return app;
}