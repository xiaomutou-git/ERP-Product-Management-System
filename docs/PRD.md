# ERP商品管理系统 产品需求文档（PRD）

| 项目 | 内容 |
| --- | --- |
| 文档名称 | ERP商品管理系统产品需求文档 |
| 版本号 | v1.0 |
| 编写日期 | 2026-09-21 |
| 文档状态 | 已评审定稿（供开发实施） |
| 目标读者 | 全栈工程师、渗透测试工程师、验收用户 |
| 技术栈 | 前端 Vue3 + TypeScript + Vite（包管理器 pnpm）；后端 Node.js (Express) + SQLite |
| 部署形态 | 单机部署，前后端分离，后端默认端口 3000，前端构建产物可由后端静态托管 |

---

## 1. 项目概述

### 1.1 项目背景

中小企业在日常经营中普遍存在商品信息散落在 Excel、采购记录依赖口头传递、库存数据滞后失真等问题，导致重复采购、缺货断货、账实不符。本系统旨在提供一套零成本、易部署、单机可运行的商品管理方案，覆盖商品、供应商、采购、库存四个核心业务环节，并提供数据看板辅助经营决策。

### 1.2 项目目标

| 编号 | 目标 | 衡量方式 |
| --- | --- | --- |
| G1 | 商品信息集中数字化管理，SKU 全局唯一 | 系统内不存在重复 SKU；商品增删改查全部在系统内完成 |
| G2 | 采购流程线上化，入库自动记账 | 采购单状态流转闭环；入库后库存数值自动增加且产生流水 |
| G3 | 库存可预警 | 库存低于阈值的商品可一键筛出，看板实时展示低库存数量 |
| G4 | 操作可追溯 | 关键操作 100% 记录审计日志，可按人、按模块查询 |
| G5 | 零成本部署 | 全套依赖均为开源免费方案，单台 Windows/Linux 主机可部署，无需外部云服务 |

### 1.3 项目价值

- **降本**：SQLite 单文件数据库，无需购买数据库服务；全栈单语言（Node.js）降低维护门槛。
- **提效**：采购-入库-库存联动，消除人工二次录入。
- **可控**：角色权限隔离 + 审计日志，满足中小企业内部风控基本要求。
- **可演进**：数据模型预留扩展空间，后续可平滑迁移至 PostgreSQL/MySQL。

### 1.4 范围界定（本期不做）

- 不做多租户、多仓库（仅单仓维度）、多币种。
- 不做销售管理、财务对账、条码打印、移动端原生 App。
- 不做消息推送（如邮件/短信通知），低库存仅页面内提示。
- 不做数据备份自动化界面，备份依赖 SQLite 文件复制（运维手册另行说明）。

---

## 2. 用户角色与权限

### 2.1 角色定义

| 角色 | 角色编码 | 职责描述 | 典型人数 |
| --- | --- | --- | --- |
| 系统管理员 | `admin` | 系统最高权限：管理用户账号、分配角色、查看审计日志、可执行全部业务操作 | 1~2 |
| 采购员 | `purchaser` | 维护供应商资料、创建/提交采购单、查看商品与库存（只读库存） | 若干 |
| 库存管理员 | `stockkeeper` | 维护商品与分类、执行采购单入库确认、执行手动出入库调整、维护库存预警阈值 | 若干 |
| 普通查看员 | `viewer` | 仅查看商品、库存、看板数据，无任何写操作 | 若干 |

### 2.2 权限矩阵

说明：`✓` 允许，`✗` 禁止。该矩阵同时是后端接口鉴权中间件的实现依据（见第 6 章）。

| 功能模块 | 操作 | admin | purchaser | stockkeeper | viewer |
| --- | --- | :-: | :-: | :-: | :-: |
| 登录/修改本人密码 | 登录、登出、改密、获取个人信息 | ✓ | ✓ | ✓ | ✓ |
| 数据看板 | 查看统计数据 | ✓ | ✓ | ✓ | ✓ |
| 商品分类 | 查看 | ✓ | ✓ | ✓ | ✓ |
| 商品分类 | 新增/修改/删除 | ✓ | ✗ | ✓ | ✗ |
| 商品管理 | 查看列表/详情/搜索 | ✓ | ✓ | ✓ | ✓ |
| 商品管理 | 新增/修改/删除 | ✓ | ✗ | ✓ | ✗ |
| 供应商管理 | 查看列表/详情 | ✓ | ✓ | ✓ | ✓ |
| 供应商管理 | 新增/修改/启停/删除 | ✓ | ✓ | ✗ | ✗ |
| 采购管理 | 查看采购单列表/详情 | ✓ | ✓ | ✓ | ✓ |
| 采购管理 | 创建/编辑/删除草稿采购单 | ✓ | ✓ | ✗ | ✗ |
| 采购管理 | 提交采购单（草稿→已提交） | ✓ | ✓ | ✗ | ✗ |
| 采购管理 | 入库确认（已提交→已入库） | ✓ | ✗ | ✓ | ✗ |
| 采购管理 | 取消采购单 | ✓ | ✓ | ✗ | ✗ |
| 库存管理 | 查看库存列表/流水 | ✓ | ✓ | ✓ | ✓ |
| 库存管理 | 修改预警阈值 | ✓ | ✗ | ✓ | ✗ |
| 库存管理 | 手动入库/出库调整 | ✓ | ✗ | ✓ | ✗ |
| 用户管理 | 用户增删改查、角色分配、重置密码、启用停用 | ✓ | ✗ | ✗ | ✗ |
| 审计日志 | 查看/筛选/导出 | ✓ | ✗ | ✗ | ✗ |

### 2.3 账号规则

1. 系统初始化时自动创建默认管理员账号：用户名 `admin`，初始密码 `***REMOVED-SEED-PASSWORD***`，**首次登录强制修改密码**（修改前除改密/登出外所有接口返回 403）。
2. 用户名规则：3~20 位，仅允许字母、数字、下划线，全局唯一。
3. 密码规则：8~32 位，必须同时包含字母和数字；使用 bcrypt（cost=10）哈希存储，禁止明文或可逆加密。
4. 用户状态：`启用/停用`，停用用户登录时返回明确错误提示。
5. 用户删除采用软删除（逻辑删除），已产生业务数据的账号不允许物理删除。

---

## 3. 功能需求

优先级定义：P0 = 首版必须，P1 = 首版应有，P2 = 可延期。

### FR-01 登录认证（P0）

**描述**：用户通过用户名 + 密码登录系统，服务端校验通过后签发 JWT（access token + refresh token 双令牌）。前端将 token 存储于内存/localStorage，请求时通过 `Authorization: Bearer <token>` 头携带。

**核心规则**：

1. access token 有效期 2 小时，refresh token 有效期 7 天，均使用 HS256 签名，密钥来自环境变量 `JWT_SECRET`（长度 ≥ 32 字符，未配置则服务启动失败并给出明确报错）。
2. 登录失败锁定策略：同一账号**连续 5 次**密码错误，锁定该账号 **15 分钟**；锁定期内即使密码正确也返回统一错误提示（不泄露锁定状态与普通密码错误的区别，防止账号枚举探测）；锁定到期自动解锁，或由管理员在用户管理中手动解锁。连续失败计数在登录成功后清零。
3. 登录接口启用限流：同一 IP 每分钟最多 10 次请求，超出返回 429。
4. access token 过期后，前端调用刷新接口换取新 access token；refresh token 过期则跳转登录页。
5. 修改密码成功后，强制使该用户所有已签发 token 失效（服务端维护每用户的 token 版本号 `token_version`，JWT payload 携带版本号，校验时不匹配即拒绝）。

**验收标准**：

- [ ] 正确账号密码登录成功，响应时间 P95 ≤ 500ms，返回双 token 及用户信息（不含密码哈希）。
- [ ] 错误密码连续尝试第 5 次后，第 6 次请求（即使密码正确）返回 HTTP 423/400 与"账号已锁定，请 15 分钟后重试"提示。
- [ ] 锁定 15 分钟后可正常登录。
- [ ] access token 过期后调用受保护接口返回 401；使用 refresh token 可换取新 access token。
- [ ] 用户 A 修改密码后，其先前获取的旧 access token 在下一次请求时返回 401。
- [ ] 未携带 token / 携带伪造 token 访问任何受保护接口均返回 401。

### FR-02 商品管理（P0）

**描述**：维护商品主数据，支持新增、编辑、软删除、详情查看、按名称/SKU 模糊搜索、分页列表。

**核心规则**：

1. 商品必填字段：名称（1~100 字符）、SKU 编码（1~50 字符）、分类、单位；选填字段：规格、条形码、售价（分）、备注。
2. SKU 全局唯一：创建与编辑时服务端做唯一性校验（含已软删除记录，防止 SKU 复用导致历史流水歧义），重复时返回 409 与明确提示"SKU 已存在"。
3. 商品名称支持模糊搜索：`LIKE %关键词%`，关键词与 SKU 字段做 OR 匹配；搜索关键词必须参数化查询，防 SQL 注入。
4. 分页：默认每页 20 条，可选 10/20/50/100，返回总数、总页数、当前页数据；支持按创建时间倒序/正序排列。
5. 软删除约束：**已有库存（库存数量 > 0）的商品不允许删除**；已被采购单明细引用的商品允许软删除（历史采购单仍可查看商品快照信息），删除后不再出现在新建采购单的可选列表中。
6. 商品分类：分类名称唯一（同级内唯一），最多两级；**分类下存在商品时不允许删除该分类**，需先移除或转移商品。

**验收标准**：

- [ ] 创建 SKU 为 `TEST-001` 的商品后再创建同 SKU 商品，返回 409，页面提示"SKU 已存在"。
- [ ] 以"测试"为关键词搜索，所有名称或 SKU 含"测试"的商品按创建时间倒序返回，分页总数正确。
- [ ] 将某商品库存调整为 5 后尝试删除，返回 400，提示"该商品存在库存，无法删除"。
- [ ] 分类"电子产品"下有商品时删除该分类，返回 400 并提示。
- [ ] 在商品名称中输入 `' OR 1=1 --` 等注入串，接口正常返回空/按字面量匹配的结果，无数据库错误。
- [ ] 一次性导入/创建 10000 条商品后，分页查询响应时间 P95 ≤ 800ms。

### FR-03 供应商管理（P0）

**描述**：维护供应商档案，支持 CRUD、状态启停（合作中/已停用）。

**核心规则**：

1. 供应商必填字段：名称（1~100 字符，全局唯一）；选填字段：联系人、电话（11 位手机号或带区号座机，正则校验）、邮箱（格式校验）、地址、备注。
2. 状态：`enabled`（合作中）/ `disabled`（已停用）。已停用供应商不可被新采购单选择，但历史采购单展示不受影响。
3. 删除约束：**已被任何采购单引用的供应商不允许删除**（返回 400 并提示），无引用的供应商可物理删除。

**验收标准**：

- [ ] 创建重名供应商返回 409。
- [ ] 电话输入 `abc` 返回 400，字段级错误提示"电话格式不正确"。
- [ ] 将供应商 A 设为"已停用"后，新建采购单的供应商下拉列表中不出现 A。
- [ ] 删除已有采购记录的供应商 B，返回 400；删除无引用的供应商 C 成功。

### FR-04 采购管理（P0）

**描述**：采购单全流程管理，包含创建（选供应商 + 添加商品明细：数量 + 进价）、编辑、提交、入库确认、取消。采购单状态机：`draft（草稿）→ submitted（已提交）→ received（已入库）`，任意状态可流转至 `cancelled（已取消）`（仅草稿/已提交可取消）。

**核心规则**：

1. 采购单字段：单号（系统自动生成，规则 `PO+yyyyMMdd+4 位流水`，如 `PO202609210001`，全局唯一）、供应商、状态、备注、创建人、提交时间、入库时间、总金额（自动汇总）。
2. 明细字段：商品、数量（正整数，1~999999）、进价（以"分"为单位的正整数）。同一单内不允许出现重复商品，可编辑修改。
3. 状态流转规则：
   - 草稿：采购员可编辑明细、删除整单。
   - 提交：草稿→已提交，提交后**明细锁定不可修改**，仅可取消。
   - 入库确认：已提交→已入库，仅库存管理员/系统管理员可操作；**入库时系统在同一数据库事务内：按明细逐条增加对应商品库存、写入库存流水（类型=采购入库，关联采购单号）、更新采购单状态与入库时间**。任一步失败则整体回滚。
   - 已入库状态为终态，**不允许回退**；入库发现数量差异通过库存管理的手动调整功能冲正，并留下流水。
4. 进价快照：明细中的进价为下单时价格，后续商品售价/成本调整不影响历史采购单金额。
5. 列表支持按单号/供应商名称模糊搜索、按状态筛选、按创建时间区间筛选、分页。

**验收标准**：

- [ ] 创建含 3 条明细的采购单，总金额 = Σ(数量×进价)，与手工计算一致。
- [ ] 提交后编辑接口返回 400，提示"已提交的采购单不可编辑"。
- [ ] 采购员对已提交采购单点击"入库确认"返回 403；库存管理员操作成功。
- [ ] 入库前商品 X 库存为 10，采购单含 X×5，入库后库存变为 15，且库存流水新增一条类型为"采购入库"、数量 +5 的记录。
- [ ] 对已入库采购单执行任何状态变更接口返回 400。
- [ ] 并发两次入库请求同一采购单，仅一次成功，另一次返回 400"单据状态已变更"，库存最终只加一次（幂等校验）。

### FR-05 库存管理（P0）

**描述**：查看实时库存、维护低库存预警阈值、筛选低库存商品、执行手动出入库调整并留存流水。

**核心规则**：

1. 每个商品一条库存记录（含：当前数量、预警阈值）。商品创建时默认库存 0、默认阈值 10（可在创建商品时指定）。
2. 低库存判定：`当前数量 ≤ 预警阈值` 即为低库存；阈值为 0~999999 的非负整数。
3. 手动调整：类型为"手动入库"（数量增加）或"手动出库"（数量减少），必填调整原因（1~200 字符）；**出库时若调整后库存 < 0，拒绝操作**，返回 400"库存不足"。调整在事务内完成：更新库存 + 写入流水。
4. 库存流水记录：时间、商品、类型（采购入库/手动入库/手动出库）、变动数量（正数）、变动方向、变动前数量、变动后数量、关联单号（采购入库时为采购单号）、操作人、原因备注。流水**只增不改不删**。
5. 库存列表支持：模糊搜索商品、仅看低库存（开关）、按分类筛选、分页；低库存行以警告色（琥珀色 #F59E0B 文字/角标）高亮标识。

**验收标准**：

- [ ] 商品库存 3、阈值 5，列表"仅看低库存"筛选可查到该商品，且带低库存标识。
- [ ] 对库存为 2 的商品执行手动出库 5，返回 400"库存不足"，库存数值不变，无流水产生。
- [ ] 执行手动入库 10（原因"盘点补录"），库存 +10，流水记录含操作人、前后数量（2→12）、原因。
- [ ] 库存流水列表按时间倒序展示，支持按商品/类型筛选；无任何编辑、删除流水的入口与接口。
- [ ] 修改阈值为 1 后，该商品不再出现在低库存筛选结果中。

### FR-06 数据看板（P0）

**描述**：登录后默认页，展示 4 个统计卡片与 1 张趋势图。

**核心规则**：

1. 统计卡片：① 商品总数（未软删除）；② 库存总量（所有未删除商品的库存数量之和）；③ 低库存商品数（当前数量 ≤ 阈值的商品数）；④ 近 7 日采购金额（元）。
2. 近 7 日采购金额趋势：按采购单**入库时间**统计最近 7 天（含当日）每日"已入库"采购单金额合计，前端以柱状图/折线图呈现（使用 ECharts），横轴为日期（MM-DD），纵轴为金额（元），金额=Σ明细(数量×进价)/100 换算为元，保留 2 位小数；无数据的日期补 0。
3. 低库存卡片可点击跳转至库存页并自动应用"仅看低库存"筛选。

**验收标准**：

- [ ] 造数：商品 12 个（其中 2 个低库存）、库存合计 500、近 7 日入库采购单金额合计 10000.00 元，看板显示 12 / 500 / 2 / 10000.00，误差为 0。
- [ ] 某天无入库记录，趋势图该日显示 0 而非缺失。
- [ ] 点击低库存卡片跳转库存页，"仅看低库存"开关为开启状态。
- [ ] 统计接口在 1 万商品、5 万条流水数据量下响应 P95 ≤ 800ms。

### FR-07 用户管理（P0，仅管理员）

**描述**：管理员维护系统账号：新增（用户名/初始密码/角色/姓名）、编辑（姓名/角色/状态）、重置密码、启用/停用、解锁登录锁定。

**核心规则**：

1. 一个用户一个角色（本期不做多角色叠加）。
2. 不允许停用/删除自己；系统中必须至少保留 1 个启用的 admin 账号（删除/停用最后一个启用管理员时返回 400）。
3. 重置密码由管理员设置新密码，用户下次登录后仍强制走改密流程。
4. 列表支持按用户名/姓名搜索、按角色筛选、分页。

**验收标准**：

- [ ] 新建用户 `purchaser01`（角色 purchaser）后，该用户可登录且仅能执行采购员权限操作。
- [ ] 管理员尝试停用自己，返回 400。
- [ ] 将唯一启用的 admin 停用，返回 400"系统至少需保留一个启用的管理员"。
- [ ] 重置密码后用旧密码登录失败、新密码登录成功且被要求修改密码。

### FR-08 审计日志（P0，仅管理员）

**描述**：自动记录关键操作，供管理员追溯。

**核心规则**：

1. 记录范围：登录成功/失败（失败含用户名与原因）、登出、商品/分类/供应商/采购单/用户/库存调整的全部写操作（含失败的业务拒绝，标注失败原因）、密码修改、重置密码。
2. 字段：时间、操作人用户名、操作类型、模块、目标对象（如商品 SKU/采购单号）、详情（JSON 摘要，密码字段一律脱敏为 `******`）、客户端 IP、User-Agent。
3. 日志只增不改不删；列表按时间倒序，支持按操作人、模块、时间区间筛选，分页每页最大 100。
4. 日志写入失败不得阻断业务主流程（异步/兜底记录，错误仅写入服务端日志）。

**验收标准**：

- [ ] 执行一次商品新增、一次采购入库，审计日志各新增一条，字段完整。
- [ ] 审计日志详情中不出现任何明文密码或 token。
- [ ] 按操作人+时间区间筛选结果准确；无删除日志的页面按钮与 API。

### FR-09 多设备自适应（P0）

**描述**：界面桌面优先设计，兼容平板与手机浏览。

**核心规则**：

1. 断点：≥1280px 桌面完整布局（左侧固定导航）；768~1279px 平板（导航可折叠）；<768px 手机（导航抽屉式，表格横向滚动，表单单列布局）。
2. 禁止纯白刺眼背景：全局底色采用浅灰蓝 `#F1F5F9`，内容卡片底色 `#FFFFFF` 仅用于卡片层且配合边框/阴影柔化。
3. 禁止过度装饰性动画：仅允许 ≤200ms 的过渡（hover、抽屉滑出、页面切换淡入），禁止粒子、视差滚动、无限循环动画。

**验收标准**：

- [ ] 在 1366×768、1024×768、375×667 三种分辨率下，核心页面（登录/看板/商品/采购/库存）无布局错乱、无横向溢出（数据表格除外，允许表格容器内滚动）。
- [ ] 全局不出现大面积纯白（#FFFFFF 占比超过首屏 70%）背景。
- [ ] 无任何超过 200ms 的装饰性动画。

---

## 4. 非功能需求

### 4.1 性能指标

| 指标 | 要求 | 测量方式 |
| --- | --- | --- |
| 页面首屏加载（生产构建，局域网） | ≤ 2s（FCP） | 浏览器 Performance 面板 |
| 常规接口响应（列表/详情） | P95 ≤ 500ms | 压测工具（如 autocannon）50 并发 |
| 看板统计接口 | P95 ≤ 800ms（万级数据） | 同上 |
| 数据容量支撑 | 商品 ≥ 1 万条、流水 ≥ 5 万条时功能与性能不劣化 | 造数脚本验证 |
| 前端打包产物 | 单 JS chunk gzip ≤ 1MB（路由懒加载拆分） | 构建产物分析 |

### 4.2 安全要求基线（渗透测试重点核查项）

| 编号 | 要求 |
| --- | --- |
| S1 | 密码 bcrypt（cost ≥ 10）存储；任何接口/日志不得返回密码哈希或明文 |
| S2 | JWT：HS256、强密钥（≥32 字符环境变量注入）、双 token 过期策略、改密后全端失效 |
| S3 | SQL 注入防护：全部数据库操作使用参数化查询（如 better-sqlite3 占位符），禁止字符串拼接 SQL |
| S4 | XSS 防护：前端使用 Vue 模板默认转义，禁止 `v-html` 渲染用户输入；后端响应头含 `X-Content-Type-Options: nosniff` |
| S5 | 输入校验：后端所有接口使用 schema 校验库（如 zod/joi）校验参数类型/长度/范围，非法输入返回 400 与字段级错误 |
| S6 | 鉴权：除 `/api/auth/login`、`/api/auth/refresh`、健康检查外，全部接口强制 JWT 中间件校验；接口内按 2.2 权限矩阵做角色校验，未授权返回 403 |
| S7 | 限流：登录接口 10 次/分钟/IP，全局 300 次/分钟/IP，超限返回 429 |
| S8 | 安全响应头：使用 helmet 或等效配置（含 `X-Frame-Options: DENY`、HSTS 可选） |
| S9 | 水平越权防护：所有"按 ID 操作"接口必须校验资源存在性；本系统数据为全局共享（非租户隔离），重点校验角色越权（垂直越权），如采购员调用入库接口必须被 403 拒绝 |
| S10 | 错误信息：对外错误不泄露堆栈、SQL、文件路径；服务端完整记录错误日志 |
| S11 | CORS：仅允许配置的前端来源（生产环境禁用 `*`） |
| S12 | 依赖安全：交付前 `pnpm audit` 高危漏洞数为 0（或有书面豁免说明） |

### 4.3 浏览器兼容

| 浏览器 | 版本要求 |
| --- | --- |
| Chrome / Edge | 最近两个大版本 |
| Firefox | 最新 ESR |
| Safari | 15+ |

### 4.4 工程规范

1. 前端：Vue3 `<script setup>` + TypeScript 严格模式；包管理器统一 pnpm（锁定 `pnpm-lock.yaml`）；状态管理 Pinia；路由 vue-router（history 模式）；组件库可用 Element Plus（主题色覆写为 #06B6D4 系）。
2. 后端：Express + better-sqlite3；分层结构 `routes / controllers / services / middlewares / db`；统一响应格式与错误码。
3. **代码注释规范**：全部源码（前端/后端）包含完整注释——类/组件级注释（说明职责与设计思路）、函数级注释（说明功能与执行逻辑）、参数注释（名称/类型/含义/取值范围/默认值）、返回值注释（类型与含义）、异常注释（可能抛出的异常类型、触发条件、处理方式）。
4. 统一响应格式：

```json
{ "code": 0, "message": "ok", "data": { } }
```

非 0 的 `code` 为业务错误码，与 HTTP 状态码配合使用（错误码表见附录 A）。

### 4.5 配色与视觉基调（UI 设计约束）

| 用途 | 色值 |
| --- | --- |
| 主色（按钮、链接、选中态） | `#06B6D4` |
| 悬停色 | `#0891B2` |
| 聚焦/激活色 | `#0E7490` |
| 全局页面底色 | `#F1F5F9`（禁止纯白大面积背景） |
| 危险操作 | `#EF4444` |
| 低库存警告 | `#F59E0B` |
| 成功状态 | `#10B981` |

---

## 5. 数据模型设计

通用约定：SQLite；主键 `id` 为 INTEGER 自增；时间字段一律 TEXT 存 ISO8601 UTC 字符串（如 `2026-09-21T08:30:00.000Z`）；**金额字段以"分"为单位存储为 INTEGER**；软删除使用 `deleted_at`（NULL 表示未删除）。

### 5.1 users（用户表）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK 自增 | 用户 ID |
| username | TEXT | NOT NULL UNIQUE | 用户名，3~20 位字母/数字/下划线 |
| password_hash | TEXT | NOT NULL | bcrypt 哈希 |
| real_name | TEXT | NOT NULL | 姓名，1~20 字符 |
| role_id | INTEGER | NOT NULL FK→roles.id | 角色 |
| status | INTEGER | NOT NULL DEFAULT 1 | 1=启用 0=停用 |
| token_version | INTEGER | NOT NULL DEFAULT 0 | token 版本号，改密时 +1 |
| must_change_password | INTEGER | NOT NULL DEFAULT 0 | 1=下次登录强制改密 |
| locked_until | TEXT | NULL | 登录锁定截止时间（NULL 未锁定） |
| failed_attempts | INTEGER | NOT NULL DEFAULT 0 | 连续登录失败次数 |
| created_at | TEXT | NOT NULL | 创建时间 |
| updated_at | TEXT | NOT NULL | 更新时间 |
| deleted_at | TEXT | NULL | 软删除时间 |

### 5.2 roles（角色表）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK 自增 | 角色 ID |
| code | TEXT | NOT NULL UNIQUE | 编码：admin/purchaser/stockkeeper/viewer |
| name | TEXT | NOT NULL | 显示名：系统管理员/采购员/库存管理员/普通查看员 |
| description | TEXT | NULL | 描述 |

预置 4 行，本期不做角色动态配置（权限在代码中按 role code 判定）。

### 5.3 categories（商品分类表）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK 自增 | 分类 ID |
| name | TEXT | NOT NULL | 名称 1~50 字符 |
| parent_id | INTEGER | NULL FK→categories.id | 父分类 ID，NULL=一级分类，最多两级 |
| created_at | TEXT | NOT NULL | 创建时间 |
| deleted_at | TEXT | NULL | 软删除时间 |

唯一约束：`(name, parent_id)`（同级名称唯一）。

### 5.4 products（商品表）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK 自增 | 商品 ID |
| name | TEXT | NOT NULL | 名称 1~100 字符 |
| sku | TEXT | NOT NULL UNIQUE | SKU 编码 1~50 字符，全局唯一（含软删除记录） |
| barcode | TEXT | NULL | 条形码 |
| category_id | INTEGER | NOT NULL FK→categories.id | 分类 |
| unit | TEXT | NOT NULL | 单位（个/箱/千克…），1~10 字符 |
| spec | TEXT | NULL | 规格 |
| sale_price | INTEGER | NULL | 售价（分），≥0 |
| remark | TEXT | NULL | 备注 ≤200 字符 |
| created_at | TEXT | NOT NULL | 创建时间 |
| updated_at | TEXT | NOT NULL | 更新时间 |
| deleted_at | TEXT | NULL | 软删除时间 |

### 5.5 suppliers（供应商表）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK 自增 | 供应商 ID |
| name | TEXT | NOT NULL UNIQUE | 名称 1~100 字符，全局唯一 |
| contact_person | TEXT | NULL | 联系人 |
| phone | TEXT | NULL | 电话（正则校验） |
| email | TEXT | NULL | 邮箱（格式校验） |
| address | TEXT | NULL | 地址 ≤200 字符 |
| status | INTEGER | NOT NULL DEFAULT 1 | 1=合作中 0=已停用 |
| remark | TEXT | NULL | 备注 |
| created_at | TEXT | NOT NULL | 创建时间 |
| updated_at | TEXT | NOT NULL | 更新时间 |
| deleted_at | TEXT | NULL | 软删除时间 |

### 5.6 purchase_orders（采购单主表）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK 自增 | 采购单 ID |
| order_no | TEXT | NOT NULL UNIQUE | 单号 `PO+yyyyMMdd+4 位流水` |
| supplier_id | INTEGER | NOT NULL FK→suppliers.id | 供应商 |
| status | TEXT | NOT NULL DEFAULT 'draft' | draft/submitted/received/cancelled |
| total_amount | INTEGER | NOT NULL DEFAULT 0 | 总金额（分）= Σ明细，提交时锁定 |
| remark | TEXT | NULL | 备注 |
| created_by | INTEGER | NOT NULL FK→users.id | 创建人 |
| submitted_at | TEXT | NULL | 提交时间 |
| received_at | TEXT | NULL | 入库时间 |
| received_by | INTEGER | NULL FK→users.id | 入库确认人 |
| created_at | TEXT | NOT NULL | 创建时间 |
| updated_at | TEXT | NOT NULL | 更新时间 |

### 5.7 purchase_order_items（采购单明细表）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK 自增 | 明细 ID |
| order_id | INTEGER | NOT NULL FK→purchase_orders.id | 所属采购单 |
| product_id | INTEGER | NOT NULL FK→products.id | 商品 |
| quantity | INTEGER | NOT NULL | 数量 1~999999 |
| unit_price | INTEGER | NOT NULL | 进价快照（分），>0 |
| created_at | TEXT | NOT NULL | 创建时间 |

唯一约束：`(order_id, product_id)`；删除采购单（草稿）时级联删除明细。

### 5.8 inventory（库存表）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK 自增 | 库存记录 ID |
| product_id | INTEGER | NOT NULL UNIQUE FK→products.id | 商品（一商品一库存记录） |
| quantity | INTEGER | NOT NULL DEFAULT 0 | 当前数量 ≥0 |
| warn_threshold | INTEGER | NOT NULL DEFAULT 10 | 预警阈值 0~999999 |
| updated_at | TEXT | NOT NULL | 最后变动时间 |
| updated_by | INTEGER | NULL FK→users.id | 最后操作人 |

数量变动仅允许发生在事务内（采购入库/手动调整），禁止绕过流水直改。

### 5.9 inventory_logs（库存流水表，只增不改不删）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK 自增 | 流水 ID |
| product_id | INTEGER | NOT NULL FK→products.id | 商品 |
| type | TEXT | NOT NULL | purchase_in（采购入库）/ manual_in（手动入库）/ manual_out（手动出库） |
| quantity | INTEGER | NOT NULL | 变动数量（正数） |
| direction | INTEGER | NOT NULL | +1 增加 / -1 减少 |
| before_quantity | INTEGER | NOT NULL | 变动前数量 |
| after_quantity | INTEGER | NOT NULL | 变动后数量 |
| ref_type | TEXT | NULL | 关联类型：purchase_order / manual |
| ref_id | INTEGER | NULL | 关联单据 ID |
| ref_no | TEXT | NULL | 关联单号（如 PO202609210001） |
| reason | TEXT | NULL | 调整原因（手动调整必填） |
| operator_id | INTEGER | NOT NULL FK→users.id | 操作人 |
| created_at | TEXT | NOT NULL | 流水时间 |

索引：`(product_id, created_at)`、`(created_at)`。

### 5.10 audit_logs（操作日志表，只增不改不删）

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK 自增 | 日志 ID |
| user_id | INTEGER | NULL FK→users.id | 操作人（登录失败且用户名不存在时为 NULL） |
| username | TEXT | NOT NULL | 操作人用户名快照 |
| action | TEXT | NOT NULL | 动作：login_success/login_failed/logout/create/update/delete/submit/receive/adjust 等 |
| module | TEXT | NOT NULL | 模块：auth/product/category/supplier/purchase/inventory/user |
| target | TEXT | NULL | 目标标识（如商品 SKU、采购单号、用户名） |
| detail | TEXT | NULL | 详情 JSON（敏感字段脱敏） |
| ip | TEXT | NULL | 客户端 IP |
| user_agent | TEXT | NULL | UA |
| created_at | TEXT | NOT NULL | 时间 |

索引：`(username, created_at)`、`(module, created_at)`。

### 5.11 实体关系简述

```
users ─┬─< purchase_orders(created_by/received_by)
       ├─< inventory_logs(operator_id)
       └─< audit_logs(user_id)
categories ─< products ─┬─ inventory (1:1)
                        ├─< purchase_order_items >─ purchase_orders >─ suppliers
                        └─< inventory_logs
```

---

## 6. API接口清单

通用约定：

- 基础前缀 `/api`；除标注"公开"外均需 `Authorization: Bearer <accessToken>`。
- 统一响应：`{ code, message, data }`；列表类返回 `data: { list, total, page, pageSize }`。
- 权限列缩写：`全部`=4 角色均可；`管理员`；`采购员`（含管理员，下同——**管理员始终拥有全部权限**，表中不再重复标注）；`库管`；`查看员`仅出现在"全部"行。
- 分页参数统一：`page`（默认 1）、`pageSize`（默认 20，最大 100）。

### 6.1 认证模块 /api/auth

| 方法 | 路径 | 说明 | 关键参数（请求） | 成功返回（data） | 权限 |
| --- | --- | --- | --- | --- | --- |
| POST | /api/auth/login | 登录（公开，限流 10 次/分/IP） | body: `{username, password}` | `{accessToken, refreshToken, expiresIn, user:{id,username,realName,role,mustChangePassword}}` | 公开 |
| POST | /api/auth/refresh | 刷新 access token（公开） | body: `{refreshToken}` | `{accessToken, expiresIn}` | 公开 |
| POST | /api/auth/logout | 登出（记录审计） | — | `null` | 全部 |
| GET | /api/auth/me | 当前用户信息 | — | `{id,username,realName,role,mustChangePassword}` | 全部 |
| PUT | /api/auth/password | 修改本人密码（成功后 token_version+1） | body: `{oldPassword, newPassword}` | `null` | 全部 |

### 6.2 分类模块 /api/categories

| 方法 | 路径 | 说明 | 关键参数 | 成功返回 | 权限 |
| --- | --- | --- | --- | --- | --- |
| GET | /api/categories | 分类列表（树形，含每类商品数） | query: `keyword`(可选) | `[{id,name,parentId,productCount,children}]` | 全部 |
| POST | /api/categories | 新增分类 | body: `{name, parentId?}` | `{id,name,parentId}` | 库管 |
| PUT | /api/categories/:id | 修改分类 | body: `{name, parentId?}` | 更新后对象 | 库管 |
| DELETE | /api/categories/:id | 删除分类（含商品时 400） | — | `null` | 库管 |

### 6.3 商品模块 /api/products

| 方法 | 路径 | 说明 | 关键参数 | 成功返回 | 权限 |
| --- | --- | --- | --- | --- | --- |
| GET | /api/products | 分页列表（模糊搜索） | query: `keyword`(名称/SKU), `categoryId`, `page`, `pageSize`, `sort=created_at_asc\|created_at_desc` | `{list,total,page,pageSize}`（list 含分类名、库存数量、预警阈值） | 全部 |
| GET | /api/products/:id | 商品详情 | — | 商品完整信息（含库存、分类） | 全部 |
| POST | /api/products | 新增商品 | body: `{name, sku, categoryId, unit, barcode?, spec?, salePrice?(分), remark?, warnThreshold?}` | `{id}` | 库管 |
| PUT | /api/products/:id | 编辑商品（SKU 可改，仍做唯一校验） | 同上 | 更新后对象 | 库管 |
| DELETE | /api/products/:id | 软删除（有库存时 400） | — | `null` | 库管 |

### 6.4 供应商模块 /api/suppliers

| 方法 | 路径 | 说明 | 关键参数 | 成功返回 | 权限 |
| --- | --- | --- | --- | --- | --- |
| GET | /api/suppliers | 分页列表 | query: `keyword`(名称), `status`(1/0), `page`, `pageSize` | `{list,total,page,pageSize}` | 全部 |
| GET | /api/suppliers/:id | 供应商详情 | — | 供应商完整信息 | 全部 |
| POST | /api/suppliers | 新增 | body: `{name, contactPerson?, phone?, email?, address?, remark?}` | `{id}` | 采购员 |
| PUT | /api/suppliers/:id | 编辑 | 同上 | 更新后对象 | 采购员 |
| PUT | /api/suppliers/:id/status | 启用/停用 | body: `{status: 1\|0}` | 更新后对象 | 采购员 |
| DELETE | /api/suppliers/:id | 删除（被采购单引用时 400） | — | `null` | 采购员 |

### 6.5 采购模块 /api/purchase-orders

| 方法 | 路径 | 说明 | 关键参数 | 成功返回 | 权限 |
| --- | --- | --- | --- | --- | --- |
| GET | /api/purchase-orders | 分页列表 | query: `keyword`(单号/供应商名), `status`, `startDate`, `endDate`, `page`, `pageSize` | `{list,total,page,pageSize}` | 全部 |
| GET | /api/purchase-orders/:id | 详情（含明细、供应商、操作人） | — | 采购单完整信息 | 全部 |
| POST | /api/purchase-orders | 创建草稿 | body: `{supplierId, remark?, items:[{productId, quantity, unitPrice}]}` | `{id, orderNo}` | 采购员 |
| PUT | /api/purchase-orders/:id | 编辑草稿（非 draft 状态 400） | 同创建 | 更新后对象 | 采购员 |
| DELETE | /api/purchase-orders/:id | 删除草稿（仅 draft 可删，物理删除） | — | `null` | 采购员 |
| POST | /api/purchase-orders/:id/submit | 提交（draft→submitted，锁定明细，重算总金额） | — | `{status:'submitted'}` | 采购员 |
| POST | /api/purchase-orders/:id/receive | 入库确认（submitted→received，事务内加库存+写流水；重复调用 400） | — | `{status:'received'}` | 库管 |
| POST | /api/purchase-orders/:id/cancel | 取消（draft/submitted→cancelled） | body: `{reason}` | `{status:'cancelled'}` | 采购员 |

### 6.6 库存模块 /api/inventory

| 方法 | 路径 | 说明 | 关键参数 | 成功返回 | 权限 |
| --- | --- | --- | --- | --- | --- |
| GET | /api/inventory | 库存分页列表 | query: `keyword`(名称/SKU), `categoryId`, `lowStock=true`(仅低库存), `page`, `pageSize` | `{list,total,page,pageSize}`（list 含商品信息、quantity、warnThreshold、isLowStock） | 全部 |
| PUT | /api/inventory/:productId/threshold | 修改预警阈值 | body: `{warnThreshold: 0~999999}` | 更新后对象 | 库管 |
| POST | /api/inventory/adjust | 手动出入库调整（事务内更新库存+写流水；出库超量 400） | body: `{productId, type:'manual_in'\|'manual_out', quantity>0, reason}` | `{productId, quantityAfter}` | 库管 |
| GET | /api/inventory/logs | 流水分页（只读） | query: `productId`, `type`, `startDate`, `endDate`, `page`, `pageSize` | `{list,total,page,pageSize}` | 全部 |

### 6.7 看板模块 /api/dashboard

| 方法 | 路径 | 说明 | 关键参数 | 成功返回 | 权限 |
| --- | --- | --- | --- | --- | --- |
| GET | /api/dashboard/stats | 统计数据 | — | `{productCount, totalStock, lowStockCount, purchaseAmount7d:{date,amount(分)[]}}` | 全部 |

### 6.8 用户管理模块 /api/users（仅管理员）

| 方法 | 路径 | 说明 | 关键参数 | 成功返回 | 权限 |
| --- | --- | --- | --- | --- | --- |
| GET | /api/users | 用户分页列表 | query: `keyword`(用户名/姓名), `roleCode`, `status`, `page`, `pageSize` | `{list,total,page,pageSize}`（不含 password_hash） | 管理员 |
| POST | /api/users | 新增用户 | body: `{username, password, realName, roleCode}` | `{id}` | 管理员 |
| PUT | /api/users/:id | 编辑（姓名/角色/状态；禁止操作自己；保护最后启用管理员） | body: `{realName, roleCode, status}` | 更新后对象 | 管理员 |
| PUT | /api/users/:id/reset-password | 重置密码（目标用户 must_change_password=1） | body: `{newPassword}` | `null` | 管理员 |
| POST | /api/users/:id/unlock | 解除登录锁定 | — | `null` | 管理员 |
| DELETE | /api/users/:id | 软删除（禁止操作自己与最后启用管理员） | — | `null` | 管理员 |

### 6.9 审计日志模块 /api/audit-logs（仅管理员）

| 方法 | 路径 | 说明 | 关键参数 | 成功返回 | 权限 |
| --- | --- | --- | --- | --- | --- |
| GET | /api/audit-logs | 日志分页 | query: `username`, `module`, `action`, `startDate`, `endDate`, `page`, `pageSize` | `{list,total,page,pageSize}` | 管理员 |

### 6.10 鉴权中间件设计

```
请求 → [全局中间件: helmet/cors/限流/json解析]
     → [路由匹配] → 公开接口直接放行
     → [authMiddleware] 校验 JWT 签名/有效期/token_version → 注入 req.user → 失败 401
     → [rbacMiddleware(允许角色列表)] → 不在列表 403
     → [schema校验中间件] → 参数非法 400（附字段级错误）
     → controller → service（事务） → 统一响应/错误处理（对外脱敏）
```

---

## 7. 页面清单与路由规划

### 7.1 路由表

| 路由路径 | 页面名称 | 菜单显示 | 访问角色 | 布局 |
| --- | --- | --- | --- | --- |
| /login | 登录页 | 不显示 | 公开（已登录访问则重定向 /） | 全屏无侧栏 |
| / | 数据看板 | 数据看板 | 全部 | 主布局 |
| /products | 商品管理 | 商品管理 | 全部（按钮按权限显隐） | 主布局 |
| /suppliers | 供应商管理 | 供应商管理 | 全部（按钮按权限显隐） | 主布局 |
| /purchase-orders | 采购管理 | 采购管理 | 全部（按钮按权限显隐） | 主布局 |
| /inventory | 库存管理 | 库存管理 | 全部（按钮按权限显隐） | 主布局 |
| /users | 用户管理 | 用户管理 | 仅 admin | 主布局 |
| /audit-logs | 操作日志 | 操作日志 | 仅 admin | 主布局 |
| * | 404 页 | — | — | 主布局 |

路由守卫：全局前置守卫校验 token 有效性（无效→/login 并记录回跳地址）；按角色表拦截无权限路由（重定向 / 并提示"无权访问"）；`mustChangePassword=1` 的用户仅可访问 /login（改密弹窗）与 /auth/password 相关动作。

### 7.2 页面核心元素

| 页面 | 核心元素描述 |
| --- | --- |
| 登录页 | 居中卡片：系统名、用户名输入框、密码输入框（可切换明文）、登录按钮（主色 #06B6D4，loading 态禁重复提交）、错误提示区（统一文案）；底部显示系统版本号 |
| 主布局 | 左侧导航（桌面固定/平板折叠/手机抽屉，选中项聚焦色 #0E7490）；顶栏：面包屑、低库存角标提醒（数量）、用户头像下拉（修改密码/退出登录） |
| 数据看板 | 4 张统计卡片（商品总数/库存总量/低库存商品数/近 7 日采购金额，低库存卡片琥珀色可点击）；近 7 日采购金额趋势图（ECharts 柱状图，主题色 #06B6D4）；卡片数据 loading 骨架屏 |
| 商品管理 | 顶部搜索区（关键词、分类下拉、搜索/重置按钮）；操作按钮（新增——按权限显隐）；表格列：SKU/名称/分类/单位/规格/售价(元)/库存/预警阈值/创建时间/操作（编辑、删除）；新增/编辑弹窗表单（必填校验、SKU 重复前端预检+后端兜底）；删除二次确认弹窗 |
| 供应商管理 | 搜索区（关键词、状态下拉）；表格列：名称/联系人/电话/邮箱/状态(标签)/创建时间/操作（编辑、启停切换、删除）；新增/编辑弹窗（电话/邮箱前端格式校验）；停用操作二次确认 |
| 采购管理 | 筛选区（关键词、状态、日期区间）；"新建采购单"按钮（采购员）；列表列：单号/供应商/总金额(元)/状态标签(草稿灰/已提交蓝/已入库绿/已取消红)/创建人/创建时间/操作；新建/编辑页：供应商下拉（仅合作中）、明细表格（商品搜索选择器、数量、进价，实时小计与合计）、保存草稿/直接提交；详情抽屉：单据信息+明细+流转记录，按钮区按状态与角色渲染（提交/入库确认/取消/编辑） |
| 库存管理 | 筛选区（关键词、分类、"仅看低库存"开关）；表格列：SKU/名称/分类/当前数量(低库存琥珀色高亮)/预警阈值/最近变动时间/操作（调整库存、设阈值——按权限显隐）；调整库存弹窗（类型单选 入库/出库、数量、原因必填）；库存流水页签或子页（时间倒序，列：时间/商品/类型/变动/前后数量/关联单号/操作人/原因） |
| 用户管理 | 搜索区（关键词、角色、状态）；表格列：用户名/姓名/角色/状态/最近登录/操作（编辑、重置密码、解锁、删除）；新增用户弹窗（初始密码生成规则提示）；危险操作红色二次确认 |
| 操作日志 | 筛选区（操作人、模块、动作、时间区间）；表格列：时间/操作人/动作/模块/目标/详情（JSON 可展开）/IP；仅查看无任何写入口 |
| 404 页 | 居中提示"页面不存在"+ 返回看板按钮 |

---

## 8. 里程碑与验收清单

### 8.1 里程碑计划

| 里程碑 | 内容 | 交付物 | 建议工期 |
| --- | --- | --- | --- |
| M1 基础设施 | 前后端脚手架、SQLite 建表与种子数据（预置角色+admin 账号）、统一响应/错误处理、JWT 中间件、日志 | 可启动的空系统 + 数据库初始化脚本 | 3 天 |
| M2 认证与用户 | FR-01、FR-07、FR-08：登录/锁定/双 token/改密、用户管理、审计日志框架 | 可登录的多角色系统 | 4 天 |
| M3 主数据 | FR-02、FR-03：分类、商品、供应商全部接口与页面 | 主数据管理可用 | 5 天 |
| M4 业务闭环 | FR-04、FR-05：采购单全状态机、事务化入库、库存与流水、手动调整 | 采购→入库→库存联动闭环 | 6 天 |
| M5 看板与打磨 | FR-06、FR-09：看板统计与图表、响应式适配、UI 走查（配色/禁纯白/动画约束） | 功能完整系统 | 4 天 |
| M6 安全与验收 | 4.2 安全基线自查修复、渗透测试问题修复、全量验收清单回归、部署文档 | 验收通过版本 + 渗透测试报告闭环 | 5 天 |

关键路径：M1→M2→M3→M4→M5→M6 串行，总计约 27 个工作日；M3 内分类/供应商可与商品并行开发。

### 8.2 验收清单（最终验收依据）

| 编号 | 验收项 | 验收标准（可测试） | 优先级 |
| --- | --- | --- | --- |
| A01 | 默认账号与强制改密 | 用 admin/***REMOVED-SEED-PASSWORD*** 首次登录被要求改密；改密前业务接口返回 403 | P0 |
| A02 | 登录锁定 | 连续 5 次错误密码后账号锁定 15 分钟，期间正确密码也被拒；管理员可手动解锁 | P0 |
| A03 | Token 生命周期 | access 过期 401→refresh 换新；refresh 过期跳登录；改密后旧 access 全部失效 | P0 |
| A04 | 权限矩阵回归 | 按 2.2 矩阵逐格验证：每个角色对每类操作的实际结果与矩阵一致（重点：采购员调用入库接口 403、viewer 全部写接口 403） | P0 |
| A05 | SKU 唯一性 | 重复 SKU 返回 409；软删除商品的 SKU 也不可复用 | P0 |
| A06 | 商品删除约束 | 库存>0 的商品删除被 400 拒绝 | P0 |
| A07 | 分类删除约束 | 含商品分类删除被 400 拒绝 | P0 |
| A08 | 供应商约束 | 重名 409；被采购单引用的供应商删除 400；停用后不出现在新建采购单下拉 | P0 |
| A09 | 采购状态机 | draft 可编辑、submitted 锁定、received 终态；非法流转全部 400 | P0 |
| A10 | 入库事务联动 | 入库后库存增加、流水生成、状态更新三者同成功同失败；并发重复入库只生效一次 | P0 |
| A11 | 库存下限保护 | 手动出库导致负库存被 400 拒绝且无流水 | P0 |
| A12 | 低库存筛选 | 数量≤阈值的商品被正确筛选并高亮；阈值修改即时生效 | P0 |
| A13 | 看板准确性 | 造数比对 4 项统计与趋势图数值，误差为 0；空数据日补 0 | P0 |
| A14 | 流水与日志不可篡改 | 系统内无任何修改/删除流水与审计日志的入口和 API | P0 |
| A15 | SQL 注入 | 对全部列表/搜索接口注入 `' OR 1=1 --`、`"; DROP TABLE products;--` 等 payload，无异常行为、无数据损坏 | P0 |
| A16 | XSS | 商品名/备注等字段输入 `<script>alert(1)</script>`，列表展示为纯文本不执行 | P0 |
| A17 | 密码安全 | 数据库文件中无明文密码；接口响应与审计日志无密码哈希/明文 | P0 |
| A18 | 限流与安全头 | 登录超 10 次/分返回 429；响应含 helmet 安全头；错误响应无堆栈/SQL | P0 |
| A19 | 分页与搜索 | 万级商品造数下：模糊搜索、分页、排序结果正确且 P95 ≤ 800ms | P0 |
| A20 | 响应式 | 1366/1024/375 三分辨率走查全部页面无布局错乱 | P0 |
| A21 | UI 基调 | 主色/悬停/聚焦色与 4.5 规范一致；无大面积纯白背景；无 >200ms 装饰动画 | P0 |
| A22 | 部署 | 按 README 在干净 Windows 主机 30 分钟内完成部署并跑通登录→建商品→建采购单→入库→看板全流程 | P0 |
| A23 | 注释规范 | 抽查 20 个核心类/函数，均含类级/函数级/参数/返回值/异常注释 | P0 |
| A24 | 依赖健康 | `pnpm audit` 无高危漏洞；`pnpm build` 零错误 | P1 |

### 8.3 上线交付物清单

1. 前端构建产物与后端源码（含完整注释）。
2. 数据库初始化与种子数据脚本。
3. 部署文档（Windows/Linux 双版本）：环境变量清单（`JWT_SECRET`、`PORT`、`DB_PATH` 等）、启动命令、备份说明。
4. 渗透测试报告及问题修复记录。
5. 本验收清单的逐项回归记录。

---

## 附录 A：错误码约定

| code | HTTP | 含义 |
| --- | --- | --- |
| 0 | 200 | 成功 |
| 1001 | 400 | 参数校验失败（message 附字段级详情） |
| 1002 | 401 | 未登录 / token 无效或过期 |
| 1003 | 403 | 无权限 / 未完成强制改密 |
| 1004 | 404 | 资源不存在 |
| 1005 | 409 | 唯一性冲突（SKU/用户名/供应商名等） |
| 1006 | 400 | 业务规则拒绝（状态机非法流转、库存不足、删除约束等） |
| 1007 | 423 | 账号已锁定 |
| 1008 | 429 | 请求过于频繁 |
| 5000 | 500 | 服务器内部错误（对外统一文案，不泄露细节） |

## 附录 B：术语表

| 术语 | 定义 |
| --- | --- |
| SKU | Stock Keeping Unit，商品最小库存单位编码，本系统内全局唯一 |
| 进价快照 | 采购单明细中保存的下单时单价，后续价格变动不影响历史单据 |
| 低库存 | 商品当前库存数量 ≤ 该商品预警阈值 |
| 软删除 | 仅标记 deleted_at，数据保留于库中但业务查询默认过滤 |
| 双 token | access token（短期，2h）+ refresh token（长期，7d）的 JWT 会话机制 |

---

（文档结束）
