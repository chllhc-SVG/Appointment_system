import { useEffect, useMemo, useState } from 'react';
import {
  CalendarOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  LeftOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import {
  Button,
  Card,
  Checkbox,
  DatePicker,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  TimePicker,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { api, type AppointmentListItem, type ScheduleStatus, type StaffSchedule, type StaffWithSkills, type Store } from '../api/client';

const { Title, Paragraph } = Typography;

const SCHEDULE_COLORS: Record<string, string> = {
  available: 'green',
  unavailable: 'default',
  break: 'orange',
};

const SCHEDULE_LABELS: Record<string, string> = {
  available: '可约',
  unavailable: '停用',
  break: '休息',
};

interface ShiftDraft {
  key: number;
  start: Dayjs;
  end: Dayjs;
  status: ScheduleStatus;
}

let shiftKeySeed = 1;
const nextShiftKey = () => shiftKeySeed++;

const morningShift = () => ({ start: dayjs('09:00', 'HH:mm'), end: dayjs('12:00', 'HH:mm') });
const afternoonShift = () => ({ start: dayjs('13:00', 'HH:mm'), end: dayjs('18:00', 'HH:mm') });

export function SchedulesView() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState<string>();
  const [staff, setStaff] = useState<StaffWithSkills[]>([]);
  const [staffFilter, setStaffFilter] = useState<string>();
  // 日历锚点月份
  const [monthAnchor, setMonthAnchor] = useState<Dayjs>(dayjs().startOf('month'));
  const [schedules, setSchedules] = useState<(StaffSchedule & { staff_name: string })[]>([]);
  const [appointments, setAppointments] = useState<AppointmentListItem[]>([]);
  const [loading, setLoading] = useState(false);

  // 编辑弹窗状态
  const [editingOpen, setEditingOpen] = useState(false);
  const [editingDate, setEditingDate] = useState<string>();
  const [editingStaffId, setEditingStaffId] = useState<string>();
  const [shifts, setShifts] = useState<ShiftDraft[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.stores().then((res) => {
      setStores(res.stores);
      if (res.stores.length > 0) setStoreId((current) => current ?? res.stores[0].id);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!storeId) {
      setStaff([]);
      setStaffFilter(undefined);
      return;
    }
    api.staff({ store_id: storeId }).then((res) => setStaff(res.staff)).catch(() => setStaff([]));
  }, [storeId]);

  const monthStart = monthAnchor.format('YYYY-MM-DD');
  const monthEnd = monthAnchor.endOf('month').format('YYYY-MM-DD');

  const load = async () => {
    if (!storeId) return;
    setLoading(true);
    try {
      const res = await api.storeSchedules({ store_id: storeId, date_from: monthStart, date_to: monthEnd, staff_id: staffFilter });
      setSchedules(res.schedules);
      const apptRes = await api.appointments({
        store_id: storeId,
        from_date: `${monthStart}T00:00:00+08:00`,
        to_date: `${monthEnd}T23:59:59+08:00`,
        limit: 100,
      });
      setAppointments(apptRes.items);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载排班失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, staffFilter, monthStart, monthEnd]);

  /** key = YYYY-MM-DD → 该天的班次列表 */
  const schedulesByDay = useMemo(() => {
    const map = new Map<string, (StaffSchedule & { staff_name: string })[]>();
    for (const schedule of schedules) {
      const day = dayjs(schedule.start_at).format('YYYY-MM-DD');
      const list = map.get(day) ?? [];
      list.push(schedule);
      map.set(day, list);
    }
    return map;
  }, [schedules]);

  /** key = YYYY-MM-DD → 员工名 → 班次摘要（"李雷 9:00-12:00, 13:00-18:00"），供日历格子展示 */
  const staffShiftsByDay = useMemo(() => {
    const map = new Map<string, Map<string, string[]>>();
    for (const [day, daySchedules] of schedulesByDay) {
      const byStaff = new Map<string, string[]>();
      for (const schedule of daySchedules) {
        const label = schedule.status === 'available'
          ? `${dayjs(schedule.start_at).format('H:mm')}-${dayjs(schedule.end_at).format('H:mm')}`
          : `${dayjs(schedule.start_at).format('H:mm')}-${dayjs(schedule.end_at).format('H:mm')}(${SCHEDULE_LABELS[schedule.status] ?? schedule.status})`;
        const list = byStaff.get(schedule.staff_name) ?? [];
        list.push(label);
        byStaff.set(schedule.staff_name, list);
      }
      map.set(day, byStaff);
    }
    return map;
  }, [schedulesByDay]);

  /** key = YYYY-MM-DD → 员工名列表（日历格子摘要） */
  const staffNamesByDay = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [day, daySchedules] of schedulesByDay) {
      const names = [...new Set(daySchedules.map((item) => item.staff_name))];
      map.set(day, names);
    }
    return map;
  }, [schedulesByDay]);

  // 周模板弹窗状态
  const [weeklyOpen, setWeeklyOpen] = useState(false);
  const [weeklyStaffId, setWeeklyStaffId] = useState<string>();
  const [weeklyRange, setWeeklyRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf('month'), dayjs().endOf('month')]);
  const [weeklyDays, setWeeklyDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [weeklyShifts, setWeeklyShifts] = useState<ShiftDraft[]>([{ key: nextShiftKey(), ...morningShift(), status: 'available' }, { key: nextShiftKey(), ...afternoonShift(), status: 'available' }]);
  const [weeklySaving, setWeeklySaving] = useState(false);

  const openWeekly = () => {
    if (!storeId) {
      message.warning('请先选择门店');
      return;
    }
    const target = weeklyStaffId ?? staffFilter ?? staff[0]?.id;
    if (!target) {
      message.warning('该门店暂无员工，请先在「基础资料」中添加员工');
      return;
    }
    setWeeklyStaffId(target);
    setWeeklyOpen(true);
  };

  const handleApplyWeekly = async () => {
    if (!storeId || !weeklyStaffId) return;
    if (weeklyDays.length === 0) {
      message.error('请至少勾选一个星期');
      return;
    }
    for (const shift of weeklyShifts) {
      if (!shift.start || !shift.end || !shift.end.isAfter(shift.start)) {
        message.error('周模板班次时间不完整或结束早于开始');
        return;
      }
    }
    setWeeklySaving(true);
    try {
      const res = await api.applyWeeklySchedule({
        store_id: storeId,
        staff_id: weeklyStaffId,
        date_from: weeklyRange[0].format('YYYY-MM-DD'),
        date_to: weeklyRange[1].format('YYYY-MM-DD'),
        weekdays: weeklyDays,
        shifts: weeklyShifts.map((shift) => ({ start: shift.start.format('HH:mm'), end: shift.end.format('HH:mm'), status: shift.status })),
      });
      message.success(`周模板已铺班：新增 ${res.applied.length} 天（跳过已有排班的 ${res.skipped.length} 天）`);
      setWeeklyOpen(false);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '周模板铺班失败');
    } finally {
      setWeeklySaving(false);
    }
  };

  /** 把当前编辑的班次复制到同月其它日期（只覆盖这些天该员工的班次） */
  const [copyTargetDates, setCopyTargetDates] = useState<string[]>([]);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyStaffId, setCopyStaffId] = useState<string>();

  const openCopyTo = () => {
    if (!editingDate || shifts.length === 0) {
      message.warning('请先填写班次再复制');
      return;
    }
    setCopyStaffId(editingStaffId);
    setCopyTargetDates([]);
    setCopyOpen(true);
  };

  const handleCopyTo = async () => {
    if (!storeId || !copyStaffId || copyTargetDates.length === 0) {
      message.warning('请勾选要复制到的日期');
      return;
    }
    setSaving(true);
    try {
      const payload = shifts.map((shift) => ({ start: shift.start.format('HH:mm'), end: shift.end.format('HH:mm'), status: shift.status }));
      for (const date of copyTargetDates) {
        await api.upsertDaySchedule({ store_id: storeId, staff_id: copyStaffId, date, shifts: payload });
      }
      message.success(`已复制到 ${copyTargetDates.length} 天`);
      setCopyOpen(false);
      setEditingOpen(false);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '复制班次失败');
    } finally {
      setSaving(false);
    }
  };

  /** 渲染 6 行 × 7 列（周一起始）的月历格子 */
  const calendarCells = useMemo(() => {
    const firstDay = monthAnchor.startOf('month');
    const offset = (firstDay.day() + 6) % 7; // Monday=0
    const gridStart = firstDay.subtract(offset, 'day');
    return Array.from({ length: 42 }, (_, index) => gridStart.add(index, 'day'));
  }, [monthAnchor]);

  const openDayEditor = (date: string, presetStaffId?: string) => {
    if (!storeId) {
      message.warning('请先选择门店');
      return;
    }
    const targetStaff = presetStaffId ?? staffFilter ?? staff[0]?.id;
    if (!targetStaff) {
      message.warning('该门店暂无员工，请先在「基础资料」中添加员工');
      return;
    }
    setEditingDate(date);
    setEditingStaffId(targetStaff);
    // 已有班次 → 编辑；无班次 → 默认填一节上午班
    const existing = (schedulesByDay.get(date) ?? []).filter((item) => item.staff_id === targetStaff);
    if (existing.length > 0) {
      setShifts(existing.map((item) => ({
        key: nextShiftKey(),
        start: dayjs(item.start_at).format('HH:mm') === '00:00' ? morningShift().start : dayjs(item.start_at),
        end: dayjs(item.end_at).format('HH:mm') === '00:00' ? morningShift().end : dayjs(item.end_at),
        status: item.status as ScheduleStatus,
      })));
    } else {
      setShifts([{ key: nextShiftKey(), ...morningShift(), status: 'available' }]);
    }
    setEditingOpen(true);
  };

  const handleSaveDay = async () => {
    if (!editingDate || !editingStaffId || !storeId) return;
    for (const shift of shifts) {
      if (!shift.start || !shift.end) {
        message.error('班次时间不完整');
        return;
      }
      if (!shift.end.isAfter(shift.start)) {
        message.error(`班次结束必须晚于开始：${shift.start.format('HH:mm')} ~ ${shift.end.format('HH:mm')}`);
        return;
      }
    }
    setSaving(true);
    try {
      const res = await api.upsertDaySchedule({
        store_id: storeId,
        staff_id: editingStaffId,
        date: editingDate,
        shifts: shifts.map((shift) => ({
          start: shift.start.format('HH:mm'),
          end: shift.end.format('HH:mm'),
          status: shift.status,
        })),
      });
      const affected = res.affected_appointments ?? [];
      if (affected.length > 0) {
        Modal.warning({
          title: '排班已保存，但有预约悬空',
          content: (
            <div>
              <p>以下 {affected.length} 条有效预约已不在新排班范围内，请到「预约管理」取消或改期：</p>
              <ul>
                {affected.map((item) => (
                  <li key={item.appointment_code}>
                    {dayjs(item.start_at).format('MM-DD HH:mm')} · {item.customer_name || '到店客户'} · {item.appointment_code}
                  </li>
                ))}
              </ul>
            </div>
          ),
          width: 480,
        });
      } else {
        message.success(`${editingDate} 排班已保存`);
      }
      setEditingOpen(false);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存排班失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteDay = async (date: string, staffId: string) => {
    try {
      const res = await api.deleteDaySchedule({ store_id: storeId!, staff_id: staffId, date });
      const affected = res.affected_appointments ?? [];
      if (affected.length > 0) {
        Modal.warning({
          title: `已删除 ${date} 的 ${res.deleted} 条班次`,
          content: (
            <div>
              <p>但该员工当天还有 {affected.length} 条有效预约已无排班承接，请尽快到「预约管理」处理：</p>
              <ul>
                {affected.map((item) => (
                  <li key={item.appointment_code}>
                    {dayjs(item.start_at).format('MM-DD HH:mm')} · {item.customer_name || '到店客户'} · {item.appointment_code}
                  </li>
                ))}
              </ul>
            </div>
          ),
          width: 480,
        });
      } else {
        message.success(`已删除 ${date} 的 ${res.deleted} 条班次`);
      }
      if (editingDate === date && editingStaffId === staffId) setEditingOpen(false);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除排班失败');
    }
  };

  const quickFill = (kind: 'morning' | 'afternoon' | 'fullday' | 'clear') => {
    if (kind === 'clear') {
      setShifts([]);
      return;
    }
    const base = kind === 'morning' ? [morningShift()] : kind === 'afternoon' ? [afternoonShift()] : [morningShift(), afternoonShift()];
    setShifts(base.map((shift) => ({ key: nextShiftKey(), ...shift, status: 'available' as ScheduleStatus })));
  };

  const editingStaff = staff.find((item) => item.id === editingStaffId);
  const editingExisting = editingDate ? (schedulesByDay.get(editingDate) ?? []).filter((item) => item.staff_id === editingStaffId) : [];

  /** 该员工当天的有效预约（弹窗内提示"这些时段已有顾客预约"），从已加载的门店预约里就地过滤 */
  const editingDayAppointments = useMemo(() => {
    if (!editingDate || !editingStaffId || !storeId) return [];
    return appointments
      .filter((item) => item.appointment.staff_id === editingStaffId)
      .filter((item) => dayjs(item.appointment.start_at).format('YYYY-MM-DD') === editingDate)
      .filter((item) => ['pending', 'confirmed', 'checked_in'].includes(item.appointment.status));
  }, [appointments, editingDate, editingStaffId, storeId]);

  /** 被当前编辑移除/缩短的班次里，是否有已约时段 */
  const removedShiftsWithBookings = useMemo(() => {
    if (!editingDate) return [];
    return editingDayAppointments.filter((item) => {
      const kept = shifts.some((shift) =>
        shift.start.isSame(dayjs(item.appointment.start_at)) ||
        (shift.start.isBefore(dayjs(item.appointment.start_at)) && shift.end.isAfter(dayjs(item.appointment.start_at))),
      );
      return !kept;
    });
  }, [editingDayAppointments, shifts, editingDate]);

  return (
    <div className="view-stack">
      <Card className="page-header-card" variant="borderless">
        <Title level={2} className="page-title">员工排班</Title>
        <Paragraph className="page-desc">
          点日历上的某一天为员工建立、修改或删除当天班次；绿色角标 = 该天已有人排班。
          顾客预约时只能约到已排班的时段。
        </Paragraph>
      </Card>

      <Card className="section-card" variant="borderless">
        <Space wrap style={{ marginBottom: 16 }}>
          <Select
            placeholder="选择门店"
            style={{ width: 200 }}
            value={storeId}
            onChange={(value) => {
              setStoreId(value);
              setStaffFilter(undefined);
            }}
            options={stores.map((store) => ({ value: store.id, label: store.name }))}
          />
          <Select
            placeholder="全部员工"
            style={{ width: 180 }}
            allowClear
            value={staffFilter}
            onChange={(value) => setStaffFilter(value)}
            options={staff.map((item) => ({ value: item.id, label: item.name }))}
          />
          <Space.Compact>
            <Button icon={<LeftOutlined />} onClick={() => setMonthAnchor(monthAnchor.subtract(1, 'month'))} />
            <Button style={{ width: 110 }}>{monthAnchor.format('YYYY年MM月')}</Button>
            <Button icon={<RightOutlined />} onClick={() => setMonthAnchor(monthAnchor.add(1, 'month'))} />
          </Space.Compact>
          <DatePicker.MonthPicker
            value={monthAnchor}
            onChange={(value) => value && setMonthAnchor(value.startOf('month'))}
            allowClear={false}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
          <Button type="primary" ghost icon={<CalendarOutlined />} onClick={openWeekly}>周模板铺班</Button>
        </Space>

        <Spin spinning={loading}>
          <div className="schedule-calendar">
            <div className="schedule-week-header">
              {['一', '二', '三', '四', '五', '六', '日'].map((label) => (
                <div key={label} className="schedule-week-label">{label}</div>
              ))}
            </div>
            <div className="schedule-grid">
              {calendarCells.map((cell) => {
                const day = cell.format('YYYY-MM-DD');
                const inMonth = cell.isSame(monthAnchor, 'month');
                const isToday = cell.isSame(dayjs(), 'day');
                const dayStaff = staffNamesByDay.get(day) ?? [];
                const dayShifts = schedulesByDay.get(day) ?? [];
                const selectable = storeId && staff.length > 0;
                return (
                  <div
                    key={day}
                    className={[
                      'schedule-cell',
                      inMonth ? '' : 'schedule-cell-out',
                      isToday ? 'schedule-cell-today' : '',
                      selectable ? 'schedule-cell-clickable' : '',
                    ].join(' ')}
                    onClick={() => selectable && openDayEditor(day)}
                  >
                    <div className="schedule-cell-head">
                      <span className={isToday ? 'schedule-day-num schedule-day-num-today' : 'schedule-day-num'}>{cell.date()}</span>
                      {dayShifts.length > 0 && <Tag className="schedule-count-tag">{dayShifts.length}班</Tag>}
                    </div>
                    {(staffShiftsByDay.get(day) ?? new Map()).size === 0 && inMonth && (
                      <div className="schedule-cell-staff schedule-cell-empty-hint">点击排班</div>
                    )}
                    {[...(staffShiftsByDay.get(day) ?? new Map()).entries()].slice(0, 3).map(([name, labels]) => (
                      <div key={name} className="schedule-cell-staff" title={`${name}：${labels.join(', ')}`}>
                        <CheckOutlined /> {name} {labels.join(', ')}
                      </div>
                    ))}
                    {(staffShiftsByDay.get(day)?.size ?? 0) > 3 && (
                      <div className="schedule-cell-more">+{(staffShiftsByDay.get(day)?.size ?? 0) - 3} 人</div>
                    )}
                    {selectable && (
                      <Button
                        className="schedule-cell-add"
                        type="text"
                        size="small"
                        icon={<PlusOutlined />}
                        onClick={(event) => {
                          event.stopPropagation();
                          openDayEditor(day);
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </Spin>

        {storeId && staff.length === 0 && (
          <Empty description="该门店暂无员工，请先在「基础资料」添加" style={{ marginTop: 16 }} />
        )}
      </Card>

      <Modal
        title={
          <Space>
            <CalendarOutlined />
            {editingDate ? `${dayjs(editingDate).format('YYYY年MM月DD日')} · ${editingStaff?.name ?? ''}` : ''}
          </Space>
        }
        open={editingOpen}
        onCancel={() => setEditingOpen(false)}
        width={560}
        footer={[
          editingExisting.length > 0 && editingStaffId && editingDate ? (
            <Button
              key="delete"
              danger
              icon={<DeleteOutlined />}
              onClick={() => void handleDeleteDay(editingDate, editingStaffId)}
            >
              删除当天全部班次
            </Button>
          ) : null,
          <Button key="copy" icon={<CopyOutlined />} disabled={shifts.length === 0} onClick={openCopyTo}>
            复制到其他日期/员工
          </Button>,
          <Button key="cancel" onClick={() => setEditingOpen(false)}>取消</Button>,
          <Button key="save" type="primary" loading={saving} icon={<CheckOutlined />} onClick={() => void handleSaveDay()}>
            保存排班
          </Button>,
        ]}
      >
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            style={{ width: 180 }}
            value={editingStaffId}
            onChange={(value) => {
              setEditingStaffId(value);
              const existing = editingDate ? (schedulesByDay.get(editingDate) ?? []).filter((item) => item.staff_id === value) : [];
              setShifts(existing.length > 0
                ? existing.map((item) => ({
                    key: nextShiftKey(),
                    start: dayjs(item.start_at),
                    end: dayjs(item.end_at),
                    status: item.status as ScheduleStatus,
                  }))
                : [{ key: nextShiftKey(), ...morningShift(), status: 'available' }]);
            }}
            options={staff.map((item) => ({ value: item.id, label: item.name }))}
          />
          <Button size="small" onClick={() => quickFill('morning')}>上午班 9-12</Button>
          <Button size="small" onClick={() => quickFill('afternoon')}>下午班 13-18</Button>
          <Button size="small" onClick={() => quickFill('fullday')}>全天 9-12,13-18</Button>
          <Button size="small" danger onClick={() => quickFill('clear')}>清空</Button>
        </Space>

        {shifts.length === 0 && <Empty description="该天暂无班次，点击下方按钮或快捷键添加" />}

        {removedShiftsWithBookings.length > 0 && (
          <div className="form-hint" style={{ marginBottom: 10, color: '#d46b08' }}>
            <ExclamationCircleOutlined /> 注意：被移除/调整的时段内还有 {removedShiftsWithBookings.length} 条有效预约
            （{removedShiftsWithBookings.map((item) => dayjs(item.appointment.start_at).format('HH:mm')).join('、')}），
            保存后这些预约将不在排班范围内，请到「预约管理」跟进取消或改期。
          </div>
        )}

        {shifts.map((shift, index) => (
          <Space key={shift.key} wrap align="center" style={{ display: 'flex', marginBottom: 8 }}>
            <span className="form-hint" style={{ width: 44 }}>班次 {index + 1}</span>
            <TimePicker
              format="HH:mm"
              minuteStep={30}
              value={shift.start}
              onChange={(value) => setShifts((prev) => prev.map((item) => (item.key === shift.key ? { ...item, start: value ?? item.start } : item)))}
            />
            <span className="form-hint">至</span>
            <TimePicker
              format="HH:mm"
              minuteStep={30}
              value={shift.end}
              onChange={(value) => setShifts((prev) => prev.map((item) => (item.key === shift.key ? { ...item, end: value ?? item.end } : item)))}
            />
            <Select
              style={{ width: 96 }}
              value={shift.status}
              onChange={(value) => setShifts((prev) => prev.map((item) => (item.key === shift.key ? { ...item, status: value } : item)))}
              options={[
                { value: 'available', label: '可约' },
                { value: 'break', label: '休息' },
                { value: 'unavailable', label: '停用' },
              ]}
            />
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => setShifts((prev) => prev.filter((item) => item.key !== shift.key))}
            />
          </Space>
        ))}

        <Button
          block
          type="dashed"
          icon={<PlusOutlined />}
          onClick={() => setShifts((prev) => [...prev, { key: nextShiftKey(), ...afternoonShift(), status: 'available' }])}
        >
          添加班次
        </Button>

        <div className="form-hint" style={{ marginTop: 10 }}>
          <ClockCircleOutlined /> 保存后立即生效：该员工在这些时段内可被顾客预约，其它时间 query_slots 不会返回。
        </div>
      </Modal>

      {/* 复制班次到其他日期/员工 */}
      <Modal
        title={<Space><CopyOutlined /> 复制当前班次</Space>}
        open={copyOpen}
        onCancel={() => setCopyOpen(false)}
        width={520}
        footer={[
          <Button key="cancel" onClick={() => setCopyOpen(false)}>取消</Button>,
          <Button key="ok" type="primary" loading={saving} onClick={() => void handleCopyTo()}>
            复制（覆盖所选日期该员工的班次）
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <div className="form-hint" style={{ marginBottom: 6 }}>复制给哪位员工：</div>
            <Select
              style={{ width: 220 }}
              value={copyStaffId}
              onChange={(value) => setCopyStaffId(value)}
              options={staff.map((item) => ({ value: item.id, label: item.name }))}
            />
          </div>
          <div>
            <div className="form-hint" style={{ marginBottom: 6 }}>
              复制到本月哪些日期（班次：{shifts.map((shift) => `${shift.start.format('HH:mm')}-${shift.end.format('HH:mm')}`).join('、')}）：
            </div>
            <Checkbox.Group
              value={copyTargetDates}
              onChange={(values) => setCopyTargetDates(values as string[])}
              options={calendarCells
                .filter((cell) => cell.isSame(monthAnchor, 'month'))
                .map((cell) => ({ value: cell.format('YYYY-MM-DD'), label: cell.format('MM-DD ddd').replace('ddd', ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][cell.day()]) }))}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', rowGap: 6 }}
            />
          </div>
        </Space>
      </Modal>

      {/* 周模板铺班 */}
      <Modal
        title={<Space><CalendarOutlined /> 周模板铺班</Space>}
        open={weeklyOpen}
        onCancel={() => setWeeklyOpen(false)}
        width={560}
        footer={[
          <Button key="cancel" onClick={() => setWeeklyOpen(false)}>取消</Button>,
          <Button key="ok" type="primary" loading={weeklySaving} onClick={() => void handleApplyWeekly()}>
            铺班（只填空白天，不覆盖已有排班）
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <div className="form-hint" style={{ marginBottom: 6 }}>员工：</div>
            <Select
              style={{ width: 220 }}
              value={weeklyStaffId}
              onChange={(value) => setWeeklyStaffId(value)}
              options={staff.map((item) => ({ value: item.id, label: item.name }))}
            />
          </div>
          <div>
            <div className="form-hint" style={{ marginBottom: 6 }}>日期范围：</div>
            <DatePicker.RangePicker
              value={weeklyRange}
              onChange={(value) => value && value[0] && value[1] && setWeeklyRange([value[0], value[1]])}
              allowClear={false}
            />
          </div>
          <div>
            <div className="form-hint" style={{ marginBottom: 6 }}>每周几上班：</div>
            <Checkbox.Group
              value={weeklyDays}
              onChange={(values) => setWeeklyDays(values as number[])}
              options={[
                { value: 1, label: '周一' },
                { value: 2, label: '周二' },
                { value: 3, label: '周三' },
                { value: 4, label: '周四' },
                { value: 5, label: '周五' },
                { value: 6, label: '周六' },
                { value: 7, label: '周日' },
              ]}
            />
          </div>
          <div>
            <div className="form-hint" style={{ marginBottom: 6 }}>每周班次：</div>
            {weeklyShifts.map((shift, index) => (
              <Space key={shift.key} wrap align="center" style={{ display: 'flex', marginBottom: 8 }}>
                <span className="form-hint" style={{ width: 44 }}>班次 {index + 1}</span>
                <TimePicker
                  format="HH:mm"
                  minuteStep={30}
                  value={shift.start}
                  onChange={(value) => setWeeklyShifts((prev) => prev.map((item) => (item.key === shift.key ? { ...item, start: value ?? item.start } : item)))}
                />
                <span className="form-hint">至</span>
                <TimePicker
                  format="HH:mm"
                  minuteStep={30}
                  value={shift.end}
                  onChange={(value) => setWeeklyShifts((prev) => prev.map((item) => (item.key === shift.key ? { ...item, end: value ?? item.end } : item)))}
                />
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => setWeeklyShifts((prev) => prev.filter((item) => item.key !== shift.key))}
                />
              </Space>
            ))}
            <Button
              block
              type="dashed"
              icon={<PlusOutlined />}
              onClick={() => setWeeklyShifts((prev) => [...prev, { key: nextShiftKey(), ...afternoonShift(), status: 'available' }])}
            >
              添加班次
            </Button>
          </div>
          <div className="form-hint">
            <ClockCircleOutlined /> 只对"当前没有任何班次"的日期生效，已手动排过的日期保持原样。
          </div>
        </Space>
      </Modal>
    </div>
  );
}
