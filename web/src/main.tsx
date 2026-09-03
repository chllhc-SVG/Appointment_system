import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, Layout } from 'antd';
import 'antd/dist/reset.css';
import './styles.css';
import { DashboardPage } from './pages/DashboardPage';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#7c5cff',
          colorInfo: '#7c5cff',
          borderRadius: 14,
          fontSize: 14,
          fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        },
        components: {
          Card: { headerFontSize: 16 },
          Table: { headerBg: '#f4f1ff' },
          Button: { controlHeight: 40 },
        },
      }}
    >
      <Layout style={{ minHeight: '100vh', background: 'transparent' }}>
        <DashboardPage />
      </Layout>
    </ConfigProvider>
  </React.StrictMode>,
);