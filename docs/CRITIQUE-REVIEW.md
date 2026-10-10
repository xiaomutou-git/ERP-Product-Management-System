# ERP商品管理系统 · 刁钻用户多维严苛评测报告

| 项目 | 内容 |
| --- | --- |
| 评测对象 | ERP商品管理系统 v1.0.0（Vue3 + Element Plus + Express + SQLite） |
| 评测日期 | 2026-09-21 |
| 评测方式 | ① Playwright 真实浏览器实测（1366×768 与 375×667 双分辨率，截图 25 张）；② 全量通读 frontend/src/views 10 个页面 + 布局 + 路由 + 令牌 + 请求层源码；③ curl 直击后端接口核对数据契约；④ 执行 pnpm build 核验打包产物 |
| 严重程度定义 | P0 致命（核心功能失效/数据误导）｜P1 严重（承诺未兑现/场景不可用）｜P2 中等（明显减分但可绕过）｜P3 轻微（打磨问题） |
| 测试副作用声明 | 全程只读测试，未修改任何业务数据；admin 账号密码未变更，本次实测未触发强制改密页 |

---

## 零、总评

这是一套"设计稿写得很满、实现交卷参差"的系统。设计文档 [docs/UI-DESIGN.md](docs\UI-DESIGN.md) 承诺了逐像素级规范、四类空态、键盘可达、焦点陷阱、状态色全站唯一映射——实测证明其中相当一部分是"文档里的一厢情愿"。更要命的是**采购详情抽屉的字段断链**（后端 snake_case / 前端 camelCase），让系统最核心的单据可信度当场崩塌：一张已入库的采购单，头部没有单号、创建时间显示"—"、合计显示"¥—"。这种"演示时会被客户当场问死"的问题，比任何配色瑕疵都严重一百倍。

---

## 一、UI 审美（得分 6.0 / 10）

**总体观感**：干净、克制、无廉价动画，第一眼是合格的 B 端工具脸。但经不起放大看——它是"用 Element Plus 默认件 + 一个青色"拼出来的模板脸，没有一处让人记住的品牌记忆点，属于典型的"AI 生成感"安全区审美。

### A-1【P2】"全站唯一状态色来源"名存实亡，裸色值系统性违反自家红线
- 【问题描述】UI-DESIGN 第 2 章白纸黑字："业务代码禁止出现裸色值，一律引用变量"。实测：[format.ts](frontend\src\utils\format.ts#L51-L71) 全部状态映射、[SuppliersView.vue 状态列](frontend\src\views\SuppliersView.vue#L268)、[UsersView.vue 强度色](frontend\src\views\UsersView.vue#L82)、[DashboardView.vue 统计卡内联 style](frontend\src\views\DashboardView.vue#L145)、[InventoryView.vue](frontend\src\views\InventoryView.vue#L276) 的 `active-color="#F59E0B"`（Element Plus 已废弃 API）——色值散落 6 个文件 20+ 处。
- 【严重程度】P2
- 【具体位置/复现】上述文件逐处可查；改一次品牌色需要动 6 个文件，tokens.css 的 `--brand-*` 变量形同虚设。
- 【改进建议】删除所有内联色值，状态映射统一收敛到一个引用 CSS 变量的模块；`active-color` 改用 CSS 覆写（tokens.css 里其实已经写了 switch 琥珀覆写，此属性纯属重复且触发 EP 废弃告警）。

### A-2【P2】登录卡实测 464px 宽，设计承诺 400px——"逐像素落地"第一枪就脱靶
- 【问题描述】UI-DESIGN 5.1 规定登录卡"宽 400px，内边距 40px 32px"。Playwright 实测 `.login-card` bounding box 为 **464×329px**（400 + 左右 padding 64，未按 border-box 落地）。
- 【严重程度】P2
- 【具体位置/复现】[LoginView.vue](frontend\src\views\LoginView.vue#L173-L177)，任何浏览器 DevTools 量一下即现。
- 【改进建议】全局 `*{box-sizing:border-box}` 或该卡显式声明；既然设计稿自称"逐像素落地实现"，就别让第一个元素就差 64px。

### A-3【P3】登录页装饰是"无效装饰"
- 【问题描述】左下实心圆 `rgba(236,254,255,.6)` 叠在 `#F1F5F9` 底上，肉眼几乎不可见（见实测截图 01c）；右上圆环 #ECFEFF 同样近乎隐形。装饰元素存在感为零，纯粹为了"设计稿上有"而存在。整套登录页 = 居中卡片 + 两个隐形圆，是所有 AI 生成后台的默认长相，没有记忆点。
- 【严重程度】P3
- 【改进建议】要么把装饰做出真实的层次（如深一档的青色投影、网格纹理），要么删掉；"商品 · 采购 · 库存 一体化管理"副标题可以换成一句有业务体温的话。

### A-4【P2】商品表格"分类"列文本换行，行高参差
- 【问题描述】分类列宽 140px 塞"电子产品 / 手机数码"两级文本，实测截图（07_product_dialog.png 背景表格）中 SKU-1004/1005/1006 等多行均折成两行，行高被撑破 48px 规格，斑马纹视觉节奏被打乱。
- 【严重程度】P2
- 【具体位置/复现】[ProductsView.vue 分类列](frontend\src\views\ProductsView.vue#L444-L446)，打开商品列表即可见。
- 【改进建议】列宽加大到 170px 或启用 `show-overflow-tooltip`；二级分类只显示二级名 + hover 全路径。

### A-5【P3】看板金额格式精神分裂：卡片无千分位，tooltip 有
- 【问题描述】统计卡显示 `¥4205.00`（无千分位），而图表 tooltip 用 `toLocaleString` 显示 `¥1,234.56`。同一个数字两种格式，B 端财务语境里这是不可接受的细节粗糙。
- 【严重程度】P3
- 【位置】[DashboardView.vue 卡片](frontend\src\views\DashboardView.vue#L194) vs [tooltip formatter](frontend\src\views\DashboardView.vue#L73-L76)。
- 【改进建议】`fen2yuan` 增加千分位选项并全站统一。

### A-6【P3】图表 Y 轴无单位标注
- 【问题描述】UI-DESIGN 5.2 要求"Y 轴金额（元）"，实测截图（04_after_login.png）Y 轴只有 0~5,000 裸数字，无"元"字样；新用户无法分辨是元、万元还是分。
- 【严重程度】P3
- 【改进建议】Y 轴 name 设为"元"，或 tooltip/轴标签带单位。

### A-7【P3】空态插图承诺 9 种题材，实际全站一张纸箱
- 【问题描述】UI-DESIGN 6.3 承诺"商品/分类/供应商/采购/库存/流水/用户/日志/404"9 种自绘线稿题材；实现里 [EmptyState.vue](frontend\src\components\EmptyState.vue) 只有一张纸箱图吃遍全站（仅点缀圆点可换色），404 另有一张。承诺的题材分化没有兑现。
- 【严重程度】P3

---

## 二、交互体验（得分 4.5 / 10）

这是全系统最失分的维度。设计稿把"反馈即时、错误有位、空态四类"写得漂漂亮亮，实测交卷如下。

### B-1【P0】采购详情抽屉字段断链：单号没了、金额"¥—"、时间"—"满天飞
- 【问题描述】**后端详情接口返回 snake_case，前端按 camelCase 读取**。curl 实测 `GET /api/purchase-orders/2` 返回 `order_no / total_amount / created_at / submitted_at / received_at / cancel_reason`（[后端详情响应实测](backend)），而 [PurchaseOrdersView.vue](frontend\src\views\PurchaseOrdersView.vue#L303-L354) 读的是 `detail.orderNo / detail.totalAmount / detail.createdAt / detail.submittedAt / detail.receivedAt / detail.cancelReason`。
- 【实测后果】（截图 12_po_drawer.png / 25_mobile_drawer.png）一张**已入库**采购单：① 抽屉头部单号完全空白；② 创建时间显示"—"；③ 步骤条"已提交/已入库"节点时间全是"—"；④ 明细合计显示 **"¥—"**（明细小计 5.00 明明正常）；⑤ 已取消单据的取消原因将无法显示。列表页字段正常（说明列表/详情两个接口大小写风格不统一，契约混乱实锤）。
- 【严重程度】P0
- 【复现】采购管理 → 点任意单号打开抽屉，肉眼可见。
- 【改进建议】后端统一响应字段为 camelCase（或 axios 层加全局下划线转驼峰拦截器）；补一条"详情响应字段"的集成测试，防回归。

### B-2【P0】用户页空态"开天窗"：EmptyState 没 import，控制台持续报警
- 【问题描述】[UsersView.vue 第 295 行](frontend\src\views\UsersView.vue#L295) 使用 `<EmptyState>` 但**全文件没有 import**。实测空搜索 `/users?keyword=zzzzz_no_exist`：空态区域渲染为彻底空白（`.empty-state` 元素数 = 0），控制台连续输出 `[Vue warn] Failed to resolve component: EmptyState`。
- 【严重程度】P0（直接违反 UI-DESIGN 4.8"四类空态"的底线交付，且是 10 秒就能修的低级错误）
- 【复现】用户管理 → 搜索一个不存在的用户名。
- 【改进建议】补 import；建议加 `eslint-plugin-vue` 的 `vue/no-undef-components` 规则防再犯。

### B-3【P1】所有列表页把"接口报错"伪装成"暂无数据"
- 【问题描述】五个列表页的 `loadList()` 统一 `catch { rows.value = [] }`，后果：后端挂掉/断网时，页面显示"暂无商品数据/暂无采购单"——**错误被翻译成了错误的业务结论**。UI-DESIGN 4.8 明确要求四类空态之一是"加载失败 + 重试按钮"，实测只有看板做了错误态（且统计卡内只有"加载失败"三个字没有重试按钮，重试按钮被放到了图表区）。
- 【严重程度】P1
- 【位置】[ProductsView.vue loadList](frontend\src\views\ProductsView.vue#L85-L102) 及 Suppliers/PO/Inventory/AuditLogs 同款写法。
- 【复现】杀掉后端进程刷新任意列表页。
- 【改进建议】catch 中区分错误类型，置 `loadError=true` 渲染 EmptyState 的"加载失败 + 重试"变体。

### B-4【P1】审计日志"查看"是死链接
- 【问题描述】详情列渲染 `<span class="detail-link">查看</span>`，样式给了 `cursor:pointer`（长得可点），**但没有绑定任何 click 事件**。Playwright 实测点击后 `.expand-body` 数量为 0（展开只能靠最左侧那个展开箭头）。
- 【严重程度】P1（视觉说谎：可点击的外貌 + 不可点击的行为）
- 【位置】[AuditLogsView.vue](frontend\src\views\AuditLogsView.vue#L174-L178)
- 【改进建议】点击"查看"时调用 el-table 的 `toggleRowExpansion`，或删掉假链接只留箭头。

### B-5【P1】库存页"仅看低库存"：看板跳转生效，同页点铃铛失效
- 【问题描述】`filters.lowStock` 只在 setup 时读一次 `route.query.lowStock`（[InventoryView.vue L33](frontend\src\views\InventoryView.vue#L33)），没有 watch route。当用户已在 /inventory 页面点击顶栏铃铛（push `/inventory?lowStock=1`），组件复用、query 变了但开关纹丝不动。
- 【严重程度】P1
- 【复现】停留在库存管理页 → 点顶栏铃铛 → 开关无反应。
- 【改进建议】`watch(() => route.query.lowStock, ...)` 同步开关。

### B-6【P1】编辑草稿时供应商被"锁死"
- 【问题描述】[PurchaseOrderFormView.vue](frontend\src\views\PurchaseOrderFormView.vue#L273-L288)：编辑草稿时若原供应商已停用，模板直接渲染纯文本 + "已停用" Tag（v-if 分支），**不渲染下拉框**——用户完全无法把供应商换成别人。设计原意只是"保留显示并标注"，不是"剥夺修改权"。
- 【严重程度】P1
- 【改进建议】文本旁保留"更换供应商"入口，点击切换回下拉；默认仍选中原供应商。

### B-7【P1】"创建成功但提交失败"会制造幽灵草稿
- 【问题描述】新建单直接提交走 `createPurchaseOrder → submitPurchaseOrder` 两段式（[PurchaseOrderFormView.vue saveDraft(true)](frontend\src\views\PurchaseOrderFormView.vue#L184-L204)）。第一步成功、第二步失败时：草稿已经落库，但用户停留在原页面，界面上没有任何"草稿已创建"的痕迹；用户再点一次"提交采购单"→ **再建一张一模一样的草稿**。
- 【严重程度】P1（数据重复风险 + 用户无感知）
- 【改进建议】创建成功后立即用返回 id 把路由替换成编辑页，再走提交；或失败 toast 中带上单号并给出"前往草稿"链接。

### B-8【P2】进价默认填的是"售价"
- 【问题描述】选中商品追加明细时 `unitPriceYuan = salePrice/100`（[PurchaseOrderFormView.vue L125](frontend\src\views\PurchaseOrderFormView.vue#L125)）——**把销售价当采购进价预填**。业务语义完全错位：采购员稍不留神，采购成本就被售价污染，报表金额失真。
- 【严重程度】P2（虽可修改，但默认值应该是 0 或空 + 必填校验）
- 【改进建议】预填空值并聚焦该输入框，placeholder 提示"请输入进价"。

### B-9【P2】出库超量的"库存不足"错误挂在"调整原因"字段下
- 【问题描述】调整库存弹窗用单个 `adjustError` 变量同时服务"原因未填"和"库存不足"两种错误（[InventoryView.vue submitAdjust](frontend\src\views\InventoryView.vue#L135-L155)），错误永远渲染在"调整原因"表单项下——数量超了却怪原因没写，错误定位误导用户。
- 【严重程度】P2
- 【改进建议】数量与原因各自独立 error 槽位。

### B-10【P2】"添加商品"是假按钮 + 说教文案
- 【问题描述】明细表空行中的虚线"添加商品"整行可点（有 hover 变色），点上去却只弹一句 **"请使用上方商品选择器搜索并添加商品"**（Playwright 实测 toast 原文）。把最自然的点击路径做成"教用户做事"的警告，属于典型反模式。UI-DESIGN 5.5 的原意是"添加商品 Default 按钮（虚线边框，整行宽）"——即点了就该打开商品选择器。
- 【严重程度】P2
- 【位置】[PurchaseOrderFormView.vue L338-L344](frontend\src\views\PurchaseOrderFormView.vue#L338-L344)
- 【改进建议】点击虚线行 = 直接 focus 商品搜索下拉并展开。

### B-11【P2】多 toast 会叠成一层：全局 CSS 覆写破坏堆叠
- 【问题描述】[tokens.css](frontend\src\styles\tokens.css#L181-L185) 写死 `.el-message { top: 24px !important; }`，而 Element Plus 靠每个实例内联 top 实现多实例纵向堆叠——`!important` 一刀切后，连续两三条提示（如"提交成功"+"库存不足"）会**重叠在同一位置**。设计 4.6 明确要求"多实例纵向堆叠间距 12px"。
- 【严重程度】P2
- 【改进建议】删掉该覆写，改用 EP 的 `grouping`/`offset` 或接受默认 16px。

### B-12【P2】表单校验只有 toast，不聚焦、不滚动、无 rules
- 【问题描述】商品/供应商/用户/采购单四个表单全是 `el-form` 裸奔（无 `:model`/`:rules`），必填校验靠提交时一个 warning toast 了事（实测空提交商品表单 → toast"请填写完整必填项（名称/SKU/分类/单位）"，光标原地不动）。UI-DESIGN 7.2 承诺"提交后自动 focus 到第一个错误项"，完全未实现；弹窗内也不支持 Enter 提交。
- 【严重程度】P2
- 【改进建议】接入 el-form rules 体系，提交失败 focus 第一错误项；单行输入框 Enter 提交。

### B-13【P2】取消采购单弹窗：两个"取消"按钮打架
- 【问题描述】取消原因弹窗 footer 是 [取消] [确认取消]（[PurchaseOrdersView.vue L374-L380](frontend\src\views\PurchaseOrdersView.vue#L374-L380)）。左边"取消"= 放弃取消操作，右边"确认取消"= 执行取消——同一屏两个"取消"语义相反，紧张的用户很容易点错。行业惯例是"关闭/放弃"或"再想想"。
- 【严重程度】P2
- 【改进建议】左侧按钮改"再想想"或"放弃操作"。

### B-14【P3】双层 transition 无 out-in，路由切换瞬间新旧页面同屏
- 【问题描述】[App.vue](frontend\src\App.vue#L11-L15) 与 [MainLayout.vue](frontend\src\layouts\MainLayout.vue#L229-L234) 都包了 `<transition name="page">`，均未设置 `mode="out-in"`——切页瞬间新旧两个页面组件同时存在于文档流（各自 220ms 位移），内容区出现一次可感知的"双页跳动"，越长越明显的页面越明显。
- 【严重程度】P3
- 【改进建议】内层 transition 加 `mode="out-in"`，外层只在登录/主布局切换时生效。

### B-15【P3】手动改侧栏折叠态，随便拖一下窗口就被重置
- 【问题描述】[MainLayout.vue onResize](frontend\src\layouts\MainLayout.vue#L70-L77)：任何 resize 事件都会按宽度强设 `collapsed`——1024~1279 区间手动展开侧栏后，拖动 1px 窗口边缘立刻被弹回收起。
- 【严重程度】P3
- 【改进建议】只在跨越断点时重置，尊重用户手动状态。

---

## 三、信息架构与导航（得分 7.0 / 10）

**做对的部分**：七个菜单顺序与设计一致、admin 专属菜单显隐正确、`/purchase-orders/create` 高亮父级菜单（startsWith 匹配）工作正常、路由懒加载拆分到位。以下减分。

### C-1【P2】面包屑是"假面包屑"
- 【问题描述】顶栏只有 "ERP / 数据看板" 两级（实测截图 04），新建采购单页面包屑也只显示"ERP / 新建采购单"，丢了"采购管理"父级。UI-DESIGN 3.1 的面包屑定义是层级路径，PRD 7.1 写明"采购管理 / 新建采购单"。现在它只是个"当前页名复读机"。
- 【严重程度】P2
- 【改进建议】从 route.matched 生成真实层级，create/edit 页补父级。

### C-2【P3】菜单叫"用户管理"，页面标题叫"用户与角色管理"
- 【问题描述】侧栏菜单 [MainLayout.vue L40](frontend\src\layouts\MainLayout.vue#L40) 写"用户管理"，页面内标题是"用户与角色管理"（UsersView）。系统里唯一一个菜单与页头不一致的页面，新人培训时口径分裂。
- 【严重程度】P3
- 【改进建议】统一为"用户管理"。

### C-3【P3】库存流水与实时库存的关系靠"页签"表达，可发现性弱
- 【问题描述】"库存流水"藏在库存页第二个页签，而库存表没有任何一行的"查看流水"入口（例如点某商品直接过滤其流水）。用户查"这个货谁动过"的路径是：切页签 → 远程搜索商品 → 再选一次。成熟 ERP 会从库存行直达流水。
- 【严重程度】P3
- 【改进建议】库存行操作加"流水"文字按钮，跳转页签并自动带上 productId 过滤（API 本来就支持）。

---

## 四、功能完整性与边界场景（得分 5.0 / 10）

### D-1【P0】写权限门禁形同虚设：`void can(...)` 的行为艺术
- 【问题描述】[PurchaseOrderFormView.vue L29-30](frontend\src\views\PurchaseOrderFormView.vue#L29-L30) 写着 `void can(auth.user?.role, 'purchase:write');` ——调用后**丢弃结果**，页面上"保存草稿/提交采购单"按钮对 viewer / stockkeeper 照常渲染。路由表（[router/index.ts](frontend\src\router\index.ts#L29-L30)）也没给 create/edit 加 `meta.roles`。查看员手动输入 `/purchase-orders/create` 即可看到完整可用表单，点提交才吃 403。这直接违反 UI-DESIGN 1.3 原则 3"无权限的操作按钮直接不渲染（非置灰）"和 PRD S6。
- 【严重程度】P0（权限语义层面）
- 【复现】用 viewer 账号登录 → 地址栏输入 /purchase-orders/create。
- 【改进建议】路由 meta.roles 限 purchaser/admin；页面内按钮 v-if 接 `can()`；删掉那行 `void can`。

### D-2【P1】SKU 唯一性预检：模糊搜索取 1 条，漏检是大概率事件
- 【问题描述】[checkSku](frontend\src\views\ProductsView.vue#L162-L174) 用 `listProducts({ page:1, pageSize:1, keyword: form.sku })` 做预检——keyword 是名称/SKU 的 **LIKE %kw% 模糊匹配且只取第 1 条**。只要存在任何"名称里恰好包含该 SKU 子串"或"SKU 更接近关键词排序靠前"的商品排在前面，真正重复的那条根本不在返回里，行内"SKU 已存在"不出现，直到提交时才吃后端 409。预检沦为装饰。
- 【严重程度】P1
- 【复现】造一个名称为 "TEST-001 系列" 的商品，再录入 SKU=TEST-001，失焦无报错。
- 【改进建议】后端加 `GET /api/products/check-sku?sku=` 专用精确接口，前端防抖调用。

### D-3【P1】分类右表 pageSize:100 无分页：超过 100 个商品静默截断
- 【问题描述】[loadCatProducts](frontend\src\views\ProductsView.vue#L285-L299) 写死 `page:1, pageSize:100`，右侧表格无分页器、无总数提示。第 101 个商品起**无声消失**，用户会得出"分类下没几个商品"的错误结论。
- 【严重程度】P1
- 【改进建议】补分页；或至少显示"共 N 件，仅显示前 100"。

### D-4【P1】采购单列表操作列没有"删除"
- 【问题描述】UI-DESIGN 5.5 明确"draft 追加'编辑''删除'（红色）"，实测列表操作列只有 详情/编辑（Playwright 读到 `po_operate_btns = ["PO202609210002", "详情"]`，draft 行多一个编辑），删除只能进抽屉找。少一个高频入口，采购员删草稿要多点两下。
- 【严重程度】P1（承诺未兑现）
- 【位置】[PurchaseOrdersView.vue 操作列](frontend\src\views\PurchaseOrdersView.vue#L279-L286)

### D-5【P1】库存流水"关联单号"不可点击
- 【问题描述】UI-DESIGN 5.6 承诺"采购入库可点击跳转对应采购单详情"，实测流水表关联单号是纯文本（Playwright 探测 `.mono a/button` 数量 = 0）。溯源链路在最关键的一跳断了：看到 +50 是"采购入库"，却点不进去看是哪张单。
- 【严重程度】P1
- 【位置】[InventoryView.vue 流水列](frontend\src\views\InventoryView.vue#L387-L389)
- 【改进建议】ref_type=purchase_order 时渲染文字按钮，点击打开对应抽屉。

### D-6【P2】详情抽屉缺"提交时间/入库时间"字段；采购单无"流转记录"区块
- 【问题描述】UI-DESIGN 5.5 单据信息字段清单含"提交时间、入库时间"，实测抽屉 info 区只有 供应商/创建人/创建时间/入库人/备注（Playwright 实测 `drawer_info_keys`）。另外 PRD 7.2 承诺详情抽屉含"流转记录"，实现里根本没有这个区块——单据改过什么、谁在什么时候提交/入库，只能去翻审计日志。
- 【严重程度】P2
- 【改进建议】补两行时间字段；用 audit_logs 按单号过滤渲染简易时间线。

### D-7【P2】表格无任何排序能力
- 【问题描述】UI-DESIGN 4.3 规定"可排序列头显示双箭头，默认按创建时间倒序"。实测全部 8 张表 0 个 sortable 列；商品列表想按售价/库存排序？没有。金额对账场景只能靠肉眼。PRD FR-02 第 4 条也只承诺时间排序——设计稿承诺了 UI 呈现，实现连 UI 呈现都没有。
- 【严重程度】P2

### D-8【P2】分页器没有"跳页"
- 【问题描述】UI-DESIGN 4.3 分页器规格"总数 + 页码 + 每页条数 + 跳页"。实测所有页 layout=`total, prev, pager, next, sizes`，无 jumper（实测 `共 13 条 1 20条/页`）。万级数据翻到第 300 页的场景（PRD 明确要求支撑 1 万商品）只能连点 300 下。
- 【严重程度】P2
- 【改进建议】layout 加 `jumper`，一行代码的事。

### D-9【P2】强制改密（A01 验收项）现状未触发
- 【问题描述】用 admin/***REMOVED-SEED-PASSWORD*** 登录**直接进入看板**，未出现 mustChangePassword 拦截（Playwright 实测 `must_change=false`）。若当前库是全新种子库，PRD A01"首次登录强制改密"即不通过；若此前人工改过标记，则说明种子脚本与文档不一致。两种情况都该给个说法——毕竟初始密码已写在交付文档里。
- 【严重程度】P2（取决于库状态，但验收口径必须澄清）

### D-10【P3】改密弹窗无校验规则，可空手提交
- 【问题描述】[MainLayout.vue 改密弹窗](frontend\src\layouts\MainLayout.vue#L238-L254)三个输入框只有视觉红星，无 rules；全空点"确定修改"直接发请求等后端 400。且此弹窗与 LoginView 的改密表单是两套重复实现，规则口径（确认一致才前端拦）各管各的。
- 【严重程度】P3
- 【改进建议】抽一个 ChangePasswordForm 组件复用，接 rules。

---

## 五、文案质量（得分 6.5 / 10）

**好的一面**：登录失败统一文案"用户名或密码错误，或账号已被锁定"实测生效（02_login_error.png）；删除确认文案把后果讲清楚（"SKU 不可再被复用"）；后端错误文案直接透出，说人话。减分项如下：

### E-1【P2】"请使用上方商品选择器搜索并添加商品"——说教式文案
- 见 B-10。按钮的职责是"被点了就有用"，不是"被点了教用户用别的按钮"。

### E-2【P2】两个"取消"按钮同屏对峙
- 见 B-13。ERP 用户对"取消"这个词高度敏感（它可能是单据状态），文案必须消歧。

### E-3【P3】按钮/状态术语基本统一，但"入库确认"在不同位置的叫法漂移
- 【问题描述】抽屉操作区叫"入库确认"，确认弹窗标题"入库确认"但按钮"确认入库"，成功 toast"入库成功，库存已更新"——尚可接受；但列表行内没有快捷"入库"入口，必须 进详情 → 滚到底 → 找按钮，库管员批量入库时每单 4 步操作，旺店通这类系统在列表行内直达。
- 【严重程度】P3（文案+效率复合问题）

### E-4【P3】"登 录"中间的空格是玄学
- 【问题描述】登录按钮文案"登 录"（中间全角空格），而"确认修改""提交采购单"都没有类似处理。风格不成体系。
- 【严重程度】P3

---

## 六、专挑刺点（得分：响应式 3.0 / 工程与性能 5.5 / 交付完备 5.0）

### F-1【P0】375px 手机端：720px 抽屉硬塞进 375px 屏幕
- 【问题描述】UI-DESIGN 4.4 / 5.5 双双要求"详情抽屉 ≤768px 全屏"。实测（25_mobile_drawer.png，375×667 viewport）：`.el-drawer` 实际宽度 **720px**，步骤条第一节点"草稿"被截出屏幕左缘，供应商/创建时间/备注等字段在右侧被切掉，明细表只能靠整页横向滚动摸黑看。PRD A20 验收项（375 走查全部页面无错乱）在此页直接爆雷。
- 【严重程度】P0
- 【复现】手机或 DevTools 375px → 采购管理 → 任意详情。
- 【改进建议】`<el-drawer :size="isMobile ? '100%' : '720px'">`，加上 4.4 要求的遮罩与关闭策略。

### F-2【P1】Element Plus / ECharts 全量引入：懒加载是形式主义
- 【问题描述】pnpm build 实测产物：`index.js 1,135KB（gzip 376KB）`（Element Plus 全量注册进主包）、`DashboardView.js 1,132KB（gzip 381KB）`（`import * as echarts from 'echarts'` 全量进看板 chunk）。PRD 4.1"单 JS chunk gzip ≤1MB"字面上压线达标，但"路由懒加载拆分"的本意被架空：主包塞满全站用不用得到的组件，看板 chunk 被 ECharts 撑到 1.1MB raw。低带宽内网/移动热点的 FCP 会明显劣化。
- 【严重程度】P1
- 【位置】[main.ts](frontend\src\main.ts#L11-L23)、[DashboardView.vue L15](frontend\src\views\DashboardView.vue#L15)
- 【改进建议】`unplugin-vue-components` 按需引入 EP；ECharts 改 `echarts/core` + BarChart/CanvasRenderer 按需注册（看板 chunk 预期可降 60%+）。

### F-3【P1】顶栏铃铛每次路由跳转都打一次看板统计接口
- 【问题描述】[MainLayout.vue](frontend\src\layouts\MainLayout.vue#L142) `watch(() => route.path, () => refreshBadge())`——切 7 个菜单 = 7 次 `/dashboard/stats` 请求，只为刷一个角标；同时 InventoryView 只在 lowStock 开启时反向写 `auth.lowStockCount`（[InventoryView.vue L70](frontend\src\views\InventoryView.vue#L70)），角标数据源两处互相覆盖。
- 【严重程度】P1（性能 + 数据一致性双输）
- 【改进建议】角标在库存写操作后定点刷新，或 60s 轮询一次，删掉路由 watch。

### F-4【P2】"随机生成"密码用的是 Math.random
- 【问题描述】[UsersView.vue genPassword](frontend\src\views\UsersView.vue#L53-L61) 用 `Math.random()` 生成 16 位"强密码"——非密码学安全随机源，可预测性在安全审计里是扣分项；另外初始密码以明文 value 直接暴露在 DOM input 里（自动化脚本一行就抠出来了：`%ZE78pYphjUBgwNa`）， shoulder-surfing 风险顺手提一下。
- 【严重程度】P2
- 【改进建议】`crypto.getRandomValues`；生成后默认密文展示 + "显示"切换。

### F-5【P2】十个页面复制粘贴出 200 行同构代码，没有任何列表抽象
- 【问题描述】`.w-240/.filter-card/.table-card/.pager/.tag/.skeleton/.row-sk` 这套样式与"首载骨架/v-loading/分页 onSizeChange 回第1页"逻辑在 8 个页面各抄一遍（对比 ProductsView / SuppliersView / InventoryView 的 style 块，几乎逐行相同）。改一个分页间距要动 8 个文件——这不是"简洁"，是维护炸弹。
- 【严重程度】P2
- 【改进建议】抽 `<ProTable>`（columns 配置 + 筛选插槽 + 空态/错误态内置），本系统页面结构高度一致，正是抽象的最佳场景。

### F-6【P2】PRD 与 UI-DESIGN 互相打架，交付口径不清
- 【问题描述】PRD 2.2 权限矩阵承诺审计日志"查看/筛选/**导出**"（admin），PRD FR-08 也写了导出；UI-DESIGN 5.8 又说"本期不提供导出按钮"。实现按后者执行 → 系统交付时管理员连操作日志都导不出来，出了事要靠肉眼翻页对账。这属于需求文档内讧，砍掉的是 admin 最需要的取证能力。
- 【严重程度】P2
- 【改进建议】至少给审计日志一个 CSV 导出（后端流式，10 行代码级别）。

### F-7【P3】全站无键盘可达性：菜单/页签/树节点都是裸 div
- 【问题描述】侧栏菜单（MainLayout）、页面页签（商品/库存）、分类树节点全是 `div + @click`，无 tabindex/role/Enter 处理；`focus-visible` 样式倒是写了，但根本 focus 不进去。铃铛、树节点图标无 `aria-label`（设计 7.4 点名要求）。设计稿 7.2"纯键盘可完成：登录→查商品→新增弹窗→Esc 关闭"实测前两步就卡死（菜单 Tab 不可达）。
- 【严重程度】P3（对内网工具可容忍，但承诺了就别食言）

### F-8【P3】无快捷键、无暗色模式、无列配置、无批量操作、无 Excel 导入导出、无打印
- 【问题描述】对照成熟 ERP 的"效率三件套"：① 商品批量导入 Excel（初始化 1000 个 SKU 只能一条条填弹窗）；② 表格批量勾选操作（批量停用/删除）；③ 任何打印/导出。另外 0 快捷键（连 `/` 聚焦搜索都没有）、0 暗色模式、0 表格列自定义。作为"中小企业零成本方案"可以理解缩量，但商品导入缺失是实打实的上手门槛——录 100 个商品的时间成本足以劝退目标用户。
- 【严重程度】P3（本期范围）→ 产品化后为 P1

---

## 七、对标行业：用友 / 金蝶 / 旺店通 视角

| 维度 | 成熟产品的做法 | 本系统现状 | 差距定性 |
| --- | --- | --- | --- |
| 单据可信度 | 单号/金额/时间三要素永远可见、可打印 | 已入库单合计"¥—"、无单号（B-1） | **业余 vs 及格线** |
| 批量效率 | 商品 Excel 导入、批量启停、条码扫描 | 全部单条操作 | 初始化成本高一个数量级 |
| 溯源链路 | 流水 ↔ 单据 ↔ 操作人三向跳转 | 流水单号不可点、无流转记录区块 | 只有一半 |
| 状态机安全感 | 非法流转按钮置灰 + 原因提示 | 按钮渲染靠权限、403 兜底（D-1） | 把后端当 UI |
| 错误韧性 | 断网重试、错误码地图、操作可撤销 | 错误伪装空态、全站 0 处撤销（删除即终局） | 原始时代 |
| 培训成本 | 角色工作台（采购员进来只看采购） | 全菜单平铺 + 按权限藏按钮，viewer 也能点进 create 页 | 心智负担外溢给用户 |

一句话：功能骨架是对的，但**所有"最后一公里"的交付习惯（契约对齐、错误路径、响应式收尾、效率入口）都差着一口气**——这正是"demo 级"与"可卖给客户"之间的鸿沟。

---

## 八、总评分（10 分制）

| 维度 | 得分 | 一句话理由 |
| --- | ---: | --- |
| UI 审美 | 6.0 | 干净克制但模板化，裸色值/行高/登录卡尺寸暴露"规范只是贴在墙上" |
| 交互体验 | 4.5 | 错误态伪装空态、死链接、假按钮、错误挂错字段、toast 叠层 |
| 信息架构 | 7.0 | 骨架清晰、权限显隐大方向对；假面包屑、页名不一致 |
| 功能完整性 | 5.0 | 详情抽屉字段断链是硬伤；预检/流水跳转/行内删除/流转记录缺位 |
| 文案质量 | 6.5 | 整体说人话；双"取消"歧义与说教文案扣分 |
| 响应式适配 | 3.0 | 375px 抽屉灾难级；桌面端尚可 |
| 性能与工程 | 5.5 | 双 1.1MB 全量包、200 行复制粘贴、Math.random、每跳一次刷一次角标 |
| 安全基线 | 7.0 | bcrypt/JWT/限流/统一文案达标；Math.random 与权限 UI 越权扣分 |
| 文档说到做到 | 4.0 | 设计稿高频承诺（跳页/排序/四类空态/键盘/全屏抽屉/题材插图）大面积未兑现 |
| **总分** | **5.4 / 10** | **骨架合格、交付粗糙，"演示能过、上线必翻车"** |

---

## 九、如果只允许改 5 件事（按 ROI 排序）

1. **修采购详情字段契约（B-1 / P0）**：后端详情接口 snake_case → camelCase 对齐（或 axios 全局转换）。半小时工作量，救回单号/金额/时间三个核心信任要素，全系统可信度直接回到及格线。
2. **EmptyState 补 import + 全站"错误≠空态"分流（B-2 / B-3）**：一行 import 消掉用户页天窗与控制台报警；五个列表 catch 里区分错误，接入"加载失败 + 重试"空态变体。
3. **弹窗/抽屉响应式兜底（F-1）**：抽屉 ≤768px 切 100% 宽、弹窗 `calc(100vw - 32px)` 字段单列。PRD A20 是 P0 验收项，不改就是验收当场爆雷。
4. **权限门禁真实化（D-1）**：create/edit 路由加 `meta.roles`，采购表单按钮接 `can()`，删除 `void can` 这行行为艺术；顺带把 D-2 的 SKU 预检改成专用精确接口。
5. **列表体验三件套（D-5 / D-7 / D-8）**：分页加 jumper、流水关联单号可点击跳单据、商品列表补"排序 + 行内删除草稿"入口。三个都是小改动，但直接决定库管/采购员每天几百次的操作手感。

---

### 附：实测证据索引

| 证据 | 文件/数据 |
| --- | --- |
| 登录页视觉与统一文案 | 01b_login_recheck.png、02_login_error.png |
| 看板数值（13/723/3/¥4205.00）与铃铛角标联动 | 04_after_login.png、05_inventory_lowstock_jump.png |
| 采购详情断链（无单号/¥—/时间—） | 12_po_drawer.png、25_mobile_drawer.png、curl `GET /api/purchase-orders/2` 原始响应 |
| 手机端抽屉 720px 溢出 | 25_mobile_drawer.png（drawer width 实测 720） |
| 用户页空态开天窗 + 控制台告警 | 19_users_empty_broken.png（.empty-state 计数 = 0）、console `[Vue warn] Failed to resolve component: EmptyState` |
| 审计日志死链接 | stage2b 实测 `detail_link_expanded = 0` |
| 构建产物体积 | pnpm build 输出：index.js 1,135KB / DashboardView.js 1,132KB（raw） |
