# Appointment MCP System

独立预约排班 MCP 服务，用于处理门店预约、排班、取消、改期、签到、完成与爽约。

## 目标

- 为数字人提供真实可落地的预约闭环
- 与知识库联动，形成“咨询 → 预约 → 到店服务”的业务路径
- 使用 PostgreSQL 作为中心数据源，支持事务、幂等、时间冲突控制与状态机约束
- 支持 HTTP MCP 与 stdio MCP 两种接入方式
- 支持数字人身份注入（`X-Agent-Code` / `Bearer sub`）

## 第一版 MCP Tools

- `search_available_slots` 查询可预约时段
- `create_appointment` 创建预约
- `get_my_appointments` 查询当前用户预约
- `get_appointment_detail` 查询单条预约详情
- `cancel_appointment` 取消预约
- `reschedule_appointment` 改期预约
- `list_booking_reference_data` 查询门店 / 项目 / 员工基础数据
- `list_store_services` 查询门店项目
- `list_store_staff` 查询门店员工
- `list_staff_availability` 查询员工排班
- `get_appointment_timeline` 查询预约审计轨迹
- `check_in_appointment` 到店签到
- `complete_appointment` 完成预约
- `mark_no_show_appointment` 标记爽约

## 核心设计

### 1. 身份注入

与知识库保持一致，优先从请求头读取 `X-Agent-Code`，其次解析 `Authorization: Bearer <token>` 的 `sub`。

- `X-Agent-Code`：数字人客户端转发时注入，优先级最高
- `Bearer sub`：登录态兜底
- 空：匿名/管理端/直连调试

写操作会强制绑定到当前身份，避免数字人在工具层伪造别人的 `customer_id`。

### 2. 幂等

所有写操作都要求 `idempotency_key`。

- 数字人超时重试不会产生重复预约
- 取消 / 改期 / 签到 / 完成 / 爽约都能重复调用而保持一致结果

### 3. 状态机

预约状态由数据库触发器强制控制：

- `pending → confirmed`
- `confirmed → checked_in`
- `checked_in → completed`
- `confirmed / pending → cancelled`
- `confirmed → no_show`
- `checked_in → cancelled`

非法迁移会被数据库拒绝。

### 4. 冲突控制

使用 PostgreSQL 排他约束防止同一员工的时间段重叠。

### 5. 审计

每次预约状态变更都会写入 `appointment_audits`。

---

## 启动方式

### 1. 本地开发

```bash
pnpm install
pnpm run migrate
pnpm run seed
pnpm run dev
```

### 2. HTTP MCP 模式

默认开启 HTTP + Admin API：

- HTTP MCP：`http://127.0.0.1:4020/mcp`
- Admin API：`http://127.0.0.1:4020/api`

### 3. stdio MCP 模式

```bash
MCP_MODE=stdio pnpm run dev
```

适合本地 MCP 客户端直接拉起。

### 4. Docker Compose

```bash
docker compose up -d --build
```

服务端口：

- `4020`：预约服务 + HTTP MCP
- `5434`：PostgreSQL（宿主机映射）

---

## 环境变量

复制 `.env.example` 为 `.env` 后配置：

- `DATABASE_URL`：PostgreSQL 连接字符串
- `MCP_SERVER_NAME`：MCP 服务名
- `MCP_SERVER_VERSION`：版本号
- `MCP_HTTP_PORT`：HTTP 端口
- `TZ`：时区
- `MCP_MODE`：`http` 或 `stdio`
- `ADMIN_TOKEN`：可选，Admin API 鉴权 token

---

## 数据库迁移

- `001_init.sql`：初始业务表、幂等表、审计表
- `002_booking_optimizations.sql`：状态约束、查询索引、幂等写表
- `003_state_machine.sql`：状态流转触发器与强约束

建议启动顺序：

```bash
pnpm run migrate
pnpm run seed
```

---

## 适合接入 `mcp platform` 的方式

推荐作为独立远程 MCP 服务接入，而不是本地单机工具。

示例配置：

```json
{
  "serviceId": "appointment_service",
  "namespace": "appointment_service",
  "name": "预约排班系统",
  "transport": "streamable_http",
  "enabled": true,
  "target": {
    "transport": "streamable_http",
    "url": "http://appointment-service:4020/mcp"
  },
  "include_tools": [
    "search_available_slots",
    "create_appointment",
    "get_my_appointments",
    "get_appointment_detail",
    "cancel_appointment",
    "reschedule_appointment",
    "list_booking_reference_data",
    "list_store_services",
    "list_store_staff",
    "list_staff_availability",
    "get_appointment_timeline",
    "check_in_appointment",
    "complete_appointment",
    "mark_no_show_appointment"
  ]
}
```

---

## 推荐后续优化方向

- 加用户侧预约提醒工具
- 加门店排队 / 到店签到流
- 加预约审批工具
- 加预约改期审批流
- 加更细的员工排班模板
