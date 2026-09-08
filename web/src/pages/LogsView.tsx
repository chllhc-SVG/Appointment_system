import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  FireOutlined,
  ReloadOutlined,
  RobotOutlined,
  RiseOutlined,
  ToolOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Button,
  Card,
  Col,
  Drawer,
  Input,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import { api, type McpCallLog, type McpCallLogStats } from '../api/client';

const { Title, Paragraph, Text } = Typography;

const TOOL_LABELS: Record<string, string> = {
  list_booking_reference: '门店列表',
  list_store_services: '门店项目',
  list_store_staff: '门店员工',
  list_staff_availability: '员工排班',
  query_slots: '查询可用时段',
  query_bookings: '查询预约',
  manage_booking: '预约动作',
  manage_customer_session: '顾客会话',
};

const transportColors: Record<string, string> = {
  'streamable-http': 'blue',
  sse: 'cyan',
  stdio: 'purple',
};

function summarizeJson(value: unknown, max = 200): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  try {
    const text = JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return '[unserializable]';
  }
}

function highlightJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '{}';
  }
}

const trendColor = '#7c5cff';

function SuccessRateDonut({ stats }: { stats: McpCallLogStats }) {
  return (
    <div className="log-donut">
      <Progress
        type="dashboard"
        percent={stats.successRate}
        strokeColor={{ '0%': '#7c5cff', '100%': '#13c2c2' }}
        trailColor="rgba(20, 16, 43, 0.08)"
        size={150}
        format={(percent) => (
          <div>
            <div className="donut-value">{percent}%</div>
            <div className="donut-label">成功率</div>
          </div>
        )}
      />
      <div className="donut-legend">
        <span><i className="dot dot-ok" />成功 {stats.success}</span>
        <span><i className="dot dot-bad" />失败 {stats.failure}</span>
        <span>共 {stats.total} 次</span>
      </div>
    </div>
  );
}

function DailyTrendChart({ stats }: { stats: McpCallLogStats }) {
  const days = useMemo(() => {
    const list: string[] = [];
    for (let i = 13; i >= 0; i--) list.push(dayjs().subtract(i, 'day').format('YYYY-MM-DD'));
    return list;
  }, []);

  const byDate = useMemo(() => {
    const map = new Map<string, { total: number; success: number }>();
    for (const row of stats.dailyTrend) map.set(row.date, { total: row.total, success: row.success });
    return map;
  }, [stats.dailyTrend]);

  const [_, maxTotal] = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (const row of stats.dailyTrend) {
      min = Math.min(min, row.total);
      max = Math.max(max, row.total);
    }
    return [min, Math.max(max, 1)];
  }, [stats.dailyTrend]);

  return (
    <div className="trend-chart">
      {days.map((date) => {
        const row = byDate.get(date) ?? { total: 0, success: 0 };
        const height = Math.max(3, Math.round((row.total / maxTotal) * 96));
        return (
          <Tooltip
            key={date}
            title={`${dayjs(date).format('MM-DD')}：${row.total} 次（成功 ${row.success}）`}
          >
            <div className="trend-col">
              <div className="trend-stack">
                <div className="trend-bar" style={{ height, background: trendColor }} />
              </div>
              <div className="trend-label">{dayjs(date).format('DD')}</div>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

function RankBars<T extends { count: number }>({ items, labelOf, colorOf }: {
  items: T[];
  labelOf: (item: T) => string;
  colorOf: (item: T, index: number) => string;
}) {
  const max = Math.max(1, ...items.map((item) => item.count));
  return (
    <div className="rank-list">
      {items.map((item, index) => (
        <div key={labelOf(item)} className="rank-row">
          <span className="rank-index">{index + 1}</span>
          <span className="rank-label" title={labelOf(item)}>{labelOf(item)}</span>
          <span className="rank-track"><i style={{ width: `${Math.max(4, (item.count / max) * 100)}%`, background: colorOf(item, index) }} /></span>
          <span className="rank-count">{item.count}</span>
        </div>
      ))}
      {items.length === 0 && <Text type="secondary">暂无数据</Text>}
    </div>
  );
}

const RANK_COLORS = ['#7c5cff', '#5b8def', '#13c2c2', '#52c41a', '#eb2f96', '#fa8c16', '#f5222d', '#1677ff', '#722ed1', '#a0d911'];

export function LogsView() {
  const [logs, setLogs] = useState<McpCallLog[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<McpCallLogStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [toolName, setToolName] = useState<string | undefined>();
  const [status, setStatus] = useState<'success' | 'failure' | undefined>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selected, setSelected] = useState<McpCallLog | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pageRes, statsRes] = await Promise.all([
        api.mcpCallLogs({
          keyword: keyword || undefined,
          tool_name: toolName,
          status,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        }),
        api.mcpCallLogStats(),
      ]);
      setLogs(pageRes.items);
      setTotal(pageRes.total);
      setStats(statsRes.stats);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载调用日志失败');
    } finally {
      setLoading(false);
    }
  }, [keyword, toolName, status, page, pageSize, version]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => {
    setSelectedKeys([]);
    setVersion((v) => v + 1);
  };

  const deleteOne = (record: McpCallLog) => {
    Modal.confirm({
      title: '删除该条调用日志？',
      icon: <WarningOutlined style={{ color: '#ff4d4f' }} />,
      content: `${dayjs(record.created_at).format('YYYY-MM-DD HH:mm:ss')} · ${record.tool_name}（${record.request_id}）`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const result = await api.deleteMcpCallLog(record.id);
          if (!result.deleted) message.info('日志不存在或已被删除');
          else message.success('已删除');
          setSelectedKeys((keys) => keys.filter((key) => key !== record.id));
          setVersion((v) => v + 1);
        } catch (error) {
          message.error(error instanceof Error ? error.message : '删除失败');
        }
      },
    });
  };

  const batchDelete = () => {
    const ids = selectedKeys.map(String);
    if (ids.length === 0) return;
    Modal.confirm({
      title: `删除选中的 ${ids.length} 条调用日志？`,
      icon: <WarningOutlined style={{ color: '#ff4d4f' }} />,
      content: '删除后不可恢复。',
      okText: `批量删除（${ids.length}）`,
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const result = await api.deleteMcpCallLogs(ids);
          message.success(`已删除 ${result.deleted} 条`);
          setSelectedKeys([]);
          setVersion((v) => v + 1);
        } catch (error) {
          message.error(error instanceof Error ? error.message : '批量删除失败');
        }
      },
    });
  };

  const selectAllPage = () => {
    setSelectedKeys(logs.map((log) => log.id));
  };

  const successCount = logs.filter((log) => log.success).length;
  const failureCount = logs.length - successCount;
  const avgDuration = logs.length > 0 ? Math.round(logs.reduce((sum, log) => sum + (log.duration_ms ?? 0), 0) / logs.length) : 0;

  return (
    <div className="view-stack">
      <Card className="page-header-card" variant="borderless">
        <div className="hero-kicker page-kicker">MCP Call Logs</div>
        <Title level={2} className="page-title">调用日志中心</Title>
        <Paragraph className="page-desc">
          数字人 / 大模型每次通过 Appointment MCP 调用工具的记录：调用方身份、工具、参数、结果与耗时。
          支持按工具、状态、调用方过滤，图表区展示近 14 天调用趋势与工具 Top 榜。
        </Paragraph>
      </Card>

      {stats && (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} lg={6}>
              <Card className="section-card chart-card" variant="borderless">
                <div className="module-title"><RiseOutlined /> 成功率</div>
                <SuccessRateDonut stats={stats} />
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card className="section-card chart-card" variant="borderless">
                <div className="module-title"><FireOutlined /> 工具 Top</div>
                <RankBars
                  items={stats.topTools}
                  labelOf={(item) => item.tool_name}
                  colorOf={(_, index) => RANK_COLORS[index % RANK_COLORS.length]}
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card className="section-card chart-card" variant="borderless">
                <div className="module-title"><RobotOutlined /> 调用方 Top</div>
                <RankBars
                  items={stats.topAgents}
                  labelOf={(item) => item.agent_code ?? '匿名'}
                  colorOf={(_, index) => RANK_COLORS[(index + 3) % RANK_COLORS.length]}
                />
              </Card>
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <Card className="section-card chart-card" variant="borderless">
                <div className="module-title"><WarningOutlined /> 失败错误码</div>
                <RankBars
                  items={stats.topErrorCodes}
                  labelOf={(item) => item.error_code ?? 'UNKNOWN'}
                  colorOf={(_, index) => RANK_COLORS[(index + 5) % RANK_COLORS.length]}
                />
              </Card>
            </Col>
          </Row>

          <Card
            title={<span className="module-title"><ToolOutlined /> 近 14 天调用频率</span>}
            className="section-card chart-card"
            variant="borderless"
            extra={<Text type="secondary">共 {stats.total} 次调用</Text>}
          >
            <DailyTrendChart stats={stats} />
          </Card>
        </>
      )}

      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}>
          <Card className="metric-card" variant="borderless">
            <Statistic
              title="当前页调用"
              value={logs.length}
              prefix={<ApiOutlined style={{ color: '#7c5cff' }} />}
              valueStyle={{ color: '#7c5cff', fontWeight: 800 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card className="metric-card" variant="borderless">
            <Statistic
              title="成功"
              value={successCount}
              prefix={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
              valueStyle={{ color: '#52c41a', fontWeight: 800 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card className="metric-card" variant="borderless">
            <Statistic
              title="失败"
              value={failureCount}
              prefix={<CloseCircleOutlined style={{ color: '#ff4d4f' }} />}
              valueStyle={{ color: '#ff4d4f', fontWeight: 800 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card className="metric-card" variant="borderless">
            <Statistic
              title="平均耗时"
              value={avgDuration}
              suffix="ms"
              prefix={<DatabaseOutlined style={{ color: '#13c2c2' }} />}
              valueStyle={{ color: '#13c2c2', fontWeight: 800 }}
            />
          </Card>
        </Col>
      </Row>

      <Card className="section-card" variant="borderless">
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search
            placeholder="工具名 / 调用方关键字"
            allowClear
            style={{ width: 220 }}
            onSearch={(value) => {
              setKeyword(value);
              setPage(1);
            }}
            onClear={() => {
              setKeyword('');
              setPage(1);
            }}
          />
          <Select
            placeholder="工具"
            allowClear
            showSearch
            style={{ width: 220 }}
            value={toolName}
            onChange={(value) => {
              setToolName(value);
              setPage(1);
            }}
            options={Object.entries(TOOL_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <Select
            placeholder="结果"
            allowClear
            style={{ width: 120 }}
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            options={[
              { value: 'success', label: '成功' },
              { value: 'failure', label: '失败' },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
        </Space>

        {selectedKeys.length > 0 && (
          <Space style={{ marginBottom: 12 }}>
            <Text type="secondary">已选 {selectedKeys.length} 条</Text>
            <Button size="small" onClick={selectAllPage}>全选本页</Button>
            <Button size="small" onClick={() => setSelectedKeys([])}>取消选择</Button>
            <Button size="small" danger icon={<DeleteOutlined />} onClick={batchDelete}>
              批量删除
            </Button>
          </Space>
        )}

        <Table<McpCallLog>
          rowKey="id"
          dataSource={logs}
          loading={loading}
          size="middle"
          scroll={{ x: 1180 }}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: (keys) => setSelectedKeys(keys),
          }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count) => `共 ${count} 条`,
            onChange: (next, size) => {
              setPage(next);
              setPageSize(size);
            },
          }}
          columns={[
            {
              title: '时间',
              dataIndex: 'created_at',
              width: 180,
              render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm:ss'),
            },
            {
              title: '调用方',
              dataIndex: 'agent_code',
              width: 140,
              render: (value: string | null) => (
                value ? <Tag icon={<RobotOutlined />} color="purple">{value}</Tag> : <Tag>匿名</Tag>
              ),
            },
            {
              title: '工具',
              dataIndex: 'tool_name',
              width: 200,
              render: (value: string) => (
                <Typography.Text code>{value}</Typography.Text>
              ),
            },
            {
              title: '说明',
              key: 'tool_desc',
              width: 140,
              render: (_, record) => <Text type="secondary">{TOOL_LABELS[record.tool_name] ?? '-'}</Text>,
            },
            {
              title: '传输',
              dataIndex: 'transport',
              width: 130,
              render: (value: string) => <Tag color={transportColors[value] ?? 'default'}>{value}</Tag>,
            },
            {
              title: '结果',
              dataIndex: 'success',
              width: 90,
              render: (value: boolean) => (value ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag>),
            },
            {
              title: '错误码',
              dataIndex: 'error_code',
              width: 160,
              render: (value: string | null) => (value ? <Typography.Text type="danger"><Tag color="volcano">{value}</Tag></Typography.Text> : '-'),
            },
            {
              title: '耗时',
              dataIndex: 'duration_ms',
              width: 90,
              render: (value: number) => <Text>{value} ms</Text>,
            },
            {
              title: '参数摘要',
              key: 'args',
              ellipsis: true,
              width: 260,
              render: (_, record) => <Text type="secondary" style={{ fontSize: 12 }}>{summarizeJson(record.arguments)}</Text>,
            },
            {
              title: '操作',
              key: 'action',
              width: 160,
              fixed: 'right',
              render: (_, record) => (
                <Space size={4}>
                  <Button size="small" type="link" onClick={() => setSelected(record)}>详情</Button>
                  <Button
                    size="small"
                    type="link"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => deleteOne(record)}
                  >
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        title="MCP 调用详情"
        width={640}
        open={selected !== null}
        onClose={() => setSelected(null)}
        extra={
          selected ? (
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => {
                const record = selected;
                setSelected(null);
                deleteOne(record);
              }}
            >
              删除该条
            </Button>
          ) : null
        }
      >
        {selected && (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            <Card size="small" title="调用信息" variant="borderless">
              <p><b>时间：</b>{dayjs(selected.created_at).format('YYYY-MM-DD HH:mm:ss')}</p>
              <p>
                <b>调用方：</b>
                {selected.agent_code ? <Tag icon={<RobotOutlined />} color="purple">{selected.agent_code}</Tag> : <Tag>匿名</Tag>}
              </p>
              <p><b>工具：</b><Typography.Text code>{selected.tool_name}</Typography.Text>（{TOOL_LABELS[selected.tool_name] ?? '未知工具'}）</p>
              <p><b>传输：</b><Tag color={transportColors[selected.transport] ?? 'default'}>{selected.transport}</Tag></p>
              <p><b>结果：</b>{selected.success ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag>}</p>
              {selected.error_code && <p><b>错误码：</b><Tag color="volcano">{selected.error_code}</Tag></p>}
              <p><b>耗时：</b>{selected.duration_ms} ms</p>
              <p><b>请求号：</b><Typography.Text code>{selected.request_id}</Typography.Text></p>
            </Card>
            <Card size="small" title="调用参数 (arguments)" variant="borderless">
              <pre className="log-json">{highlightJson(selected.arguments)}</pre>
            </Card>
            <Card size="small" title="返回结果 (result)" variant="borderless">
              <pre className="log-json">{highlightJson(selected.result)}</pre>
            </Card>
          </Space>
        )}
      </Drawer>
    </div>
  );
}