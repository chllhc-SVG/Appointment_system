# Appointment MCP System

独立预约排班 MCP 服务，用于处理门店预约、排班、取消、改期、签到、完成与爽约。

## 目标

- 为数字人提供真实可落地的预约闭环
- 与知识库联动，形成“咨询 → 预约 → 到店服务”的业务路径
- 使用 PostgreSQL 作为中心数据源，支持事务、幂等、时间冲突控制与状态机约束
- 支持 HTTP MCP 与 stdio MCP 两种接入方式
- 支持数字人身份注入（`X-Agent-Code` / `Bearer sub`）
- 对外暴露 8 个 MCP 工具，尽量对齐 HA 的“少量通用工具 + 参数路由”风格

## MCP Tools（8 个）

### 1. 参考数据
- `list_booking_reference` 查询门店列表
- `list_store_services` 查询门店可预约项目
- `list_store_staff` 查询门店员工及其可服务项目
- `list_staff_availability` 查询员工排班

### 2. 预约查询
- `query_slots` 查询某项目在某天的可预约时段
- `query_bookings` 查询顾客预约、预约详情、审计轨迹与概览统计（`scope=my/detail/audits/overview`，管理端列表走 `scope=list`）

### 3. 预约动作
- `manage_booking` 统一处理创建、取消、改期、签到、确认、完成、爽约

### 4. 顾客身份管理
- `manage_customer_session` 识别当前顾客、查询当前会话绑定顾客、结束会话

## 核心设计

### 0. 缺参追问原则

预约系统对数字人最重要的要求不是“一次说全”，而是“缺什么就追问什么”。

- 如果用户只说“我要预约某某项目”，但没说门店 / 员工 / 时间，数字人应先追问缺失项
- 如果 `query_slots`、`manage_booking(create)`、`manage_booking(reschedule)`、`query_bookings(detail/audits)` 等参数不完整，工具层会返回 `NEEDS_MORE_INFO`，包含 `missing_fields` 和 `suggested_question`
- 数字人拿到这类返回值后，应该先继续问用户，而不是直接去调用下游业务接口
- 当信息补齐后，再带着完整参数调用预约系统，保持原有链路不变

### 1. 双层身份模型（数字人账号 ≠ 顾客身份）

**关键问题**：门店一楼常用一个公共数字人账号（如 `hsh`）依次接待多位真实顾客。若把
`X-Agent-Code`（数字人账号）直接当作顾客身份，所有人共用同一个 `customer_id`，
必然出现 A 顾客看到 / 取消 B 顾客预约的串号事故。

**解决方案**：把「数字人身份（agent）」与「真实顾客身份（customer）」分成两层：

```
个人数字人（IDENTITY_MODE=personal，默认）
  数字人账号即顾客本人账号：X-Agent-Code 直接作为 customer_id
  （一人一数字人场景，行为与旧版一致）

共享终端（IDENTITY_MODE=shared，门店一楼公共数字人）
  agent 身份只表示"哪台数字人在说话"；
  顾客身份通过 identify_customer 建立会话绑定（手机号识别），
  未识别时顾客级工具一律返回 IDENTITY_REQUIRED（fail-closed），
  杜绝把 A 的预约数据暴露 / 操作在 B 名下
```

共享终端对话流程：

```
顾客：我要预约小气泡
数字人：请留一下您的手机号？
顾客：138****1111
数字人：manage_customer_session(action="identify", customer_phone="13800001111", customer_name="王女士")
         → 返回 customer_id + 脱敏手机号（新顾客自动建档）
数字人：王女士您好，小气泡明天下午有空位，给您约 14:00 可以吗？
顾客：可以
数字人：manage_booking(action="create", service_name="小气泡", ...)  → 预约自动绑定到该顾客
顾客：那我先走了
数字人：manage_customer_session(action="end")  → 会话结束，下一位顾客重新识别
```

要点：
- `manage_customer_session(action=identify)` 用手机号识别/建档，`customer_id` 由服务端生成并落库，
  手机号只存哈希（`phone_hash`）+ 脱敏展示（`phone_masked`），不存明文。
- 会话有效期 `CUSTOMER_SESSION_TTL_MS`（默认 30 分钟），每次使用滑动续期，
  长对话（查时段 → 确认 → 创建）不会中途失效。
- 即使 LLM 在参数里伪造 `customer_id`，shared 模式下也以会话绑定为准（忽略传参）。
- 顾客身份与会话的建立 / 顶替 / 结束均写入 `entity_audits`，可追溯。

#### 会话作用域（X-Session-Id）与并行对话

客户端转发层为每次对话会话生成 `X-Session-Id`（与 WebRTC 会话对齐，`stop()` 时作废），
服务端把顾客会话绑定到 `(agent_code, external_session_id)`：

- 同一台数字人**并行多路对话**时各自绑定各自顾客，互不串号；
- 单终端顺序接待（无外部会话 id）时退回 agent 级唯一活跃会话；
- `end_session_customer` 只清当前外部会话，不影响并行会话。

#### 扫码直通（X-Customer-Phone / X-Customer-Name）

顾客用小程序扫码确认身份后，客户端转发层自动注入这两个头。
服务端在顾客级工具执行前自动建立/顶替会话绑定（source=scan），
数字人**无需再口头询问手机号**：

```
顾客（已扫码）：我要预约小气泡
数字人：直接进入查时段 → 确认 → 创建（身份已在服务端绑定）
```

幂等：同一顾客重复携带扫码头不会重复建绑；不同顾客（强证据）顶替当前会话绑定。
头值非 ASCII（如中文称呼）由客户端 `encodeURIComponent`，服务端解码还原。

### 2. 身份注入（传输层）

与知识库保持一致，优先从请求头读取 `X-Agent-Code`，其次解析 `Authorization: Bearer <token>` 的 `sub`。

- `X-Agent-Code`：数字人客户端转发时注入，优先级最高（表示"哪台数字人"）
- `X-Session-Id`：数字人转发层按对话会话注入（并行多路对话的隔离键，可选）
- `X-Customer-Phone` / `X-Customer-Name`：小程序扫码直通（可选，非 ASCII 值 URL 编码）
- `Bearer sub`：登录态兜底
- 空：匿名/管理端/直连调试

### 3. 共享终端的 fail-closed 策略

`IDENTITY_MODE=shared` 下，消费顾客预约数据的工具（`query_slots` / `query_bookings` / `manage_booking` 的顾客动作）
在未识别顾客时直接返回 `IDENTITY_REQUIRED`，强制数字人先完成
`manage_customer_session(action=identify)`。`manage_customer_session` 是身份管理工具，始终放行。

### 4. 缺参追问策略

为了让数字人能自然地和用户“补齐信息”，预约系统在工具层会返回结构化的缺参提示：

- `error_code = NEEDS_MORE_INFO`
- `missing_fields`：缺少哪些参数
- `suggested_question`：建议数字人怎么反问用户

例如：
- 用户说“我想预约小气泡”但没说门店/时间/员工时，数字人应先追问
- 用户说“帮我改到明天”但没说预约码或新时间时，数字人应继续追问
- 用户说“查我的预约”但没说明具体哪一单时，数字人应继续问预约码或条件

当信息补齐后，再继续调用原来的预约工具链，不改变原有业务流程。

会话绑定完整链路（按优先级）：
1. 客户端扫码（X-Customer-Phone）→ 自动建绑/顶替（source=scan，强证据）；
2. 对话内 identify_customer（手机号口头确认，source=manual）；
3. 两者都无 → IDENTITY_REQUIRED（fail-closed），数字人转而询问手机号。

### 4. 幂等

所有写操作都要求 `idempotency_key`。

- 数字人超时重试不会产生重复预约
- 取消 / 改期 / 签到 / 完成 / 爽约都能重复调用而保持一致结果

### 5. 状态机

预约状态由数据库触发器强制控制：

- `pending → confirmed`
- `confirmed → checked_in`
- `checked_in → completed`
- `confirmed / pending → cancelled`
- `confirmed → no_show`
- `checked_in → cancelled`

非法迁移会被数据库拒绝。

### 6. 冲突控制

使用 PostgreSQL 排他约束防止同一员工的时间段重叠。

### 7. 审计

每次预约状态变更都会写入 `appointment_audits`；
顾客会话的建立 / 顶替 / 结束写入 `entity_audits`（entity_type='customer_session'）。

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

### 数字人客户端本地化接入（Docker MCP 自动发现）

本仓库的 `docker-compose.yml` 已按「compose labels 自动发现约定」声明 MCP 服务，
数字人桌面客户端（Electron）启动时会扫描同级目录下的 compose 项目并自动拉起，
无需手动 `docker compose up`。已声明的 labels：

| label | 值 | 说明 |
|---|---|---|
| `mcp.enabled` | `"true"` | 自动发现且随客户端启动 |
| `mcp.path` | `/mcp` | MCP 端点路径 |
| `mcp.namespace` | `appointment_service` | 平台 namespace / server_id |
| `mcp.displayName` | `预约排班系统` | 客户端 UI 展示名 |
| `mcp.port` | `4020` | host 端口 |
| `mcp.healthPath` | `/healthz` | 健康检查路径 |
| `mcp.include_tools` | 8 个工具名 | 平台侧白名单参考 |

客户端发现后的运行地址为 `http://<本机局域网IP>:4020/mcp`（compose 端口映射绑定 0.0.0.0）。
在 MCP 平台中将「预约排班系统」的连接方式改为本地化（`transport: "client"` + `localizeEnabled`）
即可让数字人经本地转发层调用本机 Docker 里的预约服务；平台下发的
`desired-local-services` 也会按上述 compose 定义自动 `docker compose up`。

---

## 环境变量

复制 `.env.example` 为 `.env` 后配置：

- `DATABASE_URL`：PostgreSQL 连接字符串
- `MCP_SERVER_NAME`：MCP 服务名
- `MCP_SERVER_VERSION`：版本号
- `MCP_HTTP_PORT`：HTTP 端口
- `TZ`：时区
- `MCP_MODE`：`http` 或 `stdio`
- `IDENTITY_MODE`：`personal`（数字人账号即顾客，默认）或 `shared`（共享终端，需 `manage_customer_session(action=identify)` 识别顾客）
- `CUSTOMER_SESSION_TTL_MS`：顾客会话有效期毫秒数（默认 1800000 = 30 分钟）
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
    "list_booking_reference",
    "list_store_services",
    "list_store_staff",
    "list_staff_availability",
    "query_slots",
    "query_bookings",
    "manage_booking",
    "manage_customer_session"
  ]
}
```

## 数字人自然语言 → 工具调用速查

| 用户话术 | 推荐工具 |
|---|---|
| （新顾客）“我要预约 / 查我的预约”（共享终端） | 先 `manage_customer_session(action=get_current)` 确认 → 未识别则口语问手机号 → `manage_customer_session(action=identify)` |
| “查看我（最近/某天/某个项目）的预约” | `query_bookings(scope=my)`（按 `service_name` / `status` / 日期过滤） |
| “这个预约详情 / 预约码是 xxx” | `query_bookings(scope=detail)` |
| “我想预约小气泡 / 皮肤管理” | `list_store_services` → `query_slots` → **确认后** `manage_booking(action=create)` |
| “取消这个预约 / 退掉小气泡” | `manage_booking(action=cancel)`（支持预约码或 项目+日期 自动定位） |
| “改到明天上午 / 换个时间” | `manage_booking(action=reschedule)`（`new_start_at` + 预约码 或 项目+日期） |
| （顾客离开 / “不是我的预约”） | `manage_customer_session(action=end)` 结束会话，下一位重新识别 |

---

## 推荐后续优化方向

- 加用户侧预约提醒工具
- 加门店排队 / 到店签到流
- 加预约审批工具
- 加预约改期审批流
- 加更细的员工排班模板
