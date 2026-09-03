import { useState } from 'react';
import {
  AppstoreOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  FileSearchOutlined,
  PlusCircleOutlined,
  ShopOutlined,
} from '@ant-design/icons';
import { Menu } from 'antd';
import { OverviewView } from './OverviewView';
import { AppointmentsView } from './AppointmentsView';
import { NewAppointmentView } from './NewAppointmentView';
import { ReferencesView } from './ReferencesView';
import { SchedulesView } from './SchedulesView';
import { LogsView } from './LogsView';

type ViewKey = 'overview' | 'appointments' | 'new' | 'references' | 'schedules' | 'logs';

const MENU_ITEMS = [
  { key: 'overview', icon: <AppstoreOutlined />, label: '概览' },
  { key: 'new', icon: <PlusCircleOutlined />, label: '新建预约' },
  { key: 'appointments', icon: <CalendarOutlined />, label: '预约管理' },
  { key: 'schedules', icon: <ClockCircleOutlined />, label: '员工排班' },
  { key: 'references', icon: <ShopOutlined />, label: '门店与项目' },
  { key: 'logs', icon: <FileSearchOutlined />, label: '日志中心' },
];

export function DashboardPage() {
  const [view, setView] = useState<ViewKey>('overview');

  return (
    <div className="dashboard-shell">
      <aside className="dashboard-nav">
        <div className="sider-brand">
          <div className="hero-kicker">Appointment MCP</div>
          <h2 className="hero-title">预约排班管理</h2>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[view]}
          items={MENU_ITEMS}
          onClick={({ key }) => setView(key as ViewKey)}
          theme="dark"
        />
      </aside>

      <main className="app-shell">
        {view === 'overview' && <OverviewView />}
        {view === 'new' && <NewAppointmentView />}
        {view === 'appointments' && <AppointmentsView />}
        {view === 'schedules' && <SchedulesView />}
        {view === 'references' && <ReferencesView />}
        {view === 'logs' && <LogsView />}
      </main>
    </div>
  );
}