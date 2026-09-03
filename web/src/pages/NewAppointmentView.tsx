import { useEffect, useMemo, useState } from 'react';
import { CalendarOutlined, LeftOutlined, RightOutlined, UserOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import { api, type ServiceWithStats, type StaffWithSkills, type Store, type TimeSlot } from '../api/client';

const { Title, Paragraph } = Typography;

interface SlotGroup {
  staff_id: string;
  staff_name: string;
  slots: TimeSlot[];
}

export function NewAppointmentView() {
  const [stores, setStores] = useState<Store[]>([]);
  const [services, setServices] = useState<ServiceWithStats[]>([]);
  const [staff, setStaff] = useState<StaffWithSkills[]>([]);
  const [storeId, setStoreId] = useState<string>();
  const [serviceId, setServiceId] = useState<string>();
  const [date, setDate] = useState<string>();
  const [staffId, setStaffId] = useState<string>();
  const [groups, setGroups] = useState<SlotGroup[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    api.stores().then((res) => setStores(res.stores)).catch((error) => message.error(String(error)));
  }, []);

  useEffect(() => {
    if (!storeId) {
      setServices([]);
      return;
    }
    api.services({ store_id: storeId, bookable: true }).then((res) => setServices(res.services)).catch(() => setServices([]));
  }, [storeId]);

  useEffect(() => {
    if (!storeId || !serviceId) {
      setStaff([]);
      return;
    }
    api.staff({ store_id: storeId, service_id: serviceId }).then((res) => setStaff(res.staff)).catch(() => setStaff([]));
  }, [storeId, serviceId]);

  const querySlots = async () => {
    if (!serviceId || !date) {
      message.warning('请先选择项目与日期');
      return;
    }
    setLoading(true);
    try {
      const res = await api.availableSlots({ service_id: serviceId, store_id: storeId, date, preferred_staff_id: staffId });
      if (!res.success || !res.slots) {
        message.warning(res.message ?? '没有可用时段');
        setGroups([]);
        return;
      }
      const grouped = res.slots.reduce<Record<string, SlotGroup>>((acc, slot) => {
        const key = slot.staff_id;
        if (!acc[key]) acc[key] = { staff_id: key, staff_name: slot.staff_name, slots: [] };
        acc[key].slots.push(slot);
        return acc;
      }, {});
      setGroups(Object.values(grouped));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '查询失败');
    } finally {
      setLoading(false);
    }
  };

  const openConfirm = () => {
    if (!selectedSlot) {
      message.warning('请先选择一个时段');
      return;
    }
    setConfirmOpen(true);
  };

  const create = async () => {
    if (!selectedSlot) return;
    setCreating(true);
    try {
      const values = await form.validateFields();
      const res = await api.createAppointment({
        store_id: storeId ?? '',
        service_id: serviceId ?? '',
        staff_id: selectedSlot.staff_id,
        start_at: selectedSlot.start_at,
        customer_name: values.customer_name,
        customer_phone: values.customer_phone,
        note: values.note,
      });
      if (res.success) {
        message.success('预约创建成功');
        setConfirmOpen(false);
        form.resetFields();
        setGroups([]);
        setSelectedSlot(null);
      } else {
        message.error(res.message ?? '创建失败');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const step = useMemo(() => {
    if (!storeId) return 'store';
    if (!serviceId) return 'service';
    if (!date) return 'date';
    return groups.length > 0 || selectedSlot ? 'slot' : 'slot';
  }, [storeId, serviceId, date, groups, selectedSlot]);

  return (
    <div className="view-stack">
      <Card className="page-header-card" variant="borderless">
        <Title level={2} className="page-title">新建预约</Title>
        <Paragraph className="page-desc">选择门店与项目，查询员工可用时段，为客户完成预约。</Paragraph>
      </Card>

      <Card className="section-card" variant="borderless">
        <Tabs
          activeKey={step}
          items={[
            { key: 'service', label: '1. 门店与项目' },
            { key: 'date', label: '2. 选择日期' },
            { key: 'slot', label: '3. 选择时段' },
            { key: 'confirm', label: '4. 填写信息' },
          ]}
        />

        <Space direction="vertical" style={{ width: '100%' }} size={16}>
          <Space wrap>
            <Select
              placeholder="选择门店"
              style={{ width: 220 }}
              value={storeId}
              onChange={(value) => {
                setStoreId(value);
                setServiceId(undefined);
                setGroups([]);
                setSelectedSlot(null);
              }}
              options={stores.map((store) => ({ value: store.id, label: store.name }))}
            />
            <Select
              placeholder="选择项目"
              style={{ width: 220 }}
              disabled={!storeId}
              value={serviceId}
              onChange={(value) => {
                setServiceId(value);
                setGroups([]);
                setSelectedSlot(null);
              }}
              options={services.map((service) => ({
                value: service.id,
                label: `${service.name}（${service.duration_minutes} 分钟）${service.price_cents ? ` ¥${(service.price_cents / 100).toFixed(0)}` : ''}`,
              }))}
            />
            <DatePicker
              disabled={!serviceId}
              onChange={(value) => {
                setDate(value ? value.format('YYYY-MM-DD') : undefined);
                setGroups([]);
                setSelectedSlot(null);
              }}
            />
            <Select
              placeholder="指定员工（可选）"
              allowClear
              style={{ width: 180 }}
              value={staffId}
              onChange={(value) => {
                setStaffId(value);
                setGroups([]);
                setSelectedSlot(null);
              }}
              options={staff.map((item) => ({ value: item.id, label: item.name }))}
            />
            <Button type="primary" icon={<CalendarOutlined />} loading={loading} onClick={() => void querySlots()}>
              查询时段
            </Button>
          </Space>

          {groups.length > 0 && (
            <Table<SlotGroup>
              rowKey="staff_id"
              dataSource={groups}
              pagination={false}
              size="small"
              columns={[
                {
                  title: '员工',
                  dataIndex: 'staff_name',
                  width: 120,
                  render: (value: string) => <span><UserOutlined /> {value}</span>,
                },
                {
                  title: '可用时段',
                  render: (_, group) => (
                    <Space size={[8, 8]} wrap>
                      {group.slots.map((slot) => {
                        const active = selectedSlot?.start_at === slot.start_at && selectedSlot.staff_id === slot.staff_id;
                        return (
                          <Button
                            key={slot.start_at}
                            size="small"
                            type={active ? 'primary' : 'default'}
                            onClick={() => setSelectedSlot(active ? null : slot)}
                          >
                            {dayjs(slot.start_at).format('HH:mm')}
                          </Button>
                        );
                      })}
                    </Space>
                  ),
                },
              ]}
            />
          )}

          <Alert
            type="info"
            showIcon
            message={selectedSlot
              ? `已选择：${selectedSlot.staff_name} ${dayjs(selectedSlot.start_at).format('MM-DD HH:mm')}`
              : '选择时段后，填写客户信息完成预约。'}
          />

          {selectedSlot && (
            <div className="control-panel">
              <Form
                form={form}
                layout="inline"
                initialValues={{ customer_name: '', customer_phone: '', note: '' }}
                style={{ gap: 12 }}
              >
                <Form.Item name="customer_name" label="客户姓名" rules={[{ required: true, message: '请输入姓名' }]}>
                  <Input placeholder="如：张女士" style={{ width: 160 }} />
                </Form.Item>
                <Form.Item name="customer_phone" label="手机号" rules={[{ required: true, message: '请输入手机号' }]}>
                  <Input placeholder="如：13800000000" style={{ width: 180 }} />
                </Form.Item>
                <Form.Item name="note" label="备注">
                  <Input placeholder="可选" style={{ width: 220 }} />
                </Form.Item>
                <Button type="primary" onClick={openConfirm}>提交预约</Button>
              </Form>
            </div>
          )}
        </Space>
      </Card>

      <Modal
        title="确认预约信息"
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onOk={create}
        confirmLoading={creating}
        okText="确认创建"
      >
        <div>
          <p><b>门店：</b>{stores.find((item) => item.id === storeId)?.name ?? storeId}</p>
          <p><b>项目：</b>{services.find((item) => item.id === serviceId)?.name ?? serviceId}</p>
          <p><b>员工：</b>{selectedSlot?.staff_name}</p>
          <p><b>时间：</b>{selectedSlot ? dayjs(selectedSlot.start_at).format('YYYY-MM-DD HH:mm') : ''}</p>
        </div>
      </Modal>
    </div>
  );
}