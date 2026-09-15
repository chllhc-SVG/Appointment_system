# Appointment MCP System（预约排班 MCP 系统）

独立预约排班 MCP 服务 + 管理后台。为数字人提供「查时段 → 建预约 → 取消/改期/签到/完成」的完整预约闭环，配套 Web 管理后台供门店店长使用。

> 本文档面向**第一次接触本仓库的开发者**。读完你应当能：说清系统干什么、每个文件管什么、本地跑起来、知道哪些东西不能动。

---

## 目录

1. [系统一句话介绍](#1-系统一句话介绍)
2. [整体架构：谁连谁](#2-整体架构谁连谁)
3. [对外 MCP 工具（5 个）](#3-对外-mcp-工具5-个)
4. [核心设计（必读）](#4-核心设计必读)
5. [代码地图：每个文件干什么](#5-代码地图每个文件干什么)
6. [数据库与迁移](#6-数据库与迁移)
7. [本地启动（三种方式）](#7-本地启动三种方式)
8. [环境变量](#8-环境变量)
9. [常见问题排查（FAQ）](#9-常见问题排查faq)
10. [修改红线：这些东西不要动](#10-修改红线这些东西不要动)
11. [性能优化说明（2026-09 引入）](#11-性能优化说明2026-09-引入)

---

## 1. 系统一句话介绍

数字人（大模型）通过 MCP 协议调用本系统的 5 个工具，帮顾客完成美容门店的预约；店长在 Web 后台管理门店/员工/项目/排班并查看预约与调用日志。

```
顾客说话 → 数字人大模型 → 调用 MCP 工具（本系统）→ PostgreSQL 落库
                                ↓
                        管理后台（店长用）← REST API ←┘
```

技术栈：Node.js 22 + TypeScript + Express + PostgreSQL 16（node-postgres），前端 React + Vite + Ant Design，部署 Docker Compose。

---

## 2. 整体架构：谁连谁

本系统是 `xiaoke-project` 工作区中的一环，各仓库分工：

```
xiaoke-project/
├── Appointment system/      ← 本仓库：预约 MCP 后端(4020) + 管理后台(5180) + PG(5434)
├── digital-human-client/    ← 数字人客户端（语音/形象/对话渲染），不存人设
├── mcp platform/            ← MCP 注册/网关(3000)：Agent 人设、工具绑定在这里配
├── knowledge-platform/      ← 知识库项目管理(3001)：可预约项目的上游主数据
└── scan-gateway/            ← 扫码网关(3101)：顾客扫码后注入身份头
```

一次完整预约的数据流：

```
顾客扫码（scan-gateway 注入 X-Customer-Phone/Name）
  → 数字人语音识别出"约光子嫩肤"（人设在 mcp platform）
  → 大模型决定调用 query_slots
  → 本系统校验 门店→项目→员工技能→排班→占用，返回可约时段
  → 顾客确认后大模型调 manage_booking(action=create)
  → 本系统幂等落库 appointments + 审计 appointment_audits
  → 店长在 5180 后台看到新预约
```

> 注意：数字人的"人设/台词"配置在 mcp platform 侧，不在本仓库。数字人说话怪异（如念单号）先查平台侧人设，再查本系统返回体。

---

## 3. 对外 MCP 工具（5 个）

设计原则（对齐 Home Assistant 风格）：**少量通用工具 + action/resource/scope 参数路由**，降低大模型选工具的心智负担。内部能力全部保留，只是暴露面收敛。

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `list_store_catalog` | 查门店 / 项目 / 员工目录（合并了旧 3 个 list 工具） | `resource=stores\|services\|staff` |
| `query_slots` | 查某项目某天可约时段 | `service_name, store_name, date` |
| `query_bookings` | 查预约：我的列表/详情/审计/管理端列表/概览 | `scope=my\|detail\|audits\|list\|overview` |
| `manage_booking` | 预约动作：创建/取消/改期/签到/确认/完成/爽约 | `action=create\|cancel\|reschedule\|check_in\|confirm\|complete\|mark_no_show` |
| `manage_customer_session` | 共享终端识别/查询/结束顾客会话 | `action=identify\|get_current\|end` |

### 工具返回的两条铁律（大模型播报契约）

1. **时间**：一律读 `start_local`（东八区 `YYYY-MM-DD HH:mm`）。`start_at` 是 UTC ISO，读了会把上午十点说成凌晨两点。
2. **单号**：返回体已**不再包含** `appointment_code`（内部单号），创建成功统一说 `spoken.verification`：「凭手机号到店核实」。历史上大模型把 `apt_xxx` 十六进制码整串念给 TTS，逐字刷屏，属线上事故，已从源头剥离。管理后台 REST 仍可看全码。

### 口语 → 工具速查

| 顾客说 | 数字人应调 |
|---|---|
| "我想预约光子嫩肤" | `query_slots` → 复述时段 → **确认后** `manage_booking(action=create)` |
| "查我的预约" | `query_bookings(scope=my)` |
| "改到明天上午" | `manage_booking(action=reschedule, new_start_at=...)` |
| "退掉那个预约" | `manage_booking(action=cancel)` |
| （共享终端新客） | 先 `manage_customer_session(action=identify, customer_phone=..., customer_name=...)` |
| （顾客离开） | `manage_customer_session(action=end)` |

---

## 4. 核心设计（必读）

### 4.1 缺参追问（NEEDS_MORE_INFO）

大模型做不到"一次说全"，所以服务端缺什么就**结构化地**告诉它该问什么：

```json
{
  "success": false,
  "error_code": "NEEDS_MORE_INFO",
  "missing_fields": ["store_id|store_name"],
  "suggested_question": "请问您想到哪家门店？目前在营门店有：上海徐汇门店、武汉门店",
  "retry_hint": "用户回答后请填入参数 store_name"
}
```

大模型拿到后应继续问用户，而不是盲重试。`retry_hint` 明确告诉它答案该放进哪个参数——这是为了防"门店名被塞进员工名字段后无限重试"的线上事故（见 4.5）。

### 4.2 双层身份模型（数字人账号 ≠ 顾客）

门店一楼是一台公共数字人依次接待多位顾客。若把数字人账号当顾客，必然串号（A 看到/取消 B 的预约）。因此分两层：

```
IDENTITY_MODE=personal（默认）
  一人一数字人：数字人账号即顾客，行为同旧版。

IDENTITY_MODE=shared（门店公共终端，当前线上配置）
  数字人账号只代表"哪台机器在说话"；
  顾客身份靠 manage_customer_session(action=identify) 用手机号建立会话绑定。
  未识别时，顾客级工具一律返回 IDENTITY_REQUIRED（fail-closed，宁拒不漏）。
```

- 手机号只存哈希（`phone_hash`）+ 脱敏展示（`138****1111`），不存明文。
- 会话 TTL 默认 30 分钟，滑动续期；每次使用/顶替/结束均写 `entity_audits`。
- 会话绑定键为 `(agent_code, X-Session-Id)`：同一台机器并行多路对话互不串号。
- 扫码直通：scan-gateway 注入 `X-Customer-Phone/Name` 头后自动建绑，数字人无需再问手机号。
- 即使大模型伪造 `customer_id` 参数，shared 模式以会话绑定为准（忽略传参）。

### 4.3 幂等（防重复建单）

所有写操作要求/自动生成 `idempotency_key`。创建预约缺省时由「客户+项目+员工+时间」确定性生成，同一顾客对同一时段重复确认只会有一条。取消/完成/爽约后重约同一时段，幂等键自动加 `:rebook:` 后缀换新键正常建新单。大模型超时重试、顾客口误重复确认，都不会产生脏数据。

### 4.4 状态机（数据库强制）

```
pending → confirmed → checked_in → completed
   │         │            │
   └──→ cancelled ←────────┘
             confirmed → no_show
```

非法迁移由 PostgreSQL 触发器直接拒绝，不靠应用层自觉。

### 4.5 容错回收（LLM 填错参数的兜底）

大模型偶发把"上海徐汇门店"塞进 `preferred_staff_name`（员工字段）或 `note`，导致 `NEEDS_MORE_INFO` 死循环（线上日志曾连续 8 次同错误）。服务端在入口做三层回收，**只在大模型没显式传正字段时介入**：

1. `recoverMisplacedStoreName`：员工/项目字段里的值若能命中在营门店、且不是真实员工名 → 搬进 `store_name`；
2. `recoverFieldsFromNote`：note 里的"XX门店/XX项目/XX员工"短语剥离噪音前缀后搬回正字段；
3. schema `describe` 写明"门店名严禁填入 staff 字段"（事前预防）。

### 4.6 播报去码（TTS 防刷屏）

见第 3 节铁律 2。实现位置：`src/tools/tools.ts` 的 `stripCodes()`，对数字人可见的所有 `appointment` 对象统一删除 `appointment_code / booking_code`。

### 4.7 冲突控制与审计

- 同员工时段重叠由 PG 排他约束 `no_staff_booking_overlap` 兜底，并发双约第二个必被拒（应用层映射为 `TIME_CONFLICT`）。
- 建单前校验时段必须完整落在该员工一个 `available` 排班窗口内（`OUTSIDE_SCHEDULE`）。
- 预约每次状态变更写 `appointment_audits`（before/after 全量），基础资料变更写 `entity_audits`，事后可完整追溯。

---

## 5. 代码地图：每个文件干什么

### 后端 `src/`

```
src/
├── main.ts                  启动编排：migrate → seed → warmupPool → 监听 4020
├── server.ts                REST API（管理后台用）：/api/stores|staff|services|appointments|logs...
├── mcp-http.ts              MCP HTTP 传输层：tools/list、tools/call 路由、身份注入、计时
├── mcp.ts                   MCP 工具注册表（把 tools.ts 的 5 个工具装进协议）
├── stdio.ts                 stdio 传输（MCP_MODE=stdio 时本地客户端直拉）
├── tools/tools.ts           ★ 对外 5 工具的定义与 handler：schema、缺参提示、错放回收、去码
├── queries.ts               ★ SQL 层：门店/项目/员工/排班/占用/预约查询 + 基础资料缓存
├── services/
│   ├── appointments.ts      ★ 业务心脏：查时段、建/消/改/签到/完成/爽约、幂等、排班校验
│   ├── catalog.ts           基础资料写操作（门店/员工/项目增改停用）+ 写后清缓存
│   ├── kb-sync.ts           从知识库(3001)同步可预约项目（upsert services）
│   ├── mcp-call-log.ts      调用日志：内存缓冲 + 异步落库（fire-and-forget）+ 统计
│   └── customer-identity.ts 顾客建档/会话绑定/清扫（shared 模式核心）
├── db/
│   ├── pool.ts              PG 连接池（max/idle/超时/预热）
│   ├── migrate.ts           启动时按文件名序全量重跑 migrations/*.sql（全部幂等可重跑）
│   └── seed.ts              演示数据（仅空库时插入）
├── identity.ts              请求头 → agent 身份（X-Agent-Code / Bearer sub）
├── audit.ts                 审计写入（支持传入事务 client）
├── idempotency.ts           幂等操作包装器（cancel/reschedule 等用）
├── config.ts                环境变量加载
├── types.ts                 ★ 全部 TS 类型（改字段前先看这）
└── utils.ts                 时间（东八区）/手机号哈希/预约码生成
```

★ = 改动频率最高、最需要理解的三个文件。

### 前端 `web/src/pages/`

| 页面 | 路径 | 说明 |
|---|---|---|
| `OverviewView.tsx` | 概览 | 预约统计卡片 + 最近预约（含结束时间列） |
| `AppointmentsView.tsx` | 预约管理 | 列表/筛选/详情/签到/改期/取消/爽约，结束时间 = `end_at`（后端建单时按项目时长算好落库，前端只展示） |
| `SchedulesView.tsx` | 员工排班 | 月历式排班编辑、周模板批量铺班 |
| `ReferencesView.tsx` | 门店与项目 | 门店/员工/项目维护、知识库同步按钮 |
| `LogsView.tsx` | 日志中心 | MCP 调用记录：`duration_ms / arguments / error_code`，排查数字人问题第一现场 |
| `NewAppointmentView.tsx` | 新建预约 | 后台手工建单 |

> 前端 `Dockerfile` 构建时把 `dist` 烤进 nginx 镜像。**改前端必须 `docker compose up -d --build web`，只 `restart` 不会生效。**

### `migrations/`（001→009 按序执行，全部 IF NOT EXISTS 可重跑）

| 文件 | 内容 |
|---|---|
| `001_init.sql` | 核心表：stores/staff/services/appointments/audits + 防重叠排他约束 |
| `002_booking_optimizations.sql` | 补充索引、幂等写表 |
| `003_state_machine.sql` | 状态流转触发器 |
| `004_mcp_call_logs.sql` | MCP 调用日志表（日志中心数据源） |
| `005_admin_catalog.sql` | 后台目录支持表 |
| `006_store_services.sql` | 门店↔项目多对多（"这家店能做什么"） |
| `007_customer_identity.sql` | 顾客档案（手机号哈希） |
| `008_customer_session_scope.sql` | 会话作用域（X-Session-Id 并行隔离） |
| `009_perf_indexes.sql` | 性能索引 4 条（2026-09 新增，见第 11 节） |

---

## 6. 数据库与迁移

- 一张核心表 `appointments`：含 `start_at/end_at`（UTC 落库）、`idempotency_key`（唯一）、`status`、顾客冗余列（姓名/手机号，供"按人查"并集命中建档前 guest 单）。
- "按人查"语义：`customer_name + customer_phone` 成对校验通过后，取 `customer_id` 命中 ∪ 姓名手机同时命中的并集（`UNION ALL` + 去重）。**手机号相同 ≠ 同一人**（家人共用号必须排除），姓名必须同时匹配。
- 迁移在服务启动时自动执行（`migrate()` 全量重跑，幂等），无需手工跑。

---

## 7. 本地启动（三种方式）

### 方式一：Docker Compose（推荐，一条命令全起）

```powershell
cd "D:\B\python\xiaoke-project\Appointment system"
docker compose up -d --build     # 首次/改代码后必须 --build
docker logs appointment-mcp-service --tail 20   # 应看到 009 applied / pool warmed up
```

启动成功标志（三行都在才算起全）：

```
[migrate] applied 009_perf_indexes.sql
[db] pool warmed up
mcp http listening on 4020/mcp
```

| 地址 | 用途 |
|---|---|
| `http://localhost:4020/healthz` | 健康检查，返回 `{"ok":true}` |
| `http://localhost:4020/mcp` | MCP 端点（数字人/平台接这里） |
| `http://localhost:5180` | 管理后台 |
| `localhost:5434` | PostgreSQL（账号 postgres/postgres，库 appointment_mcp） |

**每天开机第一件事**：本 compose 与其他项目（mcp-platform 等）不是同一个栈，机器重启后不会自动全起，需到本目录执行 `docker compose up -d`。

### 方式二：本地 Node 开发（热重载）

```bash
pnpm install
pnpm run migrate
pnpm run seed
pnpm run dev          # MCP_MODE=http 默认
```

### 方式三：stdio 模式（本地 MCP 客户端直拉）

```bash
MCP_MODE=stdio pnpm run dev
```

### 常用自检命令

```powershell
# 健康检查
curl http://localhost:4020/healthz

# 查看性能索引是否在位（应返回 4 行）
docker exec appointment-mcp-postgres psql -U postgres -d appointment_mcp -c `
  "SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_appointments_idem4','idx_staff_name_active','idx_stores_active_name','idx_schedules_available');"

# 用真实数据跑一次慢查询分析（排查耗时用）
docker exec -it appointment-mcp-postgres psql -U postgres -d appointment_mcp
# 然后粘贴 EXPLAIN (ANALYZE, BUFFERS) SELECT ...（注意一次只跑一条，以分号结尾）
```

---

## 8. 环境变量

复制 `.env.example` 为 `.env`。Docker 部署时 `docker-compose.yml` 已内置默认值，一般无需改动。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | compose 内 `postgres:5432` | PG 连接串；本机直连用 `localhost:5434` |
| `MCP_HTTP_PORT` | `4020` | HTTP 端口 |
| `MCP_MODE` | `http` | `http` 或 `stdio` |
| `IDENTITY_MODE` | `shared`（compose 内） | `personal`=一人一数字人；`shared`=公共终端需识别顾客 |
| `CUSTOMER_SESSION_TTL_MS` | `1800000` | 顾客会话 30 分钟，滑动续期 |
| `KNOWLEDGE_BASE_URL` | `host.docker.internal:3001` | 知识库同步源 |
| `KNOWLEDGE_BASE_ADMIN_TOKEN` | `dev-admin-token` | 知识库鉴权 |
| `ADMIN_TOKEN` | 空 | 后台 API 鉴权，生产建议设置 |
| `POOL_MAX` | `10`（1~50） | PG 连接池上限，2 核容器给 10~20 即可 |
| `TZ` | `Asia/Shanghai` | 时区（影响 start_local 口播时间） |

---

## 9. 常见问题排查（FAQ）

**Q1：数字人"一直在刷同一句话/不说话"**
先开管理后台 → 日志中心，看最近那条调用：
- 连续多条 `NEEDS_MORE_INFO` 且参数一样 → 大模型在盲重试。看 `arguments` 里哪个字段错放（如门店名进了 `staff_name`），服务端回收应已兜住；若复现，把那条 `arguments` 完整拷出提 issue。
- 日志里**没有**这次调用的记录 → 大模型压根没调工具，是人设/平台侧问题（去 mcp platform 查 Agent 配置），不是本系统问题。

**Q2：某次调用耗时特别高（如 200ms+），但平时几十 ms**
- 服务刚重启/缓存刚失效后的第一次调用是冷启动（建连+建缓存），属预期；
- 后台任何"增改停用门店/员工/项目"或"同步知识库"都会清基础资料缓存，下一次调用变冷，也属预期；
- 持续高才需要排查：压测时**关闭管理后台的预约页/日志页**（30s 轮询与工具抢同一个连接池），再用 `EXPLAIN ANALYZE` 定位慢查询。

**Q3：改了前端代码，页面没变化**
前端是构建时打进 nginx 镜像的：`docker compose up -d --build web`，然后浏览器 `Ctrl+Shift+R` 硬刷新。只 `restart` 无效。

**Q4：改了后端代码，工具行为没变**
同上，service 也要 `--build`：`docker compose up -d --build appointment-service`。

**Q5：数字人把预约码/编号念出来了**
本系统返回已剥离全部单号（见 4.6）。若仍出现：确认容器镜像是最新的（`docker compose up -d --build appointment-service`），再去 mcp platform 检查 Agent 人设里是否残留"编号/台词"类文案。

**Q6：两条预约时间撞了**
系统按"同一员工排班窗口 + 排他约束"防重叠。被拒时返回 `TIME_CONFLICT`（并发兜底）或 `OUTSIDE_SCHEDULE`（不在排班内），话术已内置，无需人工仲裁。注意：当前**没有**"上一位结束后 30 分钟缓冲"规则，背靠背预约是允许的（见第 11 节待办）。

**Q7：shared 模式下工具返回 IDENTITY_REQUIRED**
正常流程：让数字人先 `manage_customer_session(action=identify)` 问手机号，或顾客扫码自动绑定。这不是错误，是 fail-closed 设计。

---

## 10. 修改红线：这些东西不要动

接手后**最容易引发线上事故**的四件事，改之前必须找负责人确认：

1. **不缓存排班/占用/预约数据**。基础资料（门店/项目/技能）可以 45s 缓存，但排班和占用一旦缓存，并发下会双约（两个顾客约到同一时段）。`queries.ts` 里 `cachedQuery` 只允许包基础资料查询。
2. **不把审计 INSERT 移出建单事务**。`BEGIN → INSERT预约 → INSERT审计 → COMMIT` 保证"预约与审计同生共死"，拆开就丢审计。
3. **不把调用日志改回同步写入**。`recordMcpCall` 必须 fire-and-forget（`void`，不 await）：日志表与业务共用连接池，同步写会在池满时把工具响应拖到秒级（已发生过）。
4. **不改 5 个工具的名字/参数名/返回字段名**。数字人侧提示词与平台配置按当前契约写的，改任何一个 key 都是联调事故。新增字段可以，改名/删字段不行。

附加两条提醒：
- `CompactTimeSlot`（`staff_name/start_local/start_at` 三字段）是对数字人的最小契约，`query_slots` 返回只增不改。
- 数据量上来后加索引不要走 `migrations/`（migrate 在事务里执行，`CONCURRENTLY` 不可用），用 psql 单条在线建。

---

## 11. 性能优化说明（2026-09 引入）

本次优化目标：`query_slots/manage_booking` 从 150~340ms 降到热态 5~10ms，且**不改变任何对外契约**。

### 做了什么

| 措施 | 位置 | 效果 |
|---|---|---|
| 基础资料进程内缓存（TTL 45s，版本守卫） | `queries.ts` `cachedQuery` + `fetchActiveStores` | 门店/项目/技能查询热态 0~1ms |
| 门店/项目/技能/员工单查全部走同一缓存 | `queries.ts` | 每次 `query_slots` 少 3~4 次 DB 往返 |
| 写操作统一失效缓存 | `catalog.ts` 9 处 + `kb-sync.ts` | 缓存最脏 45s，随后自愈 |
| 建单幂等查询拆 OR 为两次索引查询 | `services/appointments.ts` `findExistingAppointmentForCreate` | OR 写法导致全表扫，数据量涨后必慢；语义完全等价 |
| "按人查" OR 改 UNION ALL | `queries.ts` `listAppointmentsByCustomer` | 同上；已用真实数据验证新旧结果一致（6=6） |
| 新增 4 条索引 | `migrations/009_perf_indexes.sql` | 幂等四元组/员工名/在营门店/available 排班 |
| 连接池超时与保活 | `db/pool.ts` | 慢查询 10s 快速失败，不拖死池子 |
| 启动连接预热 | `db/pool.ts` `warmupPool` | 冷启动首笔调用不付建连开销 |

实测（同参数直连库复测）：`query_slots` 冷 142ms → 热 5~9ms；线上日志热态普遍 5~60ms。
