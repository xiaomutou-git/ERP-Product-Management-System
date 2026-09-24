<div align="center">

# ERP 商品管理系统

中小企业商品管理解决方案 · 覆盖 **商品 / 供应商 / 采购 / 库存** 四大核心环节 · 数据看板辅助经营决策

**前后端分离 · 单机零成本部署 · 生产级安全加固**

![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-Build-646CFF?logo=vite&logoColor=white)
![Element Plus](https://img.shields.io/badge/Element_Plus-UI-409EFF?logo=element&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-单文件-003B57?logo=sqlite&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-包管理-F69220?logo=pnpm&logoColor=white)

[产品需求文档](docs/PRD.md) · [UI 设计稿](docs/UI-DESIGN.md) · [安全审计报告](docs/SECURITY-REPORT.md) · [用户体验点评](docs/CRITIQUE-REVIEW.md)

</div>

---

## 目录

- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [快速启动](#快速启动)
- [默认账号](#默认账号)
- [环境变量](#环境变量)
- [安全机制](#安全机制)
- [自动化验证](#自动化验证)
- [备份说明](#备份说明)

## 功能特性

| 模块 | 能力概览 |
| --- | --- |
| 数据看板 | 商品总数 / 库存总量 / 低库存预警 / 近 7 日采购金额趋势（ECharts） |
| 商品管理 | 分类树、SKU 编码唯一性校验、模糊搜索、分页、软删除业务约束 |
| 供应商管理 | 供应商 CRUD、状态启停、引用约束保护 |
| 采购管理 | 采购单状态机（草稿 → 已提交 → 已入库），入库在**同一事务**内完成库存增加与流水写入，重复入库幂等拒绝 |
| 库存管理 | 低库存阈值预警、手动出入库调整、库存流水只增不删 |
| 用户与权限 | 4 角色 RBAC 权限矩阵、首登强制改密、管理员解锁与重置密码 |
| 审计日志 | 关键操作全留痕（含登录、越权、令牌重放等安全事件），只增不改不删 |

## 技术栈

| 端 | 技术 |
| --- | --- |
| 前端 | Vue 3 + TypeScript + Vite + Element Plus + Pinia + Vue Router（history）+ ECharts 5 |
| 后端 | Node.js + Express + better-sqlite3 + JWT（jsonwebtoken）+ bcryptjs + zod |
| 包管理 | pnpm（禁用 npm / yarn） |
| 数据库 | SQLite 单文件（金额以「分」存储，时间 ISO8601 UTC） |

## 项目结构

```text
ERP商品管理系统/
├─ backend/               后端（端口 3001）
│  ├─ src/
│  │  ├─ index.js         启动入口（建库建表 + 种子数据 + 监听）
│  │  ├─ app.js           Express 装配（helmet/CORS/限流/路由/错误处理）
│  │  ├─ db/              连接、建表 schema、种子数据
│  │  ├─ middlewares/     JWT 认证、RBAC 角色校验、zod 校验、限流、错误处理
│  │  ├─ routes/          auth / categories / products / suppliers /
│  │  │                   purchase-orders / inventory / dashboard / users / audit-logs
│  │  └─ utils/           统一响应、JWT、审计日志、限流共享存储、refresh 令牌仓库
│  ├─ data/erp.db         SQLite 数据库文件（首次启动自动生成）
│  └─ .env                环境变量（JWT_SECRET / PORT / DB_PATH / CORS_ORIGIN）
├─ frontend/              前端（dev 端口 5173，/api 代理到 3001）
│  └─ src/
│     ├─ api/             axios 封装（401 静默刷新重放、错误提示）
│     ├─ layouts/         主布局（侧栏 + 顶栏 + 内容区，响应式三态）
│     ├─ router/          路由 + 守卫（角色拦截、强制改密拦截）
│     ├─ stores/          Pinia 认证状态
│     ├─ styles/          设计令牌（UI-DESIGN.md 色值/圆角/阴影/动画落地）
│     └─ views/           登录 / 看板 / 商品(含分类) / 供应商 / 采购 / 库存 / 用户 / 日志 / 404
├─ docs/                  PRD / UI 设计稿 / 安全审计报告 / 用户体验点评
└─ scripts/verify.mjs     后端全链路自动化验证脚本（48 项断言）
```

## 快速启动

### 环境要求

- Node.js ≥ 20
- pnpm ≥ 8（`npm install -g pnpm`）

### 开发模式

```bash
# 1. 后端
cd backend
pnpm install
pnpm start            # 或 pnpm dev（watch 模式），默认 http://localhost:3001

# 2. 前端（另开终端）
cd frontend
pnpm install
pnpm dev              # http://localhost:5173
```

前端 Vite dev（5173）经代理访问后端 3001；登录后双令牌由后端写入 **HttpOnly Cookie**（浏览器自动携带，前端 JS 不可读写），CORS/CSRF 白名单放行 `http://localhost:5173`。

### 生产部署（同源单端口模式）

```bash
cd frontend && pnpm build     # 构建产物 dist/（TypeScript 零报错）
cd ../backend && pnpm build   # 后端语法检查

# 以生产模式启动：托管 frontend/dist + 启用 CSP + Cookie 追加 Secure
$env:NODE_ENV='production'; pnpm start   # PowerShell（Linux/macOS: NODE_ENV=production pnpm start）
```

生产模式访问 `http://localhost:3001` 即为完整应用（首页 + API 同源），history 路由深链接由 SPA fallback 兜底；CSP 策略仅生产启用（`script-src 'self'` 不放开 unsafe-eval / unsafe-inline），开发模式关闭以保证 Vite HMR 正常。

> [!WARNING]
> 生产环境必须配置 HTTPS 并开启 HSTS，Cookie 的 `Secure` 属性才能完全生效；`JWT_SECRET` 必须 ≥ 32 字符。

## 默认账号

| 用户名 | 初始密码 | 角色 | 说明 |
| --- | --- | --- | --- |
| admin | ***REMOVED-SEED-PASSWORD*** | 系统管理员 | **首次登录强制修改密码** |
| purchaser01 | ***REMOVED-SEED-PASSWORD*** | 采购员 | 供应商与采购单维护 |
| stocker01 | ***REMOVED-SEED-PASSWORD*** | 库存管理员 | 商品/分类/入库/库存调整 |
| viewer01 | ***REMOVED-SEED-PASSWORD*** | 查看员 | 全部只读 |

内置演示数据：3 个一级分类（含 3 个子分类）、12 个商品、3 个供应商、3 张采购单（已入库/已提交/草稿各一张）与库存流水。

> [!IMPORTANT]
> 上线前请立即修改全部默认密码。

## 环境变量

配置文件：`backend/.env`

| 变量 | 说明 |
| --- | --- |
| `PORT` | 后端端口，默认 3001 |
| `JWT_SECRET` | JWT 密钥，**必须 ≥ 32 字符**，未配置则启动失败 |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | 双令牌有效期（秒），默认 7200 / 604800 |
| `REFRESH_GRACE_PERIOD_SECONDS` | refresh 轮换宽限窗口（秒），默认 30；设为 `0` 关闭宽限回到严格重放模式 |
| `DB_PATH` | SQLite 文件路径，默认 `./data/erp.db` |
| `CORS_ORIGIN` | 允许的前端来源（CORS），同时用作 **CSRF Origin 白名单**（多个用英文逗号分隔），生产环境禁止 `*` |
| `NODE_ENV` | 设为 `production` 时：托管 frontend/dist、启用 CSP、Cookie 追加 Secure；未设置时为开发模式 |

## 安全机制

<details>
<summary><b>双令牌 HttpOnly Cookie 传输</b></summary>

登录成功后 `accessToken`（2h，`path=/`）与 `refreshToken`（7d，`path` 收窄为 `/api/auth`）经 `Set-Cookie` 下发，`HttpOnly + SameSite=Lax`，生产环境追加 `Secure`。**响应 JSON 不含任何 token 明文**，前端不将 token 写入 localStorage / sessionStorage 或任何可被 JS 读取的存储，杜绝 XSS 窃取。

</details>

<details>
<summary><b>refresh token 轮换 + 重放检测</b></summary>

每个 refresh token 携带唯一 `jti` 并落库 `refresh_tokens` 表（status=active）。每次 `POST /api/auth/refresh` 校验签名与过期后查 jti 状态：

- **active → 轮换**：旧行置 `rotated`（记录 replaced_by 溯源链与 rotated_at 轮换时刻），签发全新 jti 的 refresh token + 新 access token 经 Set-Cookie 下发，滑动续期 7 天
- **rotated / revoked → 判定重放**（令牌可能泄露）：立即撤销该用户全部 active refresh token 并 `token_version + 1` 全端失效，返回 401 并写审计日志 `refresh_replay_detected`（含 user_id / jti / IP）
- **jti 不存在**（伪造）→ 401

登出将当前 jti 置 `revoked`。过期会话行由后端每 10 分钟定时清理。

</details>

<details>
<summary><b>轮换宽限窗口（多 tab 并发竞态修复）</b></summary>

同一浏览器多标签页同时用同一旧 refresh token 刷新时，后到者命中 `rotated` 状态不再误判为重放：

- **宽限窗口内**（`now - rotated_at <= REFRESH_GRACE_PERIOD_SECONDS`，默认 30 秒）：视为并发竞态而非攻击——沿 `replaced_by` 溯源链找到家族当前 active 的**叶子令牌**，直接以其所属用户信息换发新 access cookie（叶子不轮换、宽限窗口以原 rotated_at 为准不重置），返回 200 并写审计日志 `refresh_grace_reuse`（含 user_id / jti / IP）供安全监测
- **宽限窗口外**的 rotated 复用与 **revoked**（登出/被撤销）令牌复用仍走重放防护

安全取舍：宽限窗口内旧令牌可复用换取同源会话（窗口默认仅 30 秒，远小于 7 天有效期，且每次复用均留审计痕迹），换取正常用户多 tab 并发不被误伤；链上叶子已被撤销/过期时仍按重放处置，改密（tv+1）后旧令牌即使在宽限内也不放行。设 `REFRESH_GRACE_PERIOD_SECONDS=0` 可关闭宽限回到严格模式。

</details>

<details>
<summary><b>鉴权通道与会话恢复</b></summary>

- `authenticate` 中间件优先读取 Cookie，兼容 `Authorization: Bearer` 头（平滑过渡，供脚本/服务间调用）
- **静默续期**：access 过期返回 401 时，前端 axios 拦截器自动请求 `POST /api/auth/refresh`（凭 Cookie 换发新 access + 新 refresh，均写 Cookie）并重放原请求；刷新失败（含轮换撤销导致的 401）清空 Pinia 用户态并直接跳转登录页——单飞 + 队列 + 排除登录/刷新接口 + `_retried` 标记四重防护，保证不会死循环刷新
- **会话恢复**：用户名/角色等非敏感展示数据仅存 Pinia 内存；页面刷新后路由守卫自动调 `/api/auth/me` 恢复会话

</details>

<details>
<summary><b>CSRF 防护与登出</b></summary>

- Cookie 方案必配——`SameSite=Lax` 为第一道防线；写操作（POST / PUT / PATCH / DELETE）校验 `Origin/Referer` 与允许源（`CORS_ORIGIN` 白名单或同源请求）一致，不一致返回 403
- **登出**：当前 refresh token 的 jti 置 `revoked` + 后端 `token_version + 1` 令全端旧令牌立即失效，并清除两类 Cookie（maxAge=0）

</details>

<details>
<summary><b>限流共享存储与登录锁定</b></summary>

- **限流计数器 SQLite 共享存储**：全局限流（300 次/分/IP）与登录限流（10 次/分/IP）的计数存于 SQLite 独立表 `rate_limit_hits`（自定义 express-rate-limit Store，UPSERT 原子计数 + 前缀隔离键空间 + 每 10 分钟过期清理）。**单机多进程部署共享同一份计数，无法通过分摊请求绕过限流**；跨机器多实例部署需改用 Redis 版 store（见 [sqliteRateLimitStore.js](backend/src/utils/sqliteRateLimitStore.js) 注释说明）
- **登录失败锁定**：同账号连续 5 次密码错误锁定 15 分钟，计数存 `users.failed_attempts`（SQLite），多进程/多实例天然共享；管理员可手动解锁

</details>

<details>
<summary><b>基础安全规范</b></summary>

- 密码 bcrypt（cost=10）哈希存储；接口与审计日志永不返回密码哈希/明文
- SQL 全部参数化查询；zod schema 校验；helmet 安全头；CORS 白名单
- 生产 CSP：`script-src 'self'`（不放开 unsafe-eval / unsafe-inline）、`style-src 'self' 'unsafe-inline'`（Element Plus/Vue 运行时样式所需）等
- 前端按权限矩阵显隐按钮（PRD 2.2），401 静默刷新 / 跳登录，403 统一提示
- 库存流水与审计日志只增不改不删；删除商品/分类/供应商均有业务约束保护

</details>

## 自动化验证

后端服务启动后执行（约 3 分钟，含限流窗口等待）：

```bash
node scripts/verify.mjs
```

覆盖 **48 项断言**：

- [x] 健康检查、登录（Set-Cookie HttpOnly 双 Cookie / JSON 无 token 明文）、强制改密、旧会话失效、refresh（凭 Cookie）
- [x] SQL 注入串搜索、唯一性 409、RBAC 越权 403、CSRF 伪造 Origin 403
- [x] 采购单创建 → 提交 → 入库 → 库存 +5 → 流水、手动出入库、低库存筛选、看板统计
- [x] 登录锁定与解锁、登出清除 Cookie 与会话失效
- [x] refresh 轮换换发全新 Cookie、旧令牌重放 401 + 全端撤销、审计日志留痕、未知 jti 伪造令牌 401、登出 jti 置 revoked（直查 SQLite）
- [x] SQLite 共享限流打满 429 且计数表可见
- [x] 轮换宽限：宽限内并发双刷不误伤、宽限过期重放 401、宽限审计 `refresh_grace_reuse`、revoked 无宽限

> [!NOTE]
> 前置假设：运行前数据库为全新种子状态（若库中已存在 TEST-001 等历史验证数据，请先备份并重置 `backend/data/erp.db` 后重启后端）。

## 备份说明

SQLite 单文件备份：停止后端或使用 WAL 模式下复制 `backend/data/erp.db`（连同 `-wal` / `-shm`）即可。

## 项目文档

| 文档 | 说明 |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | 产品需求文档：角色权限矩阵、功能需求、数据模型、API 清单、验收标准 |
| [docs/UI-DESIGN.md](docs/UI-DESIGN.md) | UI 设计稿：设计令牌、布局系统、组件规格、逐页面设计 |
| [docs/SECURITY-REPORT.md](docs/SECURITY-REPORT.md) | 安全审计报告：三轮渗透测试、漏洞清单与修复、遗留风险处置 |
| [docs/CRITIQUE-REVIEW.md](docs/CRITIQUE-REVIEW.md) | 用户体验点评：多维度严苛评审与改进记录 |
