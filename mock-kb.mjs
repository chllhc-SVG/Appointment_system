// 临时 mock：模拟知识库项目管理 API（验证后删除）
import http from 'node:http';

const projects = [
  {
    id: '皮肤管理',
    project_name: '皮肤管理',
    aliases: ['深层补水', '基础护理'],
    project_category: '基础护理',
    price: '299元/次',
    duration: '60分钟',
    is_active: true,
    description: '深层清洁 + 补水',
  },
  {
    id: '光子嫩肤',
    project_name: '光子嫩肤',
    aliases: ['IPL', 'OPT'],
    project_category: '光电类',
    price: '¥699',
    duration: '90',
    is_active: true,
    description: '全脸光子嫩肤',
  },
  {
    id: '热玛吉紧致',
    project_name: '热玛吉紧致',
    aliases: ['热玛吉'],
    project_category: '抗衰',
    price: '12800',
    duration: '1.5小时',
    is_active: true,
    description: '全面部紧致提拉',
  },
  {
    id: '美白导入',
    project_name: '美白导入',
    aliases: [],
    project_category: '美白',
    price: '499',
    duration: '40',
    is_active: false,
    description: '已下架项目',
  },
];

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/api/kb/projects')) {
    const url = new URL(req.url, 'http://localhost');
    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('page_size') ?? 20);
    const offset = (page - 1) * pageSize;
    const items = projects.slice(offset, offset + pageSize);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ page, page_size: pageSize, total: projects.length, items }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
}).listen(3001, () => {
  console.log('mock kb listening on 3001');
});
