import { useEffect, useMemo, useState } from 'react';
import { ClockCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Card, DatePicker, Select, Space, Table, Tag, Typography, message } from 'antd';
import dayjs from 'dayjs';
import { api, type StaffSchedule, type StaffWithSkills, type Store } from '../api/client';

const { Title, Paragraph } = Typography;

const SCHEDULE_COLORS: Record<string, string> = {
  available: 'green',
  unavailable: 'default',
  break: 'orange',
};

export function SchedulesView() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState<string>();
  const [staff, setStaff] = useState<StaffWithSkills[]>([]);
  const [staffId, setStaffId] = useState<string>();
  const [range, setRange] = useState<[string, string]>([
    dayjs().format('YYYY-MM-DD'),
    dayjs().add(6, 'day').format('YYYY-MM-DD'),
  ]);
  const [schedules, setSchedules] = useState<StaffSchedule[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.stores().then((res) => setStores(res.stores)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!storeId) {
      setStaff([]);
      setStaffId(undefined);
      return;
    }
    api.staff({ store_id: storeId }).then((res) => setStaff(res.staff)).catch(() => setStaff([]));
  }, [storeId]);

  const load = async () => {
    if (!staffId) {
      message.warning('请先选择员工');
      return;
    }
    setLoading(true);
    try {
      const res = await api.schedules(staffId, range[0], range[1]);
      setSchedules(res.schedules);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载排班失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (staffId && range[0] && range[1]) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffId, range[0], range[1]]);

  const days = useMemo(() => {
    const from = dayjs(range[0]);
    const to = dayjs(range[1]);
    const result: string[] = [];
    for (let cursor = from; cursor.isBefore(to) || cursor.isSame(to, 'day'); cursor = cursor.add(1, 'day')) {
      result.push(cursor.format('YYYY-MM-DD'));
    }
    return result;
  }, [range]);

  const occupiedByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const schedule of schedules) {
      const { start_at: start, end_at: end, status } = schedule;
      if (status !== 'available') continue;
      const startDay = dayjs(start);
      const endDay = dayjs(end);
      for (let cursor = startDay; cursor.isBefore(endDay) || cursor.isSame(endDay, 'day'); cursor = cursor.add(1, 'day')) {
        const key = cursor.format('YYYY-MM-DD');
        const hours = Math.min(
          endDay.diff(cursor, 'hour', true),
          cursor.add(1, 'day').diff(cursor, 'hour', true),
        );
        map.set(key, (map.get(key) ?? 0) + hours);
      }
    }
    return map;
  }, [schedules]);

  return (
    <div className="view-stack">
      <Card className="page-header-card" variant="borderless">
        <Title level={2} className="page-title">员工排班</Title>
        <Paragraph className="page-desc">查看员工在指定日期范围内的排班与可服务时长。</Paragraph>
      </Card>

      <Card className="section-card" variant="borderless">
        <Space wrap style={{ marginBottom: 16 }}>
          <Select
            placeholder="选择门店"
            style={{ width: 200 }}
            value={storeId}
            onChange={(value) => {
              setStoreId(value);
              setStaffId(undefined);
              setSchedules([]);
            }}
            options={stores.map((store) => ({ value: store.id, label: store.name }))}
          />
          <Select
            placeholder="选择员工"
            style={{ width: 200 }}
            disabled={!storeId}
            value={staffId}
            onChange={(value) => {
              setStaffId(value);
              setSchedules([]);
            }}
            options={staff.map((item) => ({ value: item.id, label: item.name }))}
          />
          <DatePicker.RangePicker
            value={[dayjs(range[0]), dayjs(range[1])]}
            onChange={(values) => {
              if (!values || !values[0] || !values[1]) return;
              setRange([values[0].format('YYYY-MM-DD'), values[1].format('YYYY-MM-DD')]);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
        </Space>

        <Table<StaffSchedule>
          rowKey="id"
          dataSource={schedules}
          loading={loading}
          size="middle"
          pagination={false}
          columns={[
            {
              title: '员工',
              dataIndex: 'staff_id',
              width: 140,
              render: () => staff.find((item) => item.id === staffId)?.name ?? staffId,
            },
            {
              title: '开始',
              dataIndex: 'start_at',
              width: 180,
              render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm'),
            },
            {
              title: '结束',
              dataIndex: 'end_at',
              width: 180,
              render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm'),
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 120,
              render: (value: string) => <Tag color={SCHEDULE_COLORS[value]}>{value}</Tag>,
            },
          ]}
        />

        {staffId && days.length > 0 && (
          <Card size="small" title={`可服务时长（小时 / 天）`} variant="borderless" style={{ marginTop: 16 }}>
            <Space wrap>
              {days.map((day) => (
                <div key={day} className="day-chip">
                  <div className="day-chip-date">{dayjs(day).format('MM-DD')}</div>
                  <div className="day-chip-hours">
                    <ClockCircleOutlined /> {occupiedByDay.get(day) ?? 0} h
                  </div>
                </div>
              ))}
            </Space>
          </Card>
        )}
      </Card>
    </div>
  );
}