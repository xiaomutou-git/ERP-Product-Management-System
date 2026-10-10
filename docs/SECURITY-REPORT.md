# ERP 商品管理系统安全测试报告

| 项目 | 内容 |
| --- | --- |
| 测试对象 | ERP 商品管理系统（backend: Express + better-sqlite3，frontend: Vue3 + TS + Vite） |
| 测试日期 | 2026-09-21 |
| 测试性质 | 授权安全测试（项目属用户本人），静态代码审计 + 动态验证 + 修复复测 |
| 测试人 | 渗透测试工程师（自动化辅助） |
| 结论 | 共发现漏洞 **8** 个（P1 × 1、P2 × 4、P3 × 3，P0 × 0），**已全部修复**；修复后功能验证 36/36 通过 |

---

## 1. 测试概览

### 1.1 测试方法

1. **静态审计**：通读 backend 全部 routes（9 个）/ middlewares（4 个）/ utils（3 个）/ db（3 个）与 frontend 关键代码（http.ts、auth.ts、router、LoginView、api/index.ts），逐项核查 PRD 4.2 安全基线 S1~S12。
2. **动态测试**：对运行于 3001 端口的服务发起 50+ 组攻击请求，覆盖未授权访问、垂直越权、SQL 注入、XSS 存储型注入、IDOR、令牌篡改/算法混淆、限流与锁定绕过、金额溢出、审计 IP 伪造、异常参数健壮性等场景。
3. **依赖审计**：`pnpm audit`（官方 registry）检查前后端依赖已知 CVE。
4. **修复复测**：修复后重启服务，重放攻击载荷确认全部失效，并重跑 `node scripts/verify.mjs` 确认功能无回归。

### 1.2 漏洞清单总表

| 编号 | 严重程度 | 漏洞名称 | 位置（修复前） | 状态 |
| --- | --- | --- | --- | --- |
| VULN-01 | **P1** | 登出不失效令牌（access/refresh 登出后仍可用） | backend/src/routes/auth.routes.js logout 路由 | 已修复 |
| VULN-02 | **P2** | 采购进价/售价无上限，总金额整数精度溢出（实测入库 9.007e21） | backend/src/routes/purchaseOrders.routes.js / products.routes.js / inventory.routes.js | 已修复 |
| VULN-03 | **P2** | 审计日志客户端 IP 可被 X-Forwarded-For 伪造 | backend/src/utils/audit.js clientIp() | 已修复 |
| VULN-04 | **P2** | 缺失 .gitignore，.env（含 JWT_SECRET）与数据库文件存在入库泄露风险 | 项目根目录 | 已修复 |
| VULN-05 | **P3** | JWT_SECRET 为低熵可预测静态字符串 | backend/.env | 已修复（已轮换） |
| VULN-06 | **P3** | LIKE 模糊搜索通配符（%/ _）未转义，可篡改搜索语义 | 6 个路由文件的 LIKE 查询 | 已修复 |
| VULN-07 | **P3** | 登录接口时序侧信道可枚举有效用户名 | backend/src/routes/auth.routes.js login | 已修复 |
| VULN-08 | **P2** | 前端 echarts < 6.1.0 存在 XSS 漏洞（GHSA-fgmj-fm8m-jvvx，moderate） | frontend/package.json | 已修复（升级 6.1.0） |

严重度分布：**P0 = 0，P1 = 1，P2 = 4，P3 = 3**；全部修复完毕并复测通过。

---

## 2. 漏洞详情与修复说明

### VULN-01（P1）登出不失效令牌

- **位置**：[auth.routes.js logout 路由](backend/src/routes/auth.routes.js#L118-L132)
- **复现步骤**：
  1. 登录获取 accessToken / refreshToken；
  2. `POST /api/auth/logout` 登出；
  3. 用旧 accessToken 请求 `GET /api/auth/me` → 修复前返回 200（仍有效）；
  4. 用旧 refreshToken 请求 `POST /api/auth/refresh` → 修复前返回 200（可换新 token）。
- **根因**：登出仅写审计日志，未做任何服务端令牌撤销；无状态 JWT 在有效期内（access 2h / refresh 7d）持续可用，被盗令牌无法通过登出止损。
- **危害**：攻击者窃取的令牌在用户登出后仍可长期冒用，登出功能形同虚设。
- **修复**：登出时执行 `UPDATE users SET token_version = token_version + 1`，使该用户全部 access/refresh token 立即失效（authenticate 与 refresh 均校验 token_version）。
- **复测**：登出后旧 access token 返回 401、refresh token 返回 401。通过。

### VULN-02（P2）金额/数量字段无上限，整数精度溢出

- **位置**：[purchaseOrders.routes.js itemSchema](backend/src/routes/purchaseOrders.routes.js#L25-L33)、[products.routes.js salePrice](backend/src/routes/products.routes.js#L31)、[inventory.routes.js adjust](backend/src/routes/inventory.routes.js#L114-L119)
- **复现步骤**：采购员创建采购单，`items[0].unitPrice = 9007199254740991`、`quantity = 999999` → 修复前创建成功，`total_amount` 实测入库为 `9.007190247541736e+21`（超出 JS `Number.MAX_SAFE_INTEGER`，精度丢失且 SQLite 列降级为 REAL 存储）。
- **根因**：zod schema 对 unitPrice/salePrice 仅设下限无上限；库存调整的 `after` 值未封顶，可通过多次调整累计至超精度范围。
- **危害**：金额字段是财务核心数据，精度溢出导致对账错误、报表失真；异常大值还可能引发下游计算异常（完整性破坏）。
- **修复**：
  - `unitPrice` / `salePrice` 增加 `.max(99999999)`（单笔上限 999999.99 元），超限返回 400；
  - 手动调整与采购入库的调整后库存增加 `999999999` 上限，超限拒绝（入库在事务内抛出并整体回滚）；
  - 上限组合下最大总额 999999 × 99999999 ≈ 1e14 < 2^53，恒在安全整数范围。
- **复测**：unitPrice=9007199254740991 → 400；unitPrice=100000000 → 400；边界值 99999999 → 创建成功且 total_amount=99999999 精度正确；salePrice=100000000 → 400。通过。

### VULN-03（P2）审计日志 IP 可被伪造

- **位置**：[audit.js clientIp()](backend/src/utils/audit.js#L61-L75)
- **复现步骤**：携带请求头 `X-Forwarded-For: 6.6.6.6` 尝试登录 → 修复前审计日志 `ip` 字段记录为 `6.6.6.6`（实测复现）。
- **根因**：clientIp() 无条件信任 X-Forwarded-For 头，而服务直连部署时该头可由任意客户端随意构造。
- **危害**：审计日志是安全溯源依据，IP 可被任意污染导致溯源失效、责任归属失真，也为"日志投毒"提供入口。
- **修复**：仅在应用显式设置 `trust proxy`（存在可信反向代理）时才读取 XFF，否则一律使用 socket 地址（req.ip）。
- **复测**：伪造 XFF 后审计记录的 IP 为真实本机地址。通过。

### VULN-04（P2）缺失 .gitignore，敏感文件存在入库泄露风险

- **位置**：项目根目录（修复前不存在任何 .gitignore）
- **问题说明**：`backend/.env` 含 JWT 签名密钥、`backend/data/erp.db` 含用户密码哈希与全部业务数据、`.pnpm-cache/` 等缓存目录，一旦 `git init` 后随手提交即造成密钥与数据泄露。属"配置缺失"类风险，为后续版本管理埋雷。
- **修复**：
  - 新增根目录 [.gitignore](.gitignore)：排除 `.env*`、`backend/data/`、`*.db*`、`node_modules/`、`dist/`、日志与缓存目录；
  - 新增 [backend/.env.example](backend/.env.example) 模板（不含真实值），规范环境变量交付方式。

### VULN-05（P3）JWT_SECRET 为低熵可预测值

- **位置**：backend/.env（修复前 `***REMOVED-ROTATED-JWT-SECRET***`）
- **根因**：密钥为"项目名 + 日期 + 顺序字符"的可猜测模式，若该值曾在文档/聊天/代码中出现过，攻击者可离线伪造任意用户的有效 JWT（含 admin），彻底绕过认证。
- **修复**：已轮换为 `crypto.randomBytes(48)` 生成的 96 位高熵随机密钥，并在 .env 注释中标注生成方式；轮换后所有旧签名 token 自动失效（间接复测 R18 通过）。密钥不再出现在任何文档中。

### VULN-06（P3）LIKE 通配符未转义

- **位置**：products / users / suppliers / purchaseOrders / inventory / auditLogs 共 6 处关键词搜索
- **复现步骤**：`GET /api/products?keyword=%25`（即 `%`）→ 修复前返回全部 12 条商品。
- **根因**：参数化查询防住了 SQL 注入，但用户输入中的 `%`/`_` 仍作为 LIKE 通配符解释，攻击者可用 `%%%...` 构造全表扫描（轻微 DoS）或探测数据分布。
- **修复**：新增 [escapeLike()](backend/src/utils/response.js#L57-L68) 工具函数转义 `\`、`%`、`_`，所有 LIKE 语句补 `ESCAPE '\'` 子句。注：generateOrderNo 中按单号前缀匹配的 LIKE 为内部生成值，非用户输入，无需转义。
- **复测**：`keyword=%`、`keyword=_` 均命中 0 条；`keyword=无线` 正常命中（功能无回归）；SQLi 字符串仍安全。通过。

### VULN-07（P3）登录时序侧信道枚举用户名

- **位置**：[auth.routes.js login](backend/src/routes/auth.routes.js#L51-L57)
- **根因**：用户不存在时直接返回错误（无 bcrypt 运算，约几毫秒），用户存在时执行 cost=10 的 bcrypt 比对（约 100 毫秒），可通过响应耗时差异批量枚举有效用户名。
- **修复**：模块加载时预生成占位 bcrypt 哈希（DUMMY_BCRYPT_HASH），用户不存在时也执行一次等代价比对，抹平时序差后再返回统一错误文案。
- **备注**：本次静态审计同时确认"账号已停用"返回 403 明确提示为 PRD 2.3 要求的既有设计，不计为漏洞。

### VULN-08（P2）echarts < 6.1.0 XSS 漏洞（依赖 CVE）

- **位置**：frontend/package.json（修复前 echarts ^5.6.0）
- **依据**：`pnpm audit` 报告 moderate 级漏洞 [GHSA-fgmj-fm8m-jvvx](https://github.com/advisories/GHSA-fgmj-fm8m-jvvx)（Apache ECharts 跨站脚本漏洞），修复版本 >= 6.1.0。
- **修复**：`pnpm add echarts@^6.1.0` 升级至 6.1.0；`vue-tsc --noEmit && vite build` 构建验证通过（看板图表 API `init/setOption/dispose` 在 v6 中保持兼容）。
- **复测**：`pnpm audit` 重新执行，前后端均报 "No known vulnerabilities found"。

---

## 3. 核查为安全的项目（未发现漏洞）

| 核查项 | 验证方式与结果 |
| --- | --- |
| SQL 注入 | 全部查询参数化；keyword/sort/categoryId 注入载荷（`' OR '1'='1`、UNION SELECT、`DROP TABLE`）实测：sort 枚举白名单拦截 400、其余正常返回无泄露，未获取任何哈希/越权数据 |
| 垂直越权 | viewer 创建管理员/访问用户列表/审计日志、purchaser 创建商品/入库、stocker 创建/提交采购单 → 全部 403 |
| 认证边界 | 无 token → 401；篡改签名 → 401；alg=none 伪造 → 401；refresh token 冒充 access token → 401（type 隔离生效） |
| 水平越权（IDOR） | 按 ID 接口均校验资源存在性；业务数据为全局共享（PRD S9 明确非租户隔离），改密接口仅操作 req.user.id 自身，无法操作他人 |
| XSS | 后端存储原样返回属预期；前端全部 Vue 文本插值渲染（全项目无 v-html/innerHTML），Vue 默认转义生效，符合 PRD S4 |
| 错误信息泄露 | 非法 JSON → 400 统一文案；异常 ID（abc/1e999/负数/超大值）→ 404；未知异常 → 500 统一文案，无堆栈/SQL/路径外泄 |
| 安全响应头 | helmet 生效：X-Content-Type-Options=nosniff、X-Frame-Options=DENY、无 X-Powered-By |
| 暴力破解 | 登录限流 10 次/分/IP 实测第 11 次返回 429；同账号 5 次错密锁定 15 分钟，锁定期间正确密码亦 423，管理员可解锁 |
| 金额与库存安全 | 金额一律整数分（修复后含上限）；负数调整量 400；出库后库存 < 0 被拒且不产生流水 |
| 输入校验 | zod 全接口 schema 校验，字段级错误明细，未知字段自动剥离 |
| CORS | 仅允许 CORS_ORIGIN 配置来源，未使用 * |
| 依赖安全 | 修复后前后端 `pnpm audit` 均 0 漏洞（PRD S12 达成） |
| 前端路由守卫 | 守卫为体验层防御，敏感接口均有后端 RBAC 兜底，不存在仅靠前端拦截的受保护资源 |

---

## 4. 复测结果汇总

| 验证项 | 结果 |
| --- | --- |
| 攻击载荷重放（第三轮复测脚本 18 项断言） | **18/18 通过** |
| 功能回归 `node scripts/verify.mjs`（36 项断言） | **36/36 通过** |
| 全新种子库复确认（VULN-01/02 关键载荷） | **通过**（access/refresh 均失效；超大进价 400） |
| `pnpm audit`（backend + frontend，官方 registry） | **0 漏洞** |
| 前端构建（vue-tsc + vite build，echarts 升级后） | **通过** |

> 说明：验证前将数据库重置为全新种子状态（verify.mjs 的前置假设；原库仅含开发演示数据与本次测试数据，备份已存于系统临时目录 `%TEMP%\erp-backup.db`）。测试过程创建的临时脚本已清理，未在项目内遗留测试代码。

---

## 5. 遗留风险与加固建议

以下为**评估后接受的残余风险**（当前威胁模型下可接受），按优先级给出后续建议：

1. **Token 存储于 localStorage（P3 建议）**：存在 XSS 场景下令牌被读取的理论风险；当前项目无 v-html、Vue 默认转义、依赖无已知 XSS 漏洞，风险受控。若需进一步加固，建议改为 HttpOnly + SameSite=Strict Cookie 传输。
2. **登出/改密为"全端失效"策略（设计取舍）**：token_version 递增会同时踢出同一账号在其他设备的会话，属安全优先取舍，已在代码注释中说明；如需多设备并存，应引入 jti + 服务端会话表实现精细化撤销。
3. **refresh token 未旋转**：有效期内（7 天）同一 refreshToken 可多次换新；登出/改密/角色变更（token_version 机制）均会使其失效。建议后续增加 refresh 轮换 + 重用检测（记录最近一次有效 refresh jti）。
4. **未部署 HTTPS**：本地局域网部署场景未启用 TLS；生产环境必须配置 HTTPS 并开启 HSTS，同时将 CORS_ORIGIN 调整为实际生产域名。
5. **账号锁定可被滥用为针对特定账号的 DoS**：攻击者可故意输错 5 次密码锁定他人账号（每次 15 分钟），管理员可解锁，属可接受的权衡；如需缓解可叠加"IP 维度错误次数限制"。
6. **限流计数器为单实例内存实现**：多实例/集群部署时需切换共享存储（如 Redis store），否则限流阈值按实例数成倍放大。
7. **审计日志建议增加防篡改存储**：当前 audit_logs 与业务库同文件，具备数据库写权限的内部人员可篡改日志；合规要求高的场景建议旁路写入独立存储并周期校验哈希链。
8. **依赖审计需在官方 registry 下执行**：默认 npmmirror 镜像不含 audit 端点，CI 中建议固定 `pnpm audit --registry=https://registry.npmjs.org/` 或接入 Dependabot/Renovate 持续监控。

---

# 第二轮全面检测报告（2026-09-24）

| 项目 | 内容 |
| --- | --- |
| 测试对象 | ERP 商品管理系统全栈（backend: Express + better-sqlite3 @3001；frontend: Vue3 + TS + Element Plus） |
| 测试日期 | 2026-09-24 |
| 测试性质 | 授权安全测试（项目属用户本人），重点覆盖第一轮修复后的新增变更 + 全量复检 |
| 测试人 | 渗透测试工程师 |
| 结论 | 第一轮 8 项修复全部复测有效；新变更审计未引入高危漏洞；新发现漏洞 **1** 个（R2-VULN-01，P3），**已修复并复测通过**；功能验证 36/36 通过 |

## R2-1. 第一轮修复后新增变更专项审计结论

| 变更项 | 审计结论 |
| --- | --- |
| 采购/商品/供应商详情接口显式 camelCase 别名输出（purchaseOrders / products / suppliers routes 的 GET /:id） | **未引入漏洞**。三处均以显式字段列表替代 `SELECT *`，逐字段核对输出集合：不含 password_hash/token_version 等任何敏感内部字段；采购详情暴露 supplierId/unitPrice 属 PRD 2.2 权限矩阵设计（"采购管理-查看列表/详情"对全部角色开放，viewer 可见进价为既有产品决策，非越权）；动态实测 viewer 读取采购详情仅返回契约内字段，无 snake_case 内部字段外漏 |
| 前端路由守卫 meta.permission 细粒度拦截（router/index.ts）+ PurchaseOrderFormView 表单页二次拦截 | **未引入漏洞，且属纵深防御正确实践**。逐接口核对后端 RBAC：purchase:write/purchase:receive/inventory:write/product:write/supplier:write/category:write 全部写接口在 backend 均有 `rbac()` 兜底，前端 `can()` 权限矩阵与 PRD 2.2 一致；动态实测 viewer 直接调用全部写接口返回 403，前端守卫被绕过（伪造 localStorage 角色信息）不影响任何受保护资源。守卫逻辑本身仅做 UX 重定向，无安全决策依赖客户端数据 |
| UsersView.vue 补 import EmptyState 等修改 | **未引入漏洞**。列表数据仍经 admin-only 后端接口获取，随机密码生成使用随机源、密码不落日志（audit 层有脱敏） |
| 抽屉响应式布局改动 | 纯 CSS/模板层调整，无数据处理逻辑变更，无安全影响 |

## R2-2. 新发现漏洞清单

### R2-VULN-01（P3）采购单多行明细聚合可绕过金额上限，总金额精度溢出

- **位置**：[purchaseOrders.routes.js 创建/编辑/提交路由](backend/src/routes/purchaseOrders.routes.js)（修复前 L181/L217/L261 附近的总金额计算处）
- **复现步骤**：
  1. 库管创建 91 个商品；采购员创建采购单，91 行明细全部 `quantity=999999, unitPrice=99999999`（单行值均通过 VULN-02 修复后的 zod 上限校验）；
  2. 真实精确总金额应为 **9,099,990,809,000,091 分**；
  3. 修复前实测入库 `total_amount = 9,099,990,809,000,092`（JS `reduce` 累加越过 `Number.MAX_SAFE_INTEGER` ≈ 9.007e15，IEEE754 舍入产生偏差），且数据库列声明 INTEGER 但实际写入值已为失真结果。
- **根因**：VULN-02 的修复只约束了**单行**字段上限（单行 subtotal 最大 ≈ 1e14 分），未约束**单据级聚合总额**。schema 允许最多 200 行明细，多行累加时 JS number 精度在 2^53 处失效，聚合校验缺口使 VULN-02 的"总额恒在安全整数范围"结论失效。
- **危害**：total_amount 是财务对账核心字段，与 Σ(数量×进价) 不一致破坏数据完整性（本例偏差 +1 分，理论上限 200 行时偏差可达数分至数十余分）；对账、报表、审计金额失真。触发条件极端（需约 91 行满额大值明细），故定级 P3。
- **修复**：新增单据总金额系统上限 `MAX_ORDER_TOTAL = 999999999999` 分（约 99.99 亿元，对中小企业单笔采购足够宽松），并在**创建、编辑草稿、提交（防御性二次校验）**三处对聚合总额执行校验，超限返回 400。该上限内所有累加部分和 < 2^53，JS 整数运算全程精确，精度偏差在数学上不可能发生。
- **复测**：91 行满额单据 → 400 拒绝；单行 subtotal 1e14 分（> 上限）→ 400 拒绝；正常单据（2 × 15000）创建成功且 totalAmount=30000 精确；`node scripts/verify.mjs` 36/36 通过。

## R2-3. 第一轮已修复项复测（全部有效）

| 编号 | 复测方式 | 结果 |
| --- | --- | --- |
| VULN-01 登出令牌失效 | viewer01 登出后旧 access 调 /me、旧 refresh 调 /refresh | 均 401，**有效** |
| VULN-02 金额/库存上限 | unitPrice=1e8 → 400；unitPrice=9e15 → 400；quantity=0/-5 → 400；手动调整上/下限逻辑静态确认 | 拦截正常，**有效**（聚合缺口由 R2-VULN-01 补齐） |
| VULN-03 审计 IP 伪造 | 伪造 `X-Forwarded-For: 6.6.6.6` 登录后查审计日志 | 记录真实地址 ::1，**有效** |
| VULN-04 .gitignore | 文件存在且包含 .env / *.db / data / node_modules 规则 | **有效** |
| VULN-05 JWT 密钥熵 | 静态确认为 96 字符高熵随机值（长度 ≥ 32 启动校验在位） | **有效** |
| VULN-06 LIKE 通配符转义 | `keyword=%`、`_`、`\`、`' OR '1'='1` 实测 6 个路由 | 均命中 0 条、正常关键词命中正常，**有效** |
| VULN-07 登录时序侧信道 | 静态确认 DUMMY_BCRYPT_HASH 恒时代价比对在位 | **有效** |
| VULN-08 echarts XSS | `pnpm audit`（官方 registry）frontend 0 漏洞 | **有效** |

## R2-4. 全量复检覆盖项（均未发现新漏洞）

| 检查项 | 验证方式与结果 |
| --- | --- |
| 垂直越权（动态） | viewer 访问 /users、/audit-logs、创建商品/供应商/采购单、库存调整、解锁用户、入库确认 → 全部 403；purchaser 入库确认 → 403 |
| 认证边界（动态） | 无 token 401；篡改签名 401；alg=none 伪造 401；refresh token 冒充 access 401；token_version 校验在位 |
| SQL 注入（动态） | keyword/categoryId/sort/username 注入载荷 9 组：UNION/注释类被 zod 拦截 400，字符串类参数化无注入，无数据泄露 |
| IDOR | 改密/登出仅操作 `req.user.id`（无客户端可控 ID）；业务资源为全局共享设计（PRD S9）；按 ID 查询均校验存在性与软删除 |
| 存储型 XSS | 商品名/备注注入 `<script>`/`<img onerror>` 后接口原样返回文本（JSON 上下文无执行）；前端全项目无 v-html/innerHTML，Vue 文本插值默认转义，无执行出口 |
| 信息泄露 | 非法 JSON → 400 统一文案；异常 ID（abc/1e999/负数）→ 404；未知异常 → 500 统一文案，无堆栈/SQL/路径；用户列表不返回密码哈希；audit detail 含密码类字段自动脱敏 |
| 安全响应头 | helmet 生效：nosniff、X-Frame-Options=SAMEORIGIN、HSTS、Referrer-Policy、COOP/CORP，无 X-Powered-By |
| CORS | 仅放行 CORS_ORIGIN 配置来源（http://localhost:5173），credentials 受控 |
| 业务逻辑 | 数量 0/负 → 400；重复 productId → 400；出库超量 → 400 且无流水；重复入库幂等 400；状态机跳步 → 400；手动调整上限/下限在位 |
| 限流与锁定 | 全局 300/分、登录 10/分/IP（RateLimit 头实测）；5 次错密锁定 15 分钟、管理员解锁（verify.mjs 实测） |
| 依赖安全 | backend + frontend `pnpm audit --registry=https://registry.npmjs.org/` 均 **0 漏洞** |
| 前端 token 存储 | localStorage 存储（第一轮遗留风险条目维持评估）；http.ts 刷新单飞 + 队列重放实现正确，无 token 外泄渠道 |

## R2-5. 复测结果汇总

| 验证项 | 结果 |
| --- | --- |
| 安全载荷最终重放（越权/注入/登出失效/金额上限/LIKE/XFF，在最终代码全新种子库上） | **全部符合预期** |
| 功能回归 `node scripts/verify.mjs`（36 项断言） | **36/36 通过** |
| `pnpm audit`（backend + frontend，官方 registry） | **0 漏洞** |
| 测试数据清理 | 91 个溢出测试商品、2 张测试采购单、1 个 XSS 测试商品已全部删除/软删除；库存流水中 4 条测试调整记录（备注含 "R2" 标识）因流水表只增不删不可移除，数量已完全对冲（SKU-1001 库存复原 45），不影响业务 |
| 数据库状态 | 验证前已备份原库至 `%TEMP%\erp-backup-r2.db`，随后重置为全新种子库（verify.mjs 前置假设）；admin/***REMOVED-SEED-PASSWORD*** 可正常登录（verify 流程内完成首登改密） |

## R2-6. 总体安全结论与遗留建议

**总体结论**：第一轮 8 项修复全部持续有效；第一轮修复后的 4 项新增变更均未引入安全漏洞，其中详情接口的显式字段输出与前端细粒度权限拦截属于安全质量提升；本次全量复检（静态 + 55 组动态攻击载荷）新发现 1 个 P3 完整性缺陷并已修复验证。当前系统在认证、授权、注入防护、XSS 防护、信息泄露、业务逻辑约束、依赖安全各维度均达到 PRD 安全基线要求。

**遗留建议**（在第一轮第 5 章基础上补充/维持）：

1. 维持第一轮全部 8 条遗留建议（token 存储、refresh 轮换、HTTPS、锁定滥用、集群限流、审计日志防篡改等）。
2. **启用 helmet CSP**（新增建议，P3）：当前 `contentSecurityPolicy: false`，建议生产环境启用 CSP（`default-src 'self'` + 按需放开 echarts 所需指令），进一步压缩 XSS 纵深。
3. **单号流水可复用**（新增说明，非漏洞）：草稿采购单删除后其单号流水可被当日后续单据复用（UNIQUE 约束保证唯一性不受影响），如业务要求单号永久不复用，建议改用独立序列表分配流水。
4. **测试/验证数据管理**：verify.mjs 会在库中留下 TEST-001 商品与 1 张已入库单据（属脚本既有行为），建议后续为 verify.mjs 增加独立的测试数据库文件（如 erp-verify.db），实现验证数据与业务数据完全隔离。

---

## 2026-09-24 遗留风险处置（第三轮安全加固）

本轮针对前两轮遗留风险清单中的两项实施修复：**第一轮遗留风险第 1 条（token 存储于 localStorage，P3）** 与 **第二轮遗留建议第 2 条（生产 CSP 未启用，P3）**。

### 一、修复一：token 存储从 localStorage 迁移至 HttpOnly Cookie（消除 XSS 窃取令牌渠道）

**实施方式**：

| 环节 | 实现 |
| --- | --- |
| 下发 | 登录成功后双令牌经 `Set-Cookie` 下发：`erp_access_token`（2h，`Path=/`）、`erp_refresh_token`（7d，**`Path=/api/auth` 收窄**，仅认证接口可携带）；属性 `HttpOnly + SameSite=Lax`，`NODE_ENV=production` 追加 `Secure`；**响应 JSON 不再返回任何 token 明文**（新增 [backend/src/utils/cookies.js](backend/src/utils/cookies.js) 统一管理） |
| 鉴权 | [auth.js](backend/src/middlewares/auth.js) `authenticate` 优先读 Cookie，兼容 `Authorization: Bearer` 头平滑过渡；自实现轻量 Cookie 解析中间件（[cookie.js](backend/src/middlewares/cookie.js)，避免引入 cookie-parser 依赖） |
| 刷新 | `POST /api/auth/refresh` 一律从 HttpOnly Cookie 读 refreshToken 换发新 access（同样写 Cookie），**不再接受 body 传参**；Cookie 缺失/无效统一 401 |
| 登出 | `token_version+1` 全端失效 + `clearCookie` 清除两类 Cookie（maxAge=0 立即过期） |
| CSRF | cookie 方案必配（新增 [csrf.js](backend/src/middlewares/csrf.js)）：① `SameSite=Lax` 第一道防线；② 写操作（POST/PUT/PATCH/DELETE）校验 `Origin/Referer` 与允许源（`CORS_ORIGIN` 白名单或请求自身同源）一致，不一致 403。**取舍说明**：Origin/Referer 均缺失时放行——非浏览器请求无法自动携带受害者 Cookie，不构成 CSRF 场景（业界通行做法，亦保证服务端脚本可直连验证） |
| 前端 | [http.ts](frontend/src/api/http.ts)：`withCredentials: true`，**删除 Authorization 注入与全部 localStorage 存取**；401 时请求 `/api/auth/refresh`（Cookie 自动携带）成功重放原请求，失败清空 Pinia 用户态并跳登录（单飞+队列防并发刷新、排除登录/刷新接口防死循环）；[stores/auth.ts](frontend/src/stores/auth.ts) 仅存非敏感用户态（内存），新增 `restoreSession()` 凭 `/api/auth/me` 恢复会话；路由守卫页面刷新后先恢复会话再放行 |

**验证证据**（全部实测通过）：

- `node scripts/verify.mjs` **36/36 通过**（脚本已更新为 Set-Cookie 提取 + Cookie 头方式，新增"登录 Set-Cookie 含 HttpOnly 双 Cookie 且 JSON 无 token 明文""伪造 Origin 403""登出清除 Cookie 且会话失效"等安全断言）。
- curl 实测：登录响应 `Set-Cookie: erp_access_token=...; HttpOnly; SameSite=Lax; Path=/`、`erp_refresh_token=...; HttpOnly; SameSite=Lax; Path=/api/auth`；响应体仅 `{expiresIn,user}` 无 token 明文；`POST /refresh` 凭 Cookie 返回 200 并换发新 access Cookie、无 Cookie 返回 401；伪造 `Origin: https://evil.attacker.example` 写操作返回 **403 跨站请求被拒绝（CSRF 防护）**；登出响应两类 Cookie `Expires=Thu, 01 Jan 1970`（清除）且旧会话随后 401。
- Playwright（Chromium）实测生产模式：登录可用、`document.cookie` 为空（token 对 JS 不可见）、`localStorage/sessionStorage` 为空、刷新页面会话恢复成功。

### 二、修复二：生产环境启用 CSP + 后端托管前端产物

**实施方式**（[app.js](backend/src/app.js)）：

- `NODE_ENV=production` 时 helmet 启用 `contentSecurityPolicy`（`useDefaults:false`），策略为：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'`。**不放开 `script-src` 的 unsafe-eval/unsafe-inline**；`style-src 'unsafe-inline'` 为 Element Plus/Vue 运行时动态样式注入所需；ECharts 5 默认 Canvas 渲染经实测无需任何额外指令。
- 同步新增生产模式静态托管：`express.static` 指向 `../frontend/dist` + SPA fallback（非 `/api` 的 GET 回 index.html，API 未命中路由仍走 404 兜底），实现单端口同源部署。
- `NODE_ENV != production` 时**不启用 CSP**：Vite dev 的 HMR 依赖 inline script、websocket 与转译期 eval，开启会破坏开发体验（代码注释已说明）。

**验证证据**：

- 生产模式（`NODE_ENV=production`）启动后 curl 实测首页响应头：`Content-Security-Policy: default-src 'self';script-src 'self';style-src 'self' 'unsafe-inline';img-src 'self' data:;font-src 'self' data:;connect-src 'self';object-src 'none';frame-ancestors 'none';base-uri 'self'`；深链接 `/login` 经 SPA fallback 返回 200；`/api/*` 未命中路由不受 SPA 影响。
- Playwright 实测：登录→看板全程无 CSP 违规、无页面脚本错误，ECharts 图表正常渲染（见上方截图证据路径 `%TEMP%\erp-prod-dashboard.png`）。

### 三、剩余风险（如实记录）

1. **多实例部署限制**：登录失败锁定与限流计数器为**单实例内存实现**（登录锁定计数存 SQLite，但限流窗口为内存 Map）；多实例/集群部署需切换共享存储（如 Redis store），否则限流阈值按实例数成倍放大。登出/改密撤销依赖 `token_version` 数据库字段（非内存），多实例下天然一致，无黑名单同步问题。
2. **refresh token 未轮换**：有效期内（7 天）同一 refresh Cookie 可多次换新 access；登出/改密/角色变更（token_version）均使其失效。建议后续增加 refresh 轮换 + 重用检测。
3. **本地环境未部署 HTTPS**：生产模式 Cookie 的 `Secure` 属性仅在真实 HTTPS 部署下完全生效；`http://localhost` 依浏览器 secure-context 规则可正常工作（已实测）。生产部署必须配置 HTTPS 并开启 HSTS。
4. **CSRF Origin 缺失放行取舍**：无 `Origin/Referer` 的写请求（非浏览器工具）被放行；该类请求无法自动携带受害者 Cookie，不构成 CSRF，但若未来引入跨域服务端调用方，应改用显式 CSRF token（synchronizer 模式）或 mTLS。
5. **CSP 无违规上报**：未配置 `report-uri`/`report-to`，CSP 拦截事件不可观测；建议生产接入上报端点持续监控。
6. **测试数据备注**：本轮 verify 在库中留下 TEST-001 商品（软删除约束未删，含 +15 库存与流水）、1 张已入库采购单（PO202609240002）及若干审计/登录日志，属脚本既有行为；验证前原库已备份至 `%TEMP%\erp-backup-r3-20260924` 后重置为全新种子库。

---

# 2026-09-24 第二批遗留风险处置（第四轮安全加固）

本轮针对第三轮剩余风险清单中的两项实施修复：**第 1 条（限流计数器单实例内存实现）** 与 **第 2 条（refresh token 未轮换）**。

## 一、修复一：限流计数器从内存迁移至 SQLite 共享存储

**实施方式**：

| 环节 | 实现 |
| --- | --- |
| 自定义 Store | 新增 [backend/src/utils/sqliteRateLimitStore.js](backend/src/utils/sqliteRateLimitStore.js)：实现 express-rate-limit v7.5 Store 契约（`increment(key) → {totalHits, resetTime}` / `decrement` / `resetKey` / `resetAll` / `get` / `init` / `shutdown`） |
| 原子计数 | `increment` 使用单条 UPSERT（`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`）原子完成"窗口过期清零 + 计数 +1"，SQLite 语句级原子性保证多进程并发计数不丢不乱；命中过期 key 自动清零重开窗口 |
| 键空间隔离 | 独立表 `rate_limit_hits(key PRIMARY KEY, count, reset_at)`，全局限流前缀 `global:`、登录限流前缀 `login:`（每限流器独立 Store 实例，满足 ERR_ERL_STORE_REUSE 约束）；WAL 模式 + `busy_timeout=3000` 缓解多进程写锁竞争 |
| 防表膨胀 | 每 10 分钟定时删除 `reset_at` 过期行（模块级共享定时器）；服务优雅退出（SIGINT/SIGTERM）时 `stopRateLimitCleanup()` 执行 clearInterval |
| 接入范围 | 全局限流（300 次/分/IP）与登录限流（10 次/分/IP）全部切换（[rateLimit.js](backend/src/middlewares/rateLimit.js)）；**查证确认登录失败锁定计数本就存 SQLite**（`users.failed_attempts` 字段，非内存 Map），无需迁移 |
| 范围说明 | 本方案覆盖"**单机多进程**"共享计数；**跨机器多实例**部署需改用 Redis 版 store（rate-limit-redis 等），代码注释与 README 均已注明 |

**验证证据**：

- verify.mjs 断言 44：登录限流打满后返回 429，且以**第二个独立只读连接**直查 `rate_limit_hits` 表可见 `login:` 键计数 ≥10（证明计数落库、可供多进程共享读取）。
- 完整链路 44/44 通过（见汇总）。

## 二、修复二：refresh token 轮换（rotation）+ 重放检测

**实施方式**：

| 环节 | 实现 |
| --- | --- |
| 会话表 | [schema.js](backend/src/db/schema.js) 新增 `refresh_tokens(jti PK, user_id, expires_at, status IN('active','rotated','revoked'), replaced_by, created_at)`，启动幂等建表 + user/expires 索引；新增 [refreshTokenStore.js](backend/src/utils/refreshTokenStore.js) 封装签发/轮换/撤销/查询/过期清理 |
| 签发 | [jwt.js](backend/src/utils/jwt.js) `signRefresh(user, jti)` 在 payload 写入 `crypto.randomUUID()` 生成的 jti；登录时落库 status=active（expires_at 与 JWT exp 同源） |
| 轮换 | `/api/auth/refresh` 校验签名/过期/jti 后：status=active → 旧行置 rotated（记 replaced_by=新 jti），签发全新 jti 的 refresh token + 新 access token，**全部经 Set-Cookie 下发**，滑动续期 7 天 |
| 重放检测 | status=rotated/revoked → 判定令牌重放（可能泄露）：撤销该用户全部 active refresh token + `token_version+1` 全端失效，返回 401，写审计日志 `refresh_replay_detected`（含 user_id/jti/IP），并清除 Cookie |
| 未知 jti | jti 不存在（伪造/历史清理）→ 401；payload 无 jti（历史版本令牌）→ 401 需重新登录 |
| 登出 | 当前 refresh token 的 jti 置 revoked，再走现有 `token_version+1` 全端失效 + 清 Cookie |
| 清理 | 每 10 分钟定时删除 `expires_at` 过期行；rotated/revoked 行保留至过期（重放检测依据），过期后 JWT 亦失效，无安全影响 |
| 前端兼容 | [http.ts](frontend/src/api/http.ts) **无需改动**：/refresh 仍 Cookie 自动携带；核查确认拦截器四重防护（单飞+队列、排除登录/刷新接口、`_retried` 标记、刷新失败直接跳登录）保证轮换撤销导致的 401 直接跳登录、**不会死循环刷新** |

**验证证据**（verify.mjs 断言 37-44，全新种子库实测）：

- 轮换：登录后 `/refresh` 返回 200 且 Set-Cookie 下发**全新 refresh token**（与旧值不同，payload jti 已更换，JSON 无 token 明文）。
- 重放防护：旧 refresh token 二次使用 → **401**；轮换签发的新令牌亦被连带全端撤销（再刷 → 401）。
- 审计：`/api/audit-logs?action=refresh_replay_detected` 可查到记录（含 userId/jti/IP）。
- 伪造：以正确 JWT_SECRET 签名但 jti 不存在的伪造 refresh token → 401。
- 登出：登出后当前 jti 在 `refresh_tokens` 表置 `revoked`（第二只读连接直查确认）。
- curl 实测：登录/刷新响应 `Set-Cookie: erp_refresh_token=...; Max-Age=604800; Path=/api/auth; HttpOnly; SameSite=Lax`，JSON 响应体仅 `{expiresIn}` 无 token 明文；旧令牌重放返回 `{"code":1002,"message":"检测到会话令牌重放，全部会话已失效，请重新登录"}`（401）。

## 三、验证与数据说明

| 验证项 | 结果 |
| --- | --- |
| 功能回归 + 第二批断言 `node scripts/verify.mjs` | **44/44 通过**（原 36 项 + 新增 8 项，含 429/401/审计/直查库断言） |
| backend `pnpm build`（语法检查）/ frontend `pnpm build`（vue-tsc + vite） | **零报错** |
| 后端状态 | 已杀旧进程并以生产模式（NODE_ENV=production，托管 frontend/dist + CSP）重启，保持在线 |
| 测试数据 | 验证前旧库已备份至 `%TEMP%\erp-backup-20260924-batch2.db` 后重置为全新种子库；本轮 verify 留下 TEST-001 商品（+15 库存与流水）、1 张已入库采购单（PO202609240002）与若干审计日志（脚本既有行为）；限流测试用不存在的用户名（无业务数据污染），`rate_limit_hits` 计数 60 秒窗口自动过期并于 10 分钟内被定时任务清除 |

## 四、更新后的剩余风险清单

1. **refresh 轮换多 tab 并发竞态**（已处置，见下方"第五轮安全加固"）：原风险为同一浏览器多标签页同时用同一旧 refresh token 刷新时，后到者命中 rotated 判定为重放 → 该用户全部会话被撤销并跳登录。已通过宽限窗口（grace period）+ 叶子令牌复用修复，verify.mjs 48/48 通过。
2. **跨机器多实例需 Redis**（维持）：限流 SQLite 共享存储覆盖单机多进程；跨机器部署需改用 Redis 版 store（代码注释/README 已注明迁移路径）。登录锁定与 tv/refresh_tokens 本就存库，多实例天然一致。
3. **本地环境未部署 HTTPS**（维持）：生产 Cookie 的 `Secure` 属性需真实 HTTPS 部署完全生效；生产上线必须配置 TLS 并开启 HSTS。
4. **全端失效策略**（维持）：登出/改密/重放撤销均基于 `token_version` 全端失效，会同时踢出同账号其他设备，属安全优先取舍。
5. **轮换后历史令牌一次性失效**（新，兼容性说明）：升级后旧版本签发（无 jti）的 refresh token 一律 401，用户需重新登录（一次性影响，已在 README 注明）。
6. 其余维持第三轮清单第 3~6 条（CSRF Origin 缺失放行取舍、CSP 无违规上报、审计日志防篡改、测试数据管理建议）。

---

# 2026-09-24 遗留风险处置（第五轮安全加固：refresh 轮换宽限窗口）

本轮针对第四轮剩余风险清单**第 1 条"refresh 轮换多 tab 并发竞态"**实施修复：**宽限窗口（grace period）+ 叶子令牌复用**。

## 一、问题回顾

同一浏览器多标签页同时用同一旧 refresh token 调 `/api/auth/refresh` 时，先到者正常轮换（旧 jti 置 rotated），后到者命中 rotated 状态被判定为令牌重放 → 触发全端撤销（全部 refresh token 撤销 + token_version+1）并跳登录。正常用户毫秒级并发即被误伤。

## 二、实施方式

| 环节 | 实现 |
| --- | --- |
| 表结构 | [schema.js](backend/src/db/schema.js)：`refresh_tokens` 新增 `rotated_at INTEGER`（轮换发生时刻，毫秒时间戳；未轮换为 NULL）；建表语句同步更新保证新库直接带列，并做**幂等迁移**（`PRAGMA table_info` 检查列不存在则 `ALTER TABLE ADD COLUMN`，老库启动自动补列，历史 rotated 行 rotated_at 为 NULL 视为不在宽限内按重放处理） |
| 轮换记录 | [refreshTokenStore.js](backend/src/utils/refreshTokenStore.js)：`markRotated()` 写入 `rotated_at=Date.now()`；新增 `findActiveLeafFromChain(jti)` 沿 `replaced_by` 溯源链查找家族当前 status=active 的叶子令牌（校验叶子未过期；深度上限 10 层防环兜底；遇 revoked/断链/超深返回 null） |
| 三段分流 | [auth.routes.js](backend/src/routes/auth.routes.js) `/api/auth/refresh` 命中非 active 状态时：**a) 宽限窗口内**（`now - rotated_at <= GRACE_PERIOD_MS`，默认 30000ms，环境变量 `REFRESH_GRACE_PERIOD_SECONDS` 读取，设 0 关闭宽限回到严格模式）视为并发竞态——沿链找到 active 叶子后以其所属用户信息换发新 **access cookie**（叶子不轮换、不重发 refresh cookie、宽限窗口以原 rotated_at 为准**不重置**，即复用叶子），返回 200，写审计 `refresh_grace_reuse`（含 user_id/jti/IP/leafJti）；链上无可用 active 叶子（已被撤销/过期）则按重放处理；**b) 超过宽限窗口**：维持重放防护；**c) revoked 状态**：无宽限，直接重放防护（登出/被撤销令牌复用是明确攻击信号） |
| 安全边界 | 宽限放行前执行与 active 路径一致的用户校验（存在、未软删除、启用、`token_version` 与旧令牌 payload 一致）——改密/全端失效后旧令牌即使在宽限内也不放行（普通 401，不触发全端撤销）；宽限内复用不延长窗口（不刷新 rotated_at），窗口默认 30 秒远小于 refresh 7 天有效期，每次复用均留审计痕迹，风险可控 |

## 三、验证证据（全部实测通过）

| 验证项 | 结果 |
| --- | --- |
| 功能回归 + 新增断言 `node scripts/verify.mjs` | **48/48 通过**（原 44 项保留 + 新增 4 项断言 44-47：并发竞态宽限 / 宽限命中审计 / 宽限过期重放 / revoked 无宽限；原限流断言顺延为第 48 项，逻辑不变） |
| 短宽限期测试配置 | 后端以 `NODE_ENV=production REFRESH_GRACE_PERIOD_SECONDS=3` 启动、`VERIFY_GRACE_SECONDS=3` 跑 verify → **48/48 通过**（宽限过期等待仅 4 秒） |
| 生产默认配置 | 后端以默认配置（宽限 30 秒）重启后复跑 verify → **48/48 通过**（两次 31 秒宽限过期等待） |
| 新增断言内容 | 44: 宽限窗口内同一旧 token 二次 /refresh 返回 200、不触发全端撤销（新 access 调 /me 仍 200、叶子令牌直查 SQLite 仍 active、不重发 refresh cookie）；45: `/api/audit-logs?action=refresh_grace_reuse` 可查到记录（含 user_id/jti/IP）；46: 等待超过宽限期后旧 token 再刷 → 401 + 审计 `refresh_replay_detected` + 叶子被全端撤销置 revoked；47: 登出后旧 refresh token 再刷 → 401（不进宽限逻辑，直接重放防护） |
| 老库幂等迁移 | 以升级前旧 schema 备份库实测：启动前列无 `rotated_at` → 首次启动自动 `ALTER TABLE` 补列（列出现、服务正常）→ 二次启动幂等跳过不报错 |
| curl 实测（生产默认 30 秒宽限） | 登录 200 → `/refresh` 轮换 200（Set-Cookie 换发全新 refresh）→ **旧 token 立即再刷（宽限内）返回 200** 且仅换发 access cookie（无 refresh cookie）→ 以宽限换发的 access 调 `/api/auth/me` 与 `/api/products` 均 200（会话仍可用）→ 伪造 `Origin: https://evil.attacker.example` 写操作仍 403（既有 CSRF 防护不受影响）。证据：`%TEMP%\grace-curl-evidence.txt` |
| 构建 | backend `pnpm build`（全量 JS 语法检查）/ frontend `pnpm build`（vue-tsc + vite build）**零报错** |
| 后端状态 | 已重启为生产模式（NODE_ENV=production，宽限默认 30 秒生效），3001 端口保持在线 |

## 四、残余风险（如实记录）

1. **宽限窗口内旧令牌可复用（安全取舍）**：窗口默认 30 秒内，持有已轮换旧 refresh token 者可换取与合法用户同源的 access 会话（不获得新 refresh token、叶子不轮换）。攻击者需在轮换后 30 秒内窃取并复用旧令牌，且每次复用留审计 `refresh_grace_reuse` 可监测；设置 `REFRESH_GRACE_PERIOD_SECONDS=0` 可随时关闭宽限回到严格模式。属"可用性换安全性"的显式取舍。
2. **叶子复用说明**：宽限复用返回的 access token 由叶子令牌所属用户的当前会话信息签发（含当前 token_version）；叶子本身不轮换，故多 tab 竞态场景下同一叶子可能被多次复用（均留审计），叶子到期或被撤销后宽限链路自动失效并回落到重放防护。
3. **历史 rotated 行 rotated_at 为 NULL**：升级前产生的已轮换行不在宽限范围内（按重放防护处置，安全优先）；仅影响升级瞬间正在进行的毫秒级并发刷新，属一次性边界。
4. 其余维持第四轮清单第 2~6 条（跨机器多实例需 Redis、本地未部署 HTTPS、全端失效策略、历史令牌一次性失效、CSRF/CSP/审计日志/测试数据管理等）。
