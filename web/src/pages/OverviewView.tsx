import { useEffect, useState } from 'react';
import {
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  ExperimentOutlined,
  ScheduleOutlined,
} from '@ant-design/icons';
import { Card, Col, Row, Spin, Table, Typography, message } from 'antd';
import { api, type AppointmentListItem, type AppointmentStatus, type OverviewStats } from '../api/client';
import { StatusTag } from '../components/StatusTag';

const { Title, Paragraph, Text } = Typography;

const METRIC_DEFS: Array<{ key: keyof OverviewStats; label: string; color: string; icon: React.ReactNode }> = [
  { key: 'total', label: '总预约', color: '#7c5cff', icon: <CalendarOutlined /> },
  { key: 'confirmed', label: '已确认', color: '#1677ff', icon: <CheckCircleOutlined /> },
  { key: 'checked_in', label: '已到店', color: '#13c2c2', icon: <ScheduleOutlined /> },
  { key: 'completed', label: '已完成', color: '#52c41a', icon: <CheckCircleOutlined /> },
  { key: 'cancelled', label: '已取消', color: '#ff4d4f', icon: <CloseCircleOutlined /> },
  { key: 'no_show', label: '爽约', color: '#eb2f96', icon: <ExperimentOutlined /> },
];

export function OverviewView() {
  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const [recent, setRecent] = useState<AppointmentListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [ov, list] = await Promise.all([api.overview(), api.appointments({ limit: 8 })]);
        if (!alive) return;
        setOverview(ov.overview);
        setRecent(list.items);
      } catch (error) {
        message.error(error instanceof Error ? error.message : '加载概览失败');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return <div className="loading-center"><Spin size="large" /></div>;
  }

  return (
    <div className="view-stack">
      <Card className="page-header-card" variant="borderless">
        <div className="hero-kicker page-kicker">Dashboard</div>
        <Title level={2} className="page-title">预约概览</Title>
        <Paragraph className="page-desc">
          数字人通过 Appointment MCP 为客户完成咨询、预约、查询、取消与改期；门店在这里统一管理排班与到店服务流转。
        </Paragraph>
      </Card>

      <Row gutter={[16, 16]}>
        {METRIC_DEFS.map((metric) => (
          <Col xs={12} sm={8} lg={4} key={metric.key}>
            <Card className="metric-card" variant="borderless">
              <div className="metric-value" style={{ color: metric.color }}>
                {overview?.[metric.key] ?? 0}
              </div>
              <div className="metric-label">
                <span style={{ color: metric.color }}>{metric.icon}</span>
                {metric.label}
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      <Card title={<span className="module-title"><ClockCircleOutlined /> 最近预约</span>} className="section-card" variant="borderless">
        <Table<AppointmentListItem>
          rowKey={(record) => record.appointment.id}
          dataSource={recent}
          pagination={false}
          size="middle"
          scroll={{ x: 720 }}
          columns={[
            { title: '预约码', dataIndex: ['appointment', 'appointment_code'], width: 210 },
            { title: '客户', dataIndex: ['appointment', 'customer_name'], width: 110 },
            { title: '项目', dataIndex: 'service_name', width: 140 },
            { title: '门店', dataIndex: 'store_name', width: 140 },
            {
              title: '开始时间',
              dataIndex: ['appointment', 'start_at'],
              width: 180,
              render: (value: string) => new Date(value).toLocaleString('zh-CN'),
            },
            {
              title: '结束时间',
              dataIndex: ['appointment', 'end_at'],
              width: 100,
              render: (value: string) => <span className="end-time-cell">{new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>,
            },
            {
              title: '状态',
              dataIndex: ['appointment', 'status'],
              width: 100,
              render: (value: AppointmentStatus) => <StatusTag status={value} />,
            },
          ]}
        />
      </Card>

      <Text type="secondary" className="footer-note">
        Tips：新建预约时请先确认门店、项目与员工，再查询当日可用时段，避免时间冲突。
      </Text>
    </div>
  );
}