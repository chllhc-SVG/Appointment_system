import { useCallback, useEffect, useState } from 'react';
import {
  CheckOutlined,
  CloseOutlined,
  ExperimentOutlined,
  FieldTimeOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  Button,
  Card,
  DatePicker,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { api, type AppointmentListItem, type AppointmentStatus, type Store } from '../api/client';
import { STATUS_OPTIONS } from '../components/StatusTag';

const { Title, Paragraph } = Typography;

const STATUS_COLORS: Record<string, string> = {
  pending: 'gold',
  confirmed: 'blue',
  checked_in: 'cyan',
  completed: 'green',
  cancelled: 'red',
  no_show: 'purple',
};

export function AppointmentsView() {
  const [items, setItems] = useState<AppointmentListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<AppointmentStatus | undefined>();
  const [storeId, setStoreId] = useState<string | undefined>();
  const [stores, setStores] = useState<Store[]>([]);
  const [detail, setDetail] = useState<{ appointment: AppointmentListItem['appointment']; audits: Array<{ action: string; operator_type: string; operator_id: string; created_at: string }> } | null>(null);
  const [showReschedule, setShowReschedule] = useState<AppointmentListItem | null>(null);
  const [rescheduleForm] = Form.useForm<{ date: Dayjs; time: Dayjs }>();
  const [rescheduling, setRescheduling] = useState(false);
  const [listVersion, setListVersion] = useState(0);

  useEffect(() => {
    api.stores().then((res) => setStores(res.stores)).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query: Record<string, unknown> = {
        limit: 50,
      };
      if (status) (query as Record<string, string>).status = status;
      if (storeId) (query as Record<string, string>).store_id = storeId;
      if (keyword.trim()) (query as Record<string, string>).keyword = keyword.trim();
      const res = await api.appointments(query as Parameters<typeof api.appointments>[0]);
      setItems(res.items);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载预约失败');
    } finally {
      setLoading(false);
    }
  }, [status, storeId, keyword, listVersion]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => setListVersion((v) => v + 1), 30000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = () => setListVersion((v) => v + 1);

  const openDetail = async (id: string) => {
    try {
      const res = await api.appointmentDetail(id);
      setDetail({ appointment: res.appointment, audits: res.audits });
    } catch {
      message.error('无法加载详情');
    }
  };

  const transition = async (id: string, action: 'confirm' | 'cancel' | 'check-in' | 'complete' | 'no-show') => {
    try {
      const res = await api.transition(id, action);
      if (res.success) {
        message.success('操作成功');
        refresh();
      } else {
        message.error(res.message ?? `操作失败：${res.error_code ?? ''}`);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    }
  };

  const onReschedule = async () => {
    if (!showReschedule) return;
    setRescheduling(true);
    try {
      const values = await rescheduleForm.validateFields();
      const startAt = dayjs(values.date).hour(dayjs(values.time).hour()).minute(dayjs(values.time).minute()).second(0).millisecond(0);
      const res = await api.reschedule(showReschedule.appointment.id, {
        new_start_at: startAt.toISOString(),
      });
      if (res.success) {
        message.success('已改期');
        setShowReschedule(null);
        refresh();
      } else {
        message.error(res.message ?? '改期失败');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '改期失败');
    } finally {
      setRescheduling(false);
    }
  };

  return (
    <div className="view-stack">
      <Card className="page-header-card" variant="borderless">
        <Title level={2} className="page-title">预约管理</Title>
        <Paragraph className="page-desc">筛选、确认、签到、完成、取消、爽约与改期，覆盖预约全生命周期。结束时间 = 开始时间 + 项目时长（建单时落库）。</Paragraph>
      </Card>

      <Card className="section-card" variant="borderless">
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search
            placeholder="客户姓名 / 手机号 / 预约码"
            allowClear
            style={{ width: 240 }}
            onSearch={(value) => {
              setKeyword(value);
              refresh();
            }}
            onClear={() => {
              setKeyword('');
              refresh();
            }}
          />
          <Select
            placeholder="状态"
            allowClear
            style={{ width: 140 }}
            value={status}
            onChange={(value) => {
              setStatus(value);
              refresh();
            }}
            options={STATUS_OPTIONS}
          />
          <Select
            placeholder="门店"
            allowClear
            style={{ width: 180 }}
            value={storeId}
            onChange={(value) => {
              setStoreId(value);
              refresh();
            }}
            options={stores.map((store) => ({ value: store.id, label: store.name }))}
          />
          <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
        </Space>

        <Table<AppointmentListItem>
          rowKey={(record) => record.appointment.id}
          dataSource={items}
          loading={loading}
          size="middle"
          scroll={{ x: 1300 }}
          pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['20', '50'] }}
          columns={[
            {
              title: '预约码',
              dataIndex: ['appointment', 'appointment_code'],
              width: 200,
              render: (value: string) => <Typography.Text copyable code title={value}>{value}</Typography.Text>,
            },
            { title: '客户', dataIndex: ['appointment', 'customer_name'], width: 100 },
            { title: '手机号', dataIndex: ['appointment', 'customer_phone'], width: 130 },
            { title: '项目', dataIndex: 'service_name', width: 130 },
            { title: '门店', dataIndex: 'store_name', width: 130 },
            { title: '员工', dataIndex: 'staff_name', width: 100 },
            {
              title: '开始时间',
              dataIndex: ['appointment', 'start_at'],
              width: 170,
              sorter: (a, b) => +new Date(a.appointment.start_at) - +new Date(b.appointment.start_at),
              render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm'),
            },
            {
              title: '结束时间',
              dataIndex: ['appointment', 'end_at'],
              width: 100,
              render: (value: string, record) => (
                <Tooltip title={`按「${record.service_name}」时长推算（开始 + 项目时长）`}>
                  <span className="end-time-cell">{dayjs(value).format('HH:mm')}</span>
                </Tooltip>
              ),
            },
            {
              title: '创建时间',
              dataIndex: ['appointment', 'created_at'],
              width: 170,
              defaultSortOrder: 'descend' as const,
              sorter: (a, b) => +new Date(a.appointment.created_at) - +new Date(b.appointment.created_at),
              render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm:ss'),
            },
            {
              title: '状态',
              dataIndex: ['appointment', 'status'],
              width: 90,
              render: (value: AppointmentStatus) => <Tag color={STATUS_COLORS[value]}>{value}</Tag>,
            },
            {
              title: '操作',
              width: 320,
              render: (_, record) => {
                const { status } = record.appointment;
                return (
                  <Space size={4} wrap>
                    <Button size="small" onClick={() => void openDetail(record.appointment.id)}>详情</Button>
                    {status === 'pending' && (
                      <Button size="small" type="primary" onClick={() => void transition(record.appointment.id, 'confirm')}>确认</Button>
                    )}
                    {status === 'confirmed' && (
                      <>
                        <Button size="small" onClick={() => void transition(record.appointment.id, 'check-in')}>签到</Button>
                        <Button size="small" danger onClick={() => void transition(record.appointment.id, 'no-show')}>爽约</Button>
                      </>
                    )}
                    {status === 'checked_in' && (
                      <Button size="small" type="primary" onClick={() => void transition(record.appointment.id, 'complete')}>完成</Button>
                    )}
                    {(status === 'pending' || status === 'confirmed') && (
                      <>
                        <Button size="small" onClick={() => setShowReschedule(record)}>改期</Button>
                        <Popconfirm title="确认取消该预约？" onConfirm={() => void transition(record.appointment.id, 'cancel')}>
                          <Button size="small" danger>取消</Button>
                        </Popconfirm>
                      </>
                    )}
                  </Space>
                );
              },
            },
          ]}
        />
      </Card>

      <Drawer
        title="预约详情与审计轨迹"
        width={520}
        open={detail !== null}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            <Card size="small" title="预约信息" variant="borderless">
              <p><b>预约码：</b>{detail.appointment.appointment_code}</p>
              <p><b>客户：</b>{detail.appointment.customer_name}（{detail.appointment.customer_phone}）</p>
              <p><b>时间：</b>{dayjs(detail.appointment.start_at).format('YYYY-MM-DD HH:mm')} - {dayjs(detail.appointment.end_at).format('HH:mm')}</p>
              <p><b>状态：</b><Tag color={STATUS_COLORS[detail.appointment.status]}>{detail.appointment.status}</Tag></p>
              {detail.appointment.note && <p><b>备注：</b>{detail.appointment.note}</p>}
            </Card>
            <Card size="small" title="审计轨迹" variant="borderless">
              {detail.audits.length === 0 ? (
                <Typography.Text type="secondary">暂无审计记录</Typography.Text>
              ) : (
                detail.audits.map((audit) => (
                  <p key={audit.created_at + audit.action + audit.operator_id}>
                    {dayjs(audit.created_at).format('MM-DD HH:mm:ss')} · <Tag>{audit.action}</Tag> · {audit.operator_type}：{audit.operator_id}
                  </p>
                ))
              )}
            </Card>
          </Space>
        )}
      </Drawer>

      <Modal
        title="改期"
        open={showReschedule !== null}
        onCancel={() => setShowReschedule(null)}
        onOk={onReschedule}
        confirmLoading={rescheduling}
        okText="确认改期"
      >
        {showReschedule && (
          <Form form={rescheduleForm} layout="vertical" initialValues={{ date: dayjs(showReschedule.appointment.start_at), time: dayjs(showReschedule.appointment.start_at) }}>
            <Form.Item name="date" label="新日期" rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="time" label="新时间" rules={[{ required: true }]}>
              <DatePicker picker="time" style={{ width: '100%' }} format="HH:mm" />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  );
}