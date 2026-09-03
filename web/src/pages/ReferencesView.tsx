import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DeleteOutlined,
  DollarOutlined,
  EditOutlined,
  EnvironmentOutlined,
  GlobalOutlined,
  PlusOutlined,
  ReloadOutlined,
  ShopOutlined,
  SyncOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  Button,
  Card,
  Checkbox,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import { api, type ServiceWithStats, type StaffWithSkills, type Store, type SyncResult } from '../api/client';

const { Title, Paragraph } = Typography;

function SyncStatusTag({ service }: { service: ServiceWithStats }) {
  if (service.source_system !== 'knowledge_base') {
    return <Tag color="default">手工维护</Tag>;
  }
  const map: Record<string, { color: string; label: string }> = {
    synced: { color: 'green', label: '已同步' },
    stale: { color: 'orange', label: '知识库已下线' },
    pending: { color: 'blue', label: '同步中' },
    failed: { color: 'red', label: '同步失败' },
    local: { color: 'default', label: '本地' },
  };
  const entry = map[service.sync_status] ?? { color: 'default', label: service.sync_status };
  return <Tooltip title={service.sync_error ?? (service.last_synced_at ? `同步于 ${dayjs(service.last_synced_at).format('MM-DD HH:mm')}` : undefined)}><Tag color={entry.color}>{entry.label}</Tag></Tooltip>;
}

function ActionButtonGroup({
  onEdit,
  onToggle,
  active,
  onDelete,
}: {
  onEdit: () => void;
  onToggle: () => void;
  active: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="action-btn-group">
      <Button size="small" icon={<EditOutlined />} onClick={onEdit}>编辑</Button>
      <Button size="small" icon={<ReloadOutlined />} onClick={onToggle}>{active ? '停用' : '启用'}</Button>
      <Popconfirm
        title="确认操作？"
        description="不会物理删除，历史记录不受影响。"
        onConfirm={onDelete}
        okText="停用"
        cancelText="取消"
        okButtonProps={{ danger: true }}
      >
        <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
      </Popconfirm>
    </div>
  );
}

function storeServicesByCategory(services: ServiceWithStats[]) {
  const map = new Map<string, ServiceWithStats[]>();
  for (const service of services) {
    const category = (service.category?.trim() || '未分类');
    const list = map.get(category) ?? [];
    list.push(service);
    map.set(category, list);
  }
  return Array.from(map.entries());
}

/** 门店可做项目勾选器：按知识库项目分类分组，勾选式选择（不使用手动输入）。 */
function StoreServicePicker({
  services,
  value,
  onChange,
}: {
  services: ServiceWithStats[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const groups = useMemo(() => storeServicesByCategory(services), [services]);

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };
  const toggleGroup = (ids: string[], checked: boolean) => {
    const set = new Set(value);
    for (const id of ids) {
      if (checked) set.add(id);
      else set.delete(id);
    }
    onChange(Array.from(set));
  };

  if (groups.length === 0) {
    return (
      <div className="service-picker-empty">
        <SyncOutlined />
        <span>暂无知识库同步项目，请先同步知识库项目管理。</span>
      </div>
    );
  }

  return (
    <div className="service-picker">
      {groups.map(([category, items]) => {
        const allChecked = items.every((s) => value.includes(s.id));
        const someChecked = items.some((s) => value.includes(s.id));
        return (
          <div className="service-picker-group" key={category}>
            <div className="service-picker-head">
              <span className="service-picker-cat">{category}</span>
              <span className="service-picker-count">{items.length} 项</span>
              <Checkbox
                className="service-picker-checkall"
                checked={allChecked}
                indeterminate={someChecked && !allChecked}
                onChange={(e) => toggleGroup(items.map((s) => s.id), e.target.checked)}
              >
                全选
              </Checkbox>
            </div>
            <div className="service-picker-grid">
              {items.map((service) => (
                <label
                  key={service.id}
                  className={`service-picker-item${value.includes(service.id) ? ' active' : ''}`}
                >
                  <Checkbox checked={value.includes(service.id)} onChange={() => toggle(service.id)} />
                  <span className="service-picker-name">{service.name}</span>
                  {service.price_cents ? (
                    <span className="service-picker-price">¥{(service.price_cents / 100).toFixed(0)}</span>
                  ) : null}
                  <span className="service-picker-duration">{service.duration_minutes}′</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ReferencesView() {
  const [stores, setStores] = useState<Store[]>([]);
  const [services, setServices] = useState<ServiceWithStats[]>([]);
  const [staff, setStaff] = useState<StaffWithSkills[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  // 门店编辑弹窗
  const [storeModal, setStoreModal] = useState<{ open: boolean; editing?: Store }>({ open: false });
  const [storeForm] = Form.useForm();
  const [storeServiceIds, setStoreServiceIds] = useState<string[]>([]);
  // 服务编辑弹窗
  const [serviceModal, setServiceModal] = useState<{ open: boolean; editing?: ServiceWithStats }>({ open: false });
  const [serviceForm] = Form.useForm();
  // 员工编辑弹窗
  const [staffModal, setStaffModal] = useState<{ open: boolean; editing?: StaffWithSkills }>({ open: false });
  const [staffForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [storeRes, serviceRes, staffRes] = await Promise.all([api.stores(), api.services(), api.staff()]);
      setStores(storeRes.stores);
      setServices(serviceRes.services);
      setStaff(staffRes.staff);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载基础数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const storeNameOf = useCallback(
    (id: string) => stores.find((store) => store.id === id)?.name ?? id,
    [stores],
  );

  const staffByService = useMemo(() => {
    const map = new Map<string, number>();
    for (const person of staff) {
      for (const serviceId of person.service_ids) {
        map.set(serviceId, (map.get(serviceId) ?? 0) + 1);
      }
    }
    return map;
  }, [staff]);

  const bookableCount = useMemo(
    () => services.filter((s) => s.source_system === 'knowledge_base' && s.sync_status === 'synced' && s.is_active).length,
    [services],
  );

  // 门店勾选器数据：仅知识库项目管理中同步成功的项目（可预约）
  const kbBookableServices = useMemo(
    () => services.filter((s) => s.source_system === 'knowledge_base' && s.sync_status === 'synced' && s.is_active),
    [services],
  );

  const serviceNameById = useMemo(() => {
    const map = new Map<string, ServiceWithStats>();
    for (const service of services) map.set(service.id, service);
    return map;
  }, [services]);

  // 员工弹窗联动：可服务项目仅展示"本店已勾选的可做项目"，按分类分组（显式 state 驱动，兼容 destroyOnClose）
  const [staffStoreId, setStaffStoreId] = useState<string | undefined>();
  const [staffSelectedServiceIds, setStaffSelectedServiceIds] = useState<string[]>([]);
  const staffServiceOptions = useMemo(() => {
    const store = stores.find((s) => s.id === staffStoreId);
    const allowedIds = new Set(store?.service_ids ?? []);
    // 门店已配置项目时，仅列出该店可做项目；未配置时保留全部可预约项目（兼容旧数据）
    const pool = store && allowedIds.size > 0
      ? kbBookableServices.filter((s) => allowedIds.has(s.id))
      : kbBookableServices;
    return storeServicesByCategory(pool).map(([category, items]) => ({
      label: category,
      options: items.map((service) => ({ value: service.id, label: service.name })),
    }));
  }, [stores, staffStoreId, kbBookableServices]);

  const staffServiceOptionsWithSelected = useMemo(() => {
    const selectedIds = new Set(staffSelectedServiceIds);
    const flattenedIds = new Set<string>();
    for (const group of staffServiceOptions) {
      for (const item of group.options ?? []) flattenedIds.add(String(item.value));
    }
    const missing: ServiceWithStats[] = [];
    for (const id of selectedIds) {
      const service = serviceNameById.get(id);
      if (service && !flattenedIds.has(service.id)) missing.push(service);
    }
    if (missing.length === 0) return staffServiceOptions;
    return [
      {
        label: '已选项目',
        options: missing.map((service) => ({ value: service.id, label: service.name })),
      },
      ...staffServiceOptions,
    ];
  }, [staffServiceOptions, serviceNameById, staffSelectedServiceIds]);

  // 员工技能强制收敛：
  // 1) 移除已不存在的项目（无法解析名称 → 之前显示为 UUID 的来源）
  // 2) 仅保留所属门店可做范围内的项目（含门店切换、存量数据）
  const staffAllowedServiceIds = useMemo(() => {
    const store = stores.find((s) => s.id === staffStoreId);
    const allowedIds = new Set(store?.service_ids ?? []);
    if (!store || allowedIds.size === 0) return null; // 门店未配置时不干预（兼容旧数据）
    return allowedIds;
  }, [stores, staffStoreId]);

  useEffect(() => {
    const resolvable = staffSelectedServiceIds.filter((id) => serviceNameById.has(id));
    const removedUnknown = staffSelectedServiceIds.length - resolvable.length;
    let next = resolvable;

    const allowed = staffAllowedServiceIds;
    if (allowed) {
      const pruned = next.filter((id) => allowed.has(id));
      const removedOutOfScope = next.length - pruned.length;
      next = pruned;
      if (removedUnknown + removedOutOfScope > 0) {
        setStaffSelectedServiceIds(next);
        staffForm.setFieldValue('service_ids', next);
        message.info(`已移除 ${removedUnknown + removedOutOfScope} 个无效或该门店不支持的项目`);
      }
      return;
    }
    if (removedUnknown > 0) {
      setStaffSelectedServiceIds(next);
      staffForm.setFieldValue('service_ids', next);
      message.info(`已移除 ${removedUnknown} 个已不存在的项目`);
    }
  }, [staffSelectedServiceIds, staffAllowedServiceIds, staffForm, serviceNameById]);

  const storeServiceCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const person of staff) {
      const count = map.get(person.store_id) ?? 0;
      map.set(person.store_id, count + 1);
    }
    return map;
  }, [staff]);

  // ===== 同步知识库 =====
  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await api.syncKnowledgeBase();
      if (res.success && res.result) {
        setSyncResult(res.result);
        if (res.result.status === 'failed') {
          message.error(res.result.message);
        } else {
          message.success(res.result.message);
        }
      } else {
        message.error(res.error ?? '同步失败');
      }
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '同步失败');
    } finally {
      setSyncing(false);
    }
  }, [load]);

  // ===== 门店操作 =====
  const openStoreCreate = () => {
    storeForm.resetFields();
    setStoreServiceIds([]);
    setStoreModal({ open: true });
  };
  const openStoreEdit = (store: Store) => {
    storeForm.setFieldsValue({ name: store.name, timezone: store.timezone });
    setStoreServiceIds(store.service_ids ?? []);
    setStoreModal({ open: true, editing: store });
  };
  const submitStore = async () => {
    const values = await storeForm.validateFields();
    try {
      if (storeModal.editing) {
        const res = await api.updateStore(storeModal.editing.id, { ...values, service_ids: storeServiceIds });
        if (!res.success) throw new Error(res.error ?? '更新失败');
        message.success('门店已更新');
      } else {
        const res = await api.createStore({ ...values, service_ids: storeServiceIds });
        if (!res.success) throw new Error(res.error ?? '创建失败');
        message.success('门店已创建');
      }
      setStoreModal({ open: false });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    }
  };
  const toggleStore = async (store: Store) => {
    try {
      const res = await api.updateStore(store.id, { is_active: !store.is_active });
      if (!res.success) throw new Error(res.error ?? '操作失败');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    }
  };
  const removeStore = async (store: Store) => {
    try {
      const res = await api.deleteStore(store.id);
      if (!res.success) throw new Error(res.error ?? '删除失败');
      message.success('门店已停用');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  // ===== 服务操作 =====
  const openServiceCreate = () => {
    serviceForm.resetFields();
    setServiceModal({ open: true });
  };
  const openServiceEdit = (service: ServiceWithStats) => {
    serviceForm.setFieldsValue({
      name: service.name,
      duration_minutes: service.duration_minutes,
      price_yuan: service.price_cents ? service.price_cents / 100 : undefined,
    });
    setServiceModal({ open: true, editing: service });
  };
  const submitService = async () => {
    const values = await serviceForm.validateFields();
    const body = {
      name: values.name,
      duration_minutes: values.duration_minutes,
      price_cents: values.price_yuan !== undefined && values.price_yuan !== null ? Math.round(values.price_yuan * 100) : undefined,
    };
    try {
      if (serviceModal.editing) {
        const res = await api.updateService(serviceModal.editing.id, body);
        if (!res.success) throw new Error(res.error ?? '更新失败');
        message.success('服务已更新');
      } else {
        const res = await api.createService(body);
        if (!res.success) throw new Error(res.error ?? '创建失败');
        message.warning('服务已创建（手工维护，需同步知识库后才可预约）');
      }
      setServiceModal({ open: false });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    }
  };
  const toggleService = async (service: ServiceWithStats) => {
    try {
      const res = await api.updateService(service.id, { is_active: !service.is_active });
      if (!res.success) throw new Error(res.error ?? '操作失败');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    }
  };
  const removeService = async (service: ServiceWithStats) => {
    try {
      const res = await api.deleteService(service.id);
      if (!res.success) throw new Error(res.error ?? '删除失败');
      message.success('服务已停用');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  // ===== 员工操作 =====
  const openStaffCreate = () => {
    staffForm.resetFields();
    setStaffStoreId(stores[0]?.id);
    setStaffSelectedServiceIds([]);
    staffForm.setFieldsValue({ store_id: stores[0]?.id, service_ids: [] });
    setStaffModal({ open: true });
  };
  const openStaffEdit = (person: StaffWithSkills) => {
    staffForm.setFieldsValue({
      name: person.name,
      store_id: person.store_id,
      service_ids: person.service_ids,
    });
    setStaffStoreId(person.store_id);
    setStaffSelectedServiceIds(person.service_ids);
    setStaffModal({ open: true, editing: person });
  };
  const submitStaff = async () => {
    const values = await staffForm.validateFields();
    const body = { ...values, service_ids: staffSelectedServiceIds };
    try {
      if (staffModal.editing) {
        const res = await api.updateStaff(staffModal.editing.id, body);
        if (!res.success) throw new Error(res.error ?? '更新失败');
        message.success('员工已更新');
      } else {
        const res = await api.createStaff(body);
        if (!res.success) throw new Error(res.error ?? '创建失败');
        message.success('员工已创建');
      }
      setStaffModal({ open: false });
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    }
  };
  const toggleStaff = async (person: StaffWithSkills) => {
    try {
      const res = await api.updateStaff(person.id, { is_active: !person.is_active });
      if (!res.success) throw new Error(res.error ?? '操作失败');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    }
  };
  const removeStaff = async (person: StaffWithSkills) => {
    try {
      const res = await api.deleteStaff(person.id);
      if (!res.success) throw new Error(res.error ?? '删除失败');
      message.success('员工已停用');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  return (
    <div className="view-stack">
      <Card className="page-header-card" variant="borderless">
        <div className="page-header-inner">
          <div>
            <Title level={2} className="page-title">门店与项目</Title>
            <Paragraph className="page-desc">
              预约业务基础数据：门店、服务项目与员工技能。仅知识库项目管理中同步成功的项目可被预约。
            </Paragraph>
          </div>
          <Button type="primary" icon={<SyncOutlined spin={syncing} />} loading={syncing} onClick={() => void runSync()}>
            同步知识库
          </Button>
        </div>
        <div className="page-stat-chips">
          <div className="page-stat-chip tone-purple">
            <span className="page-stat-icon"><ShopOutlined /></span>
            <span>
              <span className="page-stat-num">{stores.length}</span>
              <span className="page-stat-label"> 门店</span>
              <span className="page-stat-sub"> · {stores.filter((s) => s.is_active).length} 营业中</span>
            </span>
          </div>
          <div className="page-stat-chip tone-blue">
            <span className="page-stat-icon"><DollarOutlined /></span>
            <span>
              <span className="page-stat-num">{services.length}</span>
              <span className="page-stat-label"> 服务项目</span>
              <span className="page-stat-sub"> · {bookableCount} 可预约</span>
            </span>
          </div>
          <div className="page-stat-chip tone-green">
            <span className="page-stat-icon"><TeamOutlined /></span>
            <span>
              <span className="page-stat-num">{staff.length}</span>
              <span className="page-stat-label"> 员工</span>
              <span className="page-stat-sub"> · {staff.filter((p) => p.is_active).length} 在职</span>
            </span>
          </div>
        </div>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card
            title={<span className="module-title"><EnvironmentOutlined /> 门店</span>}
            extra={
              <div className="sync-action-area">
                <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openStoreCreate}>新增门店</Button>
              </div>
            }
            className="section-card"
            variant="borderless"
          >
            <div className="store-list">
              {stores.map((store) => {
                const staffCount = storeServiceCount.get(store.id) ?? 0;
                const storeServices = (store.service_ids ?? [])
                  .map((id) => serviceNameById.get(id))
                  .filter((s): s is ServiceWithStats => Boolean(s));
                return (
                  <div key={store.id} className={`store-card${store.is_active ? '' : ' store-card-off'}`}>
                    <div className="store-card-head">
                      <span className="store-card-icon"><ShopOutlined /></span>
                      <div className="store-card-info">
                        <div className="store-card-name">{store.name}</div>
                        <div className="store-card-meta">
                          <GlobalOutlined /> {store.timezone} · {staffCount} 名员工
                        </div>
                      </div>
                      <Tag color={store.is_active ? 'green' : 'default'}>{store.is_active ? '营业中' : '停用'}</Tag>
                    </div>
                    <div className="store-card-services">
                      {storeServices.length > 0 ? (
                        <>
                          <span className="store-card-service-tags">
                            {storeServices.slice(0, 4).map((service) => (
                              <span key={service.id} title={service.category ?? undefined} className="store-card-service-tag">
                                {service.name}
                              </span>
                            ))}
                            {storeServices.length > 4 && <span className="store-card-service-more">+{storeServices.length - 4}</span>}
                          </span>
                          <span className="store-card-service-count">可做 {storeServices.length} 项</span>
                        </>
                      ) : (
                        <span className="store-card-service-empty">
                          <DollarOutlined /> 未配置可做项目 · 点击「编辑」按分类勾选
                        </span>
                      )}
                    </div>
                    <div className="store-card-actions">
                      <Button size="small" icon={<EditOutlined />} onClick={() => openStoreEdit(store)}>编辑</Button>
                      <Button size="small" icon={<ReloadOutlined />} onClick={() => toggleStore(store)}>{store.is_active ? '停用' : '启用'}</Button>
                      <Popconfirm
                        title="停用该门店？"
                        description="不会物理删除，历史预约不受影响。"
                        onConfirm={() => removeStore(store)}
                        okText="停用"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                      </Popconfirm>
                    </div>
                  </div>
                );
              })}
              {stores.length === 0 && !loading && (
                <div className="empty-state">
                  <EnvironmentOutlined />
                  <span>暂无门店，点击右上角「新增门店」创建</span>
                </div>
              )}
            </div>
          </Card>
        </Col>

        <Col xs={24} lg={16}>
          <Card
            title={<span className="module-title"><DollarOutlined /> 服务项目</span>}
            extra={
              <Space>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} title="刷新">刷新</Button>
                <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openServiceCreate}>新增服务</Button>
              </Space>
            }
            className="section-card"
            variant="borderless"
          >
            {syncResult && (
              <div className={`sync-result-banner sync-${syncResult.status}`}>
                <b>{syncResult.status === 'failed' ? '同步失败' : '同步完成'}</b>
                <span>知识库项目 {syncResult.total} 个 · 新增 {syncResult.created} · 更新 {syncResult.updated} · 停用 {syncResult.deactivated} · 失败 {syncResult.failed}</span>
                {syncResult.errors.length > 0 && (
                  <div className="sync-errors">{syncResult.errors.map((err) => <div key={err}>· {err}</div>)}</div>
                )}
              </div>
            )}
            <Table<ServiceWithStats>
              rowKey="id"
              dataSource={services}
              size="small"
              pagination={false}
              loading={loading}
              scroll={{ x: 760 }}
              columns={[
                {
                  title: '项目',
                  dataIndex: 'name',
                  width: 180,
                  render: (value: string, record) => (
                    <Space size={6}>
                      <span className="service-name">{value}</span>
                      <SyncStatusTag service={record} />
                    </Space>
                  ),
                },
                {
                  title: '时长',
                  dataIndex: 'duration_minutes',
                  width: 90,
                  render: (value: number) => <span className="duration-cell"><span className="dot-live" style={{ background: '#7c5cff' }} /> {value} 分钟</span>,
                },
                {
                  title: '价格',
                  dataIndex: 'price_cents',
                  width: 100,
                  render: (value?: number) => (
                    value
                      ? <span className="price-cell"><span className="price-symbol">¥</span>{(value / 100).toFixed(0)}</span>
                      : <span className="no-skill">-</span>
                  ),
                },
                {
                  title: '覆盖员工',
                  dataIndex: 'staff_count',
                  width: 100,
                  render: (_: unknown, record) => (
                    <span className="staff-count-cell"><TeamOutlined /> {staffByService.get(record.id) ?? 0} 人</span>
                  ),
                },
                {
                  title: '可预约',
                  key: 'bookable',
                  width: 110,
                  render: (_, record) => {
                    const bookable = record.source_system === 'knowledge_base' && record.sync_status === 'synced' && record.is_active;
                    return (
                      <span className="bookable-indicator">
                        <span className={`dot-live ${bookable ? 'green' : 'orange'}`} />
                        {bookable ? '可预约' : '不可预约'}
                      </span>
                    );
                  },
                },
                {
                  title: '操作',
                  key: 'action',
                  width: 230,
                  fixed: 'right',
                  render: (_, service) => (
                    <ActionButtonGroup
                      onEdit={() => openServiceEdit(service)}
                      onToggle={() => toggleService(service)}
                      active={service.is_active}
                      onDelete={() => removeService(service)}
                    />
                  ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Card
        title={<span className="module-title"><TeamOutlined /> 员工与技能</span>}
        extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={openStaffCreate}>新增员工</Button>}
        className="section-card"
        variant="borderless"
      >
        <Table<StaffWithSkills>
          rowKey="id"
          dataSource={staff}
          size="middle"
          pagination={{ pageSize: 10 }}
          loading={loading}
          scroll={{ x: 720 }}
          columns={[
            {
              title: '员工',
              dataIndex: 'name',
              width: 180,
              render: (value: string) => (
                <span className="staff-cell">
                  <span className="staff-avatar"><UserOutlined /></span>
                  <span className="staff-name">{value}</span>
                </span>
              ),
            },
            {
              title: '所属门店',
              dataIndex: 'store_id',
              width: 200,
              render: (value: string) => (
                <span className="store-name-cell"><EnvironmentOutlined /> {storeNameOf(value)}</span>
              ),
            },
            {
              title: '可服务项目',
              dataIndex: 'service_names',
              render: (value: string[]) => (
                value && value.length > 0
                  ? (
                    <div className="skill-tag-group">
                      {value.map((name) => <Tag key={name} icon={<ShopOutlined />}>{name}</Tag>)}
                    </div>
                  )
                  : <span className="no-skill">暂无技能</span>
              ),
            },
            {
              title: '状态',
              dataIndex: 'is_active',
              width: 100,
              render: (value: boolean) => (
                value ? <span className="stat-badge green"><span className="dot-live green" /> 在职</span> : <span className="stat-badge">停用</span>
              ),
            },
            {
              title: '操作',
              key: 'action',
              width: 230,
              fixed: 'right',
              render: (_, person) => (
                <ActionButtonGroup
                  onEdit={() => openStaffEdit(person)}
                  onToggle={() => toggleStaff(person)}
                  active={person.is_active}
                  onDelete={() => removeStaff(person)}
                />
              ),
            },
          ]}
        />
      </Card>

      {/* 门店弹窗 */}
      <Modal
        className="admin-modal"
        title={<span className="modal-title-with-icon"><EnvironmentOutlined /> {storeModal.editing ? '编辑门店' : '新增门店'}</span>}
        open={storeModal.open}
        onOk={() => void submitStore()}
        onCancel={() => setStoreModal({ open: false })}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        width={640}
      >
        <Form form={storeForm} layout="vertical">
          <Form.Item name="name" label="门店名称" rules={[{ required: true, message: '请输入门店名称' }]}>
            <Input prefix={<ShopOutlined />} placeholder="例如：上海徐汇门店" />
          </Form.Item>
          <Form.Item name="timezone" label="时区" rules={[{ required: true, message: '请输入时区' }]}>
            <Input prefix={<GlobalOutlined />} placeholder="Asia/Shanghai" />
          </Form.Item>

          <div className="service-picker-title">
            <span className="service-picker-title-label">
              <ShopOutlined /> 本店可做项目
              <span className="service-picker-title-hint">来自知识库项目管理 · 按分类勾选</span>
            </span>
            <span className="service-picker-title-count">
              已勾选 {storeServiceIds.length} 项 / {kbBookableServices.length} 项可预约
            </span>
          </div>
          <div className="admin-modal-picker">
            <StoreServicePicker
              services={kbBookableServices}
              value={storeServiceIds}
              onChange={setStoreServiceIds}
            />
          </div>
          <span className="form-hint">门店仅可为顾客提供勾选的项目；员工可服务项目需在其「员工与技能」中单独维护。</span>
        </Form>
      </Modal>

      {/* 服务弹窗 */}
      <Modal
        className="admin-modal"
        title={<span className="modal-title-with-icon"><DollarOutlined /> {serviceModal.editing ? '编辑服务' : '新增服务'}</span>}
        open={serviceModal.open}
        onOk={() => void submitService()}
        onCancel={() => setServiceModal({ open: false })}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={serviceForm} layout="vertical">
          <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
            <Input placeholder="例如：皮肤管理" />
          </Form.Item>
          <Form.Item name="duration_minutes" label="时长（分钟）" rules={[{ required: true, message: '请输入时长' }]}>
            <InputNumber min={1} max={1440} style={{ width: '100%' }} placeholder="60" addonAfter="分钟" />
          </Form.Item>
          <Form.Item name="price_yuan" label="价格（元）">
            <InputNumber min={0} step={1} style={{ width: '100%' }} placeholder="299" addonBefore="¥" />
          </Form.Item>
          <span className="form-hint">手工新增的服务不会自动出现在知识库项目管理中，需在知识库侧创建后点击「同步知识库」。</span>
        </Form>
      </Modal>

      {/* 员工弹窗 */}
      <Modal
        className="admin-modal"
        title={<span className="modal-title-with-icon"><TeamOutlined /> {staffModal.editing ? '编辑员工' : '新增员工'}</span>}
        open={staffModal.open}
        onOk={() => void submitStaff()}
        onCancel={() => setStaffModal({ open: false })}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={staffForm} layout="vertical">
          <Form.Item name="name" label="员工姓名" rules={[{ required: true, message: '请输入员工姓名' }]}>
            <Input prefix={<UserOutlined />} placeholder="例如：李美容师" />
          </Form.Item>
          <Form.Item
            name="store_id"
            label="所属门店"
            rules={[{ required: true, message: '请选择所属门店' }]}
            extra={stores.find((s) => s.id === staffStoreId)?.service_ids?.length ? `已选门店可做 ${stores.find((s) => s.id === staffStoreId)?.service_ids?.length ?? 0} 个项目` : '若门店未配置可做项目，将展示全部可预约项目'}
          >
            <Select
              placeholder="选择门店"
              options={stores.map((store) => ({ value: store.id, label: store.name }))}
              onChange={(value: string) => setStaffStoreId(value)}
            />
          </Form.Item>
          <Form.Item name="service_ids" label="可服务项目">
            <Select
              mode="multiple"
              placeholder="选择该员工可服务的项目（多选）"
              options={staffServiceOptionsWithSelected}
              optionFilterProp="label"
              showSearch
              maxTagCount={6}
              maxTagPlaceholder={(omitted) => `+${omitted.length} 项`}
              onChange={(value: string[]) => setStaffSelectedServiceIds(value)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
