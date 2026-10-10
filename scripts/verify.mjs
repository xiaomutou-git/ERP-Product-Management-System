/**
 * 后端核心链路验证脚本（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：按 PRD 验收标准验证核心链路——健康检查、登录（Set-Cookie 方式）、
 *          强制改密、改密后旧会话失效、refresh 换新（凭 Cookie）、商品 CRUD/SKU 唯一、
 *          采购单创建/提交/入库、库存联动与流水、RBAC 越权拦截、登录锁定与解锁、
 *          看板统计、审计日志；覆盖安全加固断言：登录 Set-Cookie 含 HttpOnly
 *          双 Cookie 且响应 JSON 不含 token 明文、伪造 Origin 写操作被 CSRF 403；
 *          并覆盖第二批安全加固（2026-09-24）：refresh 轮换与重放防护
 *          （旧令牌二次使用 401、全端撤销、审计日志留痕）、未知 jti 伪造令牌 401、
 *          登出 jti 置 revoked（直查 SQLite）、限流计数器 SQLite 共享存储
 *          （打满 429 + rate_limit_hits 表计数第二连接可见）；
 *          以及第三批安全加固（2026-09-24）：refresh 轮换宽限窗口（多 tab 并发
 *          竞态修复）——宽限窗口内旧令牌复用返回 200 不触发全端撤销（会话仍可用、
 *          叶子令牌仍 active）、审计留痕 refresh_grace_reuse、窗口过期后复用触发
 *          重放防护（401 + refresh_replay_detected + 全端撤销）、revoked 状态无宽限
 *          （登出后旧令牌再刷直接 401）。
 * 设计思路：使用 Node 22 原生 fetch；登录响应 Set-Cookie 自动提取进本地 cookie jar，
 *          后续请求以 Cookie 头携带（后端同时兼容 Bearer 头平滑过渡）；每个账号仅
 *          登录一次并复用 Cookie；写操作默认携带合法 Origin 通过 CSRF 校验；
 *          锁定测试安排在 60 秒后的新限流窗口执行；每步校验 HTTP 状态与业务码，
 *          失败打印 FAIL 并以非零码退出。部分断言以只读连接直查 backend/data/erp.db
 *          验证服务端状态（refresh_tokens / rate_limit_hits 表）。
 *          宽限窗口断言依赖后端实际宽限期：脚本优先读取 VERIFY_GRACE_SECONDS 环境
 *          变量、其次 backend/.env 的 REFRESH_GRACE_PERIOD_SECONDS（默认 30 秒），
 *          用于计算"等待宽限过期"的睡眠时长（需大于后端实际宽限窗口）；
 *          建议测试时以短宽限期启动后端（如 REFRESH_GRACE_PERIOD_SECONDS=3）并
 *          以 VERIFY_GRACE_SECONDS=3 运行本脚本，缩短总耗时。
 * 适用场景：node scripts/verify.mjs（后端服务需已启动在 3001 端口）。
 * 创建时间：2026-09-21（2026-09-24 安全加固：cookie 会话 + CSRF；
 *          2026-09-24 第二批：refresh 轮换/重放防护 + SQLite 共享限流断言）
 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const BASE = 'http://localhost:3001';
/** dev 环境 CSRF 允许的合法 Origin（与后端 CORS_ORIGIN 一致） */
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
/** 伪造的非法 Origin（用于 CSRF 断言） */
const EVIL_ORIGIN = 'https://evil.attacker.example';
let passCount = 0;
let failCount = 0;

/**
 * 输出用例结果
 * @param {string} name  用例名称
 * @param {boolean} pass 是否通过
 * @param {unknown} [info] 附加信息（截断打印）
 * @returns {void}
 */
function report(name, pass, info) {
  if (pass) {
    passCount++;
    console.log(`  PASS  ${name}`);
  } else {
    failCount++;
    console.log(`  FAIL  ${name}  ${info ? JSON.stringify(info).slice(0, 300) : ''}`);
  }
}

/**
 * 从 Set-Cookie 响应头解析键值对（仅取 name=value，忽略属性）
 * @param {string[] | string | undefined} setCookie Set-Cookie 头（可能单个字符串或数组）
 * @returns {Record<string, string>} cookie 键值对
 */
function parseSetCookie(setCookie) {
  const out = {};
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  for (const c of list) {
    const pair = c.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx > 0) {
      out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return out;
}

/**
 * 将 cookie 键值对序列化为请求头 Cookie 值
 * @param {Record<string, string>} jar cookie 键值对
 * @returns {string} 形如 "a=1; b=2"
 */
function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 发起 API 请求（自动维护 Cookie 与 Origin）
 * @param {string} method HTTP 方法
 * @param {string} path   接口路径（含查询串）
 * @param {object} [opts] { jar: cookie键值对, body: unknown, origin: 自定义Origin头, noOrigin: 不带Origin }
 * @returns {Promise<{status:number, json:any, cookies:Record<string,string>, headers:Headers}>} 响应
 * @throws {Error} 网络异常时抛出（fetch reject）
 */
async function api(method, path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  // 写操作默认携带合法 Origin 通过 CSRF 校验（除非显式指定 origin 或 noOrigin）
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (opts.origin !== undefined) headers['Origin'] = opts.origin;
    else if (!opts.noOrigin) headers['Origin'] = ALLOWED_ORIGIN;
  }
  if (opts.jar && Object.keys(opts.jar).length) headers['Cookie'] = cookieHeader(opts.jar);
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应保持 null */ }
  const cookies = parseSetCookie(res.headers.getSetCookie ? res.headers.getSetCookie() : res.headers.get('set-cookie'));
  return { status: res.status, json, cookies, headers: res.headers };
}

/**
 * 登录并返回 { jar, user }（jar 为 Set-Cookie 提取的令牌键值对）
 * @param {string} username 用户名
 * @param {string} password 密码
 * @returns {Promise<any>} { jar, user }；失败时为 null
 * @throws {Error} 网络异常时抛出
 */
async function login(username, password) {
  const r = await api('POST', '/api/auth/login', { body: { username, password } });
  if (!r.json?.data) return null;
  return { jar: r.cookies, user: r.json.data.user };
}

/**
 * 解码 JWT payload（不验签，仅读取声明，用于获取 sub/tv/jti 构造伪造令牌断言）
 * @param {string | undefined} token JWT 字符串
 * @returns {Record<string, unknown> | null} payload 对象；解析失败返回 null
 */
function decodeJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 使用 HS256 手工签发 JWT（用于构造"签名合法但 jti 不存在"的伪造令牌断言，
 * 密钥取自 backend/.env 的 JWT_SECRET，与后端同源）
 * @param {Record<string, unknown>} payload JWT 载荷
 * @param {string} secret HS256 签名密钥
 * @returns {string} JWT 字符串
 */
function craftJwt(payload, secret) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/**
 * 读取 backend/.env 中的配置项（供伪造令牌签名与只读数据库路径解析使用）
 * @param {string} key 配置项名称（如 JWT_SECRET / DB_PATH）
 * @returns {string | undefined} 配置值；文件不存在或未配置返回 undefined
 */
function readBackendEnv(key) {
  try {
    const content = readFileSync(new URL('../backend/.env', import.meta.url), 'utf8');
    const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}
/**
 * 种子账号口令：优先读环境变量 SEED_*_PASSWORD，其次读种子脚本写出的
 * backend/data/seed-credentials.txt（backend/data/ 已被 .gitignore 排除）。
 * 仓库内不再保存任何默认口令明文。
 * @returns {Record<string, string>} 用户名 -> 口令
 */
const SEED_PASSWORDS = (function loadSeedPasswords() {
  const map = {};
  try {
    const txt = readFileSync(new URL('../backend/data/seed-credentials.txt', import.meta.url), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_]+)=(\S+)$/);
      if (m) map[m[1]] = m[2];
    }
  } catch { /* 文件不存在时改用环境变量 */ }
  const env = {
    admin: process.env.SEED_ADMIN_PASSWORD,
    purchaser01: process.env.SEED_PURCHASER_PASSWORD,
    stocker01: process.env.SEED_STOCKER_PASSWORD,
    viewer01: process.env.SEED_VIEWER_PASSWORD,
  };
  for (const [k, val] of Object.entries(env)) if (val) map[k] = val;
  return map;
})();

const ADMIN_PASSWORD = SEED_PASSWORDS.admin;
const PURCHASER_PASSWORD = SEED_PASSWORDS.purchaser01;
const STOCKER_PASSWORD = SEED_PASSWORDS.stocker01;
const VIEWER_PASSWORD = SEED_PASSWORDS.viewer01;

if (!ADMIN_PASSWORD || !PURCHASER_PASSWORD || !STOCKER_PASSWORD || !VIEWER_PASSWORD) {
  console.error('缺少种子账号口令：请先启动后端完成种子（会生成 backend/data/seed-credentials.txt），');
  console.error('或显式设置 SEED_ADMIN_PASSWORD / SEED_PURCHASER_PASSWORD / SEED_STOCKER_PASSWORD / SEED_VIEWER_PASSWORD。');
  process.exit(2);
}


/**
 * 以只读连接打开 backend 数据库（WAL 模式支持与在线服务并发读取，
 * 用于断言 refresh_tokens 状态与 rate_limit_hits 共享计数）
 * @returns {import('better-sqlite3').Database} 只读数据库连接（调用方负责 close）
 * @throws {Error} better-sqlite3 加载失败或库文件不存在时抛出
 */
function openReadonlyDb() {
  const Database = createRequire(new URL('../backend/package.json', import.meta.url))('better-sqlite3');
  const backendDir = fileURLToPath(new URL('../backend/', import.meta.url));
  const dbFile = path.resolve(backendDir, readBackendEnv('DB_PATH') || 'data/erp.db');
  return new Database(dbFile, { readonly: true, fileMustExist: true });
}

/* ======================= 主流程 ======================= */
/**
 * 验证用宽限窗口秒数：用于计算"等待宽限过期"的睡眠时长（必须大于后端实际宽限窗口，
 * 否则断言 39/47 的窗口外重放会落入宽限放行分支导致断言失败）。
 * 取值优先级：VERIFY_GRACE_SECONDS 环境变量 > backend/.env 的 REFRESH_GRACE_PERIOD_SECONDS > 默认 30。
 * @returns {number} 宽限窗口秒数（非负整数；非法值回退默认 30）
 */
const VERIFY_GRACE_SECONDS = (function resolveVerifyGraceSeconds() {
  const raw = parseInt(process.env.VERIFY_GRACE_SECONDS || readBackendEnv('REFRESH_GRACE_PERIOD_SECONDS') || '30', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30;
})();

console.log('== ERP 后端核心链路验证（HttpOnly Cookie 会话） ==');

// 1. 健康检查
{
  const r = await api('GET', '/api/health');
  report('健康检查 /api/health', r.status === 200 && r.json?.code === 0, r.json);
}

// 2. 管理员登录（种子：首登强制改密）——组合校验 Set-Cookie 安全属性与 JSON 无 token 明文
const adminFirst = await login('admin', ADMIN_PASSWORD);
{
  const r = await api('POST', '/api/auth/login', { body: { username: 'admin', password: ADMIN_PASSWORD } });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  const hasHttpOnlyAccess = sc.some((c) => c.startsWith('erp_access_token=') && /httponly/i.test(c) && /samesite=lax/i.test(c) && /path=\//i.test(c));
  const hasHttpOnlyRefresh = sc.some((c) => c.startsWith('erp_refresh_token=') && /httponly/i.test(c) && /path=\/api\/auth/i.test(c));
  const jsonHasToken = 'accessToken' in (r.json?.data || {}) || 'refreshToken' in (r.json?.data || {});
  report('管理员登录成功：Set-Cookie 下发 HttpOnly 双 Cookie（refresh 路径收窄 /api/auth）且 JSON 无 token 明文 + 首登强制改密标记=1',
    r.status === 200 && hasHttpOnlyAccess && hasHttpOnlyRefresh && !jsonHasToken && adminFirst?.user?.mustChangePassword === true,
    { setCookie: sc, data: r.json?.data, user: adminFirst?.user });
}

// 3. 未改密前业务接口 403
{
  const r = await api('GET', '/api/products?page=1&pageSize=20', { jar: adminFirst.jar });
  report('未改密前业务接口返回 403', r.status === 403 && r.json?.code === 1003, r.json);
}

// 4. 改密
{
  const r = await api('PUT', '/api/auth/password', { jar: adminFirst.jar, body: { oldPassword: ADMIN_PASSWORD, newPassword: ADMIN_PASSWORD } });
  report('修改本人密码成功', r.status === 200 && r.json?.code === 0, r.json);
}

// 5. 旧会话失效（token_version 已 +1）
{
  const r = await api('GET', '/api/auth/me', { jar: adminFirst.jar });
  report('改密后旧 access cookie 返回 401', r.status === 401 && r.json?.code === 1002, r.json);
}

// 6. 新密码重新登录
const admin = await login('admin', ADMIN_PASSWORD);
report('改密后重新登录成功且改密标记已清除', admin?.user?.mustChangePassword === false, admin?.user);

// 7. refresh 凭 Cookie 换新 access token（无需 body 传 refreshToken）
{
  const r = await api('POST', '/api/auth/refresh', { jar: admin.jar });
  const newAccess = r.cookies?.erp_access_token;
  report('refresh 凭 Cookie 换取新 access token（Set-Cookie 下发）', r.status === 200 && r.json?.code === 0 && typeof newAccess === 'string' && newAccess.length > 0, { code: r.json?.code, hasNewCookie: !!newAccess });
  // 2026-09-24 轮换加固后 /refresh 会同时下发全新 refresh Cookie（滑动续期），
  // 与浏览器行为一致地把新 Cookie 同步进本地罐，供后续步骤复用
  Object.assign(admin.jar, r.cookies);
}

// 8. 商品列表（种子 12 条）
{
  const r = await api('GET', '/api/products?page=1&pageSize=20', { jar: admin.jar });
  report('商品分页列表返回 12 条种子数据', r.status === 200 && r.json?.data?.total === 12, r.json?.data?.total);
}

// 9. SQL 注入串搜索不报错
{
  const r = await api('GET', `/api/products?keyword=${encodeURIComponent("' OR 1=1 --")}`, { jar: admin.jar });
  report("SQL 注入串搜索正常返回（参数化查询）", r.status === 200 && r.json?.code === 0, r.json);
}

// 10. 分类树
{
  const r = await api('GET', '/api/categories', { jar: admin.jar });
  report('分类树返回 3 个一级分类', r.status === 200 && r.json?.data?.length === 3, r.json?.data?.map?.((c) => c.name));
}

// 11. 创建商品 TEST-001
let testProductId = 0;
{
  const cats = await api('GET', '/api/categories', { jar: admin.jar });
  const catId = cats.json?.data?.[0]?.id;
  const r = await api('POST', '/api/products', {
    jar: admin.jar,
    body: { name: '验证测试商品', sku: 'TEST-001', categoryId: catId, unit: '个', salePrice: 1500, warnThreshold: 3 },
  });
  testProductId = r.json?.data?.id || 0;
  report('创建商品 TEST-001 成功', r.status === 200 && testProductId > 0, r.json);
}

// 12. 唯一性约束：重复 SKU 与供应商重名均返回 409
{
  const cats = await api('GET', '/api/categories', { jar: admin.jar });
  const dupSku = await api('POST', '/api/products', {
    jar: admin.jar,
    body: { name: '重复 SKU 商品', sku: 'TEST-001', categoryId: cats.json?.data?.[0]?.id, unit: '个' },
  });
  const dupSupplier = await api('POST', '/api/suppliers', { jar: admin.jar, body: { name: '深圳华强电子有限公司' } });
  report('唯一性约束：重复 SKU 与供应商重名均返回 409',
    dupSku.status === 409 && dupSku.json?.code === 1005 && dupSupplier.status === 409 && dupSupplier.json?.code === 1005,
    { dupSku: dupSku.json, dupSupplier: dupSupplier.json });
}

// ===== 一次性登录其余三个角色，后续全部复用 Cookie =====
const purchaser = await login('purchaser01', PURCHASER_PASSWORD);
const stocker = await login('stocker01', STOCKER_PASSWORD);
const viewer = await login('viewer01', VIEWER_PASSWORD);

// 13. 演示账号登录成功
report('演示账号 purchaser01/stocker01/viewer01 登录成功',
  !!purchaser?.jar && !!stocker?.jar && !!viewer?.jar, null);

// 14. 采购员越权：创建商品应 403
{
  const cats = await api('GET', '/api/categories', { jar: admin.jar });
  const r = await api('POST', '/api/products', { jar: purchaser.jar, body: { name: 'x', sku: 'TEST-DENY', categoryId: cats.json?.data?.[0]?.id, unit: '个' } });
  report('采购员创建商品被 403 拒绝', r.status === 403, r.json);
}

// 15. 查看员越权：创建供应商应 403
{
  const r = await api('POST', '/api/suppliers', { jar: viewer.jar, body: { name: '越权供应商' } });
  report('查看员创建供应商被 403 拒绝', r.status === 403, r.json);
}

// 16. 采购员创建采购单（TEST-001 x5 @100分）
let orderId = 0;
let orderNo = '';
{
  const sups = await api('GET', '/api/suppliers', { jar: purchaser.jar });
  const supId = sups.json?.data?.list?.[0]?.id;
  const r = await api('POST', '/api/purchase-orders', {
    jar: purchaser.jar,
    body: { supplierId: supId, remark: '验证链路', items: [{ productId: testProductId, quantity: 5, unitPrice: 100 }] },
  });
  orderId = r.json?.data?.id || 0;
  orderNo = r.json?.data?.orderNo || '';
  report(`采购员创建采购单成功（单号 ${orderNo}）`, r.status === 200 && orderId > 0 && /^PO\d{12}$/.test(orderNo), r.json);
}

// 17. 库管越权：提交采购单应 403
{
  const r = await api('POST', `/api/purchase-orders/${orderId}/submit`, { jar: stocker.jar });
  report('库存管理员提交采购单被 403 拒绝', r.status === 403, r.json);
}

// 18. 采购员提交采购单
{
  const r = await api('POST', `/api/purchase-orders/${orderId}/submit`, { jar: purchaser.jar });
  report('采购员提交采购单成功（draft -> submitted）', r.status === 200 && r.json?.data?.status === 'submitted', r.json);
}

// 19. 提交后编辑应 400
{
  const r = await api('PUT', `/api/purchase-orders/${orderId}`, {
    jar: purchaser.jar,
    body: { supplierId: 1, items: [{ productId: testProductId, quantity: 1, unitPrice: 1 }] },
  });
  report('已提交采购单编辑被 400 拒绝', r.status === 400 && r.json?.code === 1006, r.json);
}

// 20. 采购员入库被 403 拒绝
{
  const r = await api('POST', `/api/purchase-orders/${orderId}/receive`, { jar: purchaser.jar });
  report('采购员入库确认被 403 拒绝', r.status === 403, r.json);
}

// 21. 入库前库存快照
let beforeQty = 0;
{
  const r = await api('GET', '/api/inventory?page=1&pageSize=100', { jar: admin.jar });
  const row = r.json?.data?.list?.find((x) => x.productId === testProductId);
  beforeQty = row?.quantity ?? 0;
  report(`读取入库前库存快照（当前 ${beforeQty}）`, r.status === 200 && row !== undefined, row);
}

// 22. 库管入库确认（事务内加库存+写流水）
{
  const r = await api('POST', `/api/purchase-orders/${orderId}/receive`, { jar: stocker.jar });
  report('库存管理员入库确认成功（submitted -> received）', r.status === 200 && r.json?.data?.status === 'received', r.json);
}

// 23. 重复入库幂等：再次入库返回 400
{
  const r = await api('POST', `/api/purchase-orders/${orderId}/receive`, { jar: stocker.jar });
  report('重复入库返回 400（幂等保护）', r.status === 400 && r.json?.code === 1006, r.json);
}

// 24. 入库后库存 +5
{
  const r = await api('GET', '/api/inventory?page=1&pageSize=100', { jar: admin.jar });
  const row = r.json?.data?.list?.find((x) => x.productId === testProductId);
  report(`入库后库存由 ${beforeQty} 变为 ${row?.quantity}（+5）`, row?.quantity === beforeQty + 5, row);
}

// 25. 库存流水新增"采购入库"记录
{
  const r = await api('GET', `/api/inventory/logs?productId=${testProductId}`, { jar: admin.jar });
  const row = r.json?.data?.list?.[0];
  report('库存流水生成采购入库记录（+5，前后数量正确）',
    r.status === 200 && row?.type === 'purchase_in' && row?.quantity === 5 && row?.beforeQuantity === beforeQty && row?.afterQuantity === beforeQty + 5 && row?.refNo === orderNo, row);
}

// 26. 手动出库超量 400
{
  const r = await api('POST', '/api/inventory/adjust', {
    jar: stocker.jar,
    body: { productId: testProductId, type: 'manual_out', quantity: 99999, reason: '超量出库测试' },
  });
  report('手动出库超量返回 400 库存不足', r.status === 400 && r.json?.message === '库存不足', r.json);
}

// 27. 手动入库 +10（盘点补录）
{
  const r = await api('POST', '/api/inventory/adjust', {
    jar: stocker.jar,
    body: { productId: testProductId, type: 'manual_in', quantity: 10, reason: '盘点补录' },
  });
  report('手动入库 +10 成功且流水写入', r.status === 200 && r.json?.data?.quantityAfter === beforeQty + 15, r.json);
}

// 28. 修改预警阈值后低库存筛选即时生效
{
  const set = await api('PUT', `/api/inventory/${testProductId}/threshold`, { jar: stocker.jar, body: { warnThreshold: 0 } });
  const list = await api('GET', '/api/inventory?lowStock=true&page=1&pageSize=100', { jar: admin.jar });
  const found = list.json?.data?.list?.some((x) => x.productId === testProductId);
  report('阈值改为 0 后不再出现在低库存筛选', set.status === 200 && !found, { set: set.json?.code, found });
}

// 29. 看板统计
{
  const r = await api('GET', '/api/dashboard/stats', { jar: admin.jar });
  const d = r.json?.data || {};
  const okShape = r.status === 200 && typeof d.productCount === 'number' && typeof d.totalStock === 'number'
    && typeof d.lowStockCount === 'number' && Array.isArray(d.purchaseAmount7d) && d.purchaseAmount7d.length === 7;
  report('看板统计返回 4 项指标与 7 日趋势（空数据日补 0）', okShape, d);
}

// 30. 有库存的商品删除被 400 拒绝
{
  const r = await api('DELETE', `/api/products/${testProductId}`, { jar: admin.jar });
  report('有库存商品删除被 400 拒绝（库存约束）', r.status === 400 && r.json?.code === 1006, r.json);
}

// 31. 审计日志（仅管理员可读）
{
  const r = await api('GET', '/api/audit-logs?page=1&pageSize=5', { jar: admin.jar });
  report('审计日志分页返回（管理员）', r.status === 200 && r.json?.data?.total > 0, r.json?.data?.total);
}

// 32. viewer 访问审计日志 403
{
  const r = await api('GET', '/api/audit-logs', { jar: viewer.jar });
  report('查看员访问审计日志被 403 拒绝', r.status === 403, r.json);
}

// 33. 未携带 token 401
{
  const r = await api('GET', '/api/products');
  report('未携带 token 返回 401', r.status === 401 && r.json?.code === 1002, r.json);
}

// 34. CSRF 防护：伪造 Origin 写操作返回 403
{
  const r = await api('POST', '/api/suppliers', { jar: admin.jar, origin: EVIL_ORIGIN, body: { name: 'CSRF 测试供应商' } });
  report('伪造 Origin 写操作被 CSRF 防护 403 拒绝', r.status === 403 && r.json?.code === 1003, r.json);
}

// ===== 登录锁定测试：等待 60 秒进入新限流窗口 =====
console.log('  （等待 60 秒以进入登录限流新窗口）');
await new Promise((r) => setTimeout(r, 61000));

// 35. 连续 5 次错误密码后锁定；第 6 次正确密码返回 423
{
  for (let i = 0; i < 5; i++) {
    await api('POST', '/api/auth/login', { body: { username: 'viewer01', password: 'WrongPwd1' } });
  }
  const sixth = await api('POST', '/api/auth/login', { body: { username: 'viewer01', password: VIEWER_PASSWORD } });
  report('连续 5 次错误后正确密码登录返回 423 锁定', sixth.status === 423 && sixth.json?.code === 1007, sixth.json);
}

// 36. 管理员解锁后正常登录 + 登出清除 Cookie + 登出后会话失效
{
  const users = await api('GET', '/api/users?keyword=viewer01', { jar: admin.jar });
  const uid = users.json?.data?.list?.[0]?.id;
  const unlock = await api('POST', `/api/users/${uid}/unlock`, { jar: admin.jar });
  await new Promise((r) => setTimeout(r, 61000)); // 再次等新窗口避免 429 干扰
  const relogin = await login('viewer01', VIEWER_PASSWORD);
  // 登出：两类 Cookie 应被清除（Set-Cookie maxAge=0/立即过期）
  const logoutRes = await api('POST', '/api/auth/logout', { jar: relogin.jar });
  const sc = logoutRes.headers.getSetCookie ? logoutRes.headers.getSetCookie() : [logoutRes.headers.get('set-cookie')].filter(Boolean);
  const accessCleared = sc.some((c) => /erp_access_token=;/i.test(c) && (/max-age=0/i.test(c) || /expires=thu,\s*01\s+jan\s+1970/i.test(c)));
  const refreshCleared = sc.some((c) => /erp_refresh_token=;/i.test(c) && (/max-age=0/i.test(c) || /expires=thu,\s*01\s+jan\s+1970/i.test(c)));
  // 登出使 token_version+1，旧会话 Cookie 再访问应 401
  const meAfterLogout = await api('GET', '/api/auth/me', { jar: relogin.jar });
  report('管理员解锁后账号可正常登录 + 登出清除两类 Cookie + 登出后会话失效',
    unlock.status === 200 && !!relogin?.jar && accessCleared && refreshCleared && meAfterLogout.status === 401,
    { unlock: unlock.json?.code, reloginOk: !!relogin?.jar, accessCleared, refreshCleared, meAfterLogout: meAfterLogout.status });
}

/* ======================= 第二批安全加固断言（2026-09-24）：refresh 轮换 + 重放防护 + SQLite 共享限流 ======================= */
console.log('== 第二批安全加固断言（refresh 轮换 / 重放检测 / SQLite 共享限流） ==');

// 37. refresh 轮换：/refresh 返回全新 refresh Cookie 且与旧值不同（滑动续期 7 天）
const rotSession = await login('viewer01', VIEWER_PASSWORD);
const oldRefreshToken = rotSession?.jar?.erp_refresh_token;
const oldJti = oldRefreshToken ? decodeJwtPayload(oldRefreshToken)?.jti : undefined;
const rotRes = await api('POST', '/api/auth/refresh', { jar: rotSession.jar });
const newRefreshToken = rotRes.cookies?.erp_refresh_token;
const newJti = newRefreshToken ? decodeJwtPayload(newRefreshToken)?.jti : undefined;
if (rotSession) Object.assign(rotSession.jar, rotRes.cookies); // 模拟浏览器更新 Cookie 罐
report('refresh 轮换：/refresh 换发全新 refresh Cookie（含新 access）且与旧值不同',
  rotRes.status === 200 && rotRes.json?.code === 0 && typeof rotRes.cookies?.erp_access_token === 'string'
    && typeof newRefreshToken === 'string' && newRefreshToken !== oldRefreshToken,
  { status: rotRes.status, hasNewAccess: !!rotRes.cookies?.erp_access_token, rotated: newRefreshToken !== oldRefreshToken });

// 38. 轮换前后令牌 payload 均含唯一 jti 且已更换
report('refresh 轮换：新旧令牌 payload 均含唯一 jti 且已更换',
  typeof oldJti === 'string' && oldJti.length > 0 && typeof newJti === 'string' && newJti.length > 0 && oldJti !== newJti,
  { oldJti, newJti });

// （2026-09-24 宽限窗口）等待宽限窗口过期后再验证窗口外重放防护：
// 宽限窗口内的旧令牌复用已被宽限放行（该行为由下方断言 45-47 单独覆盖），
// 窗口外复用才触发重放防护——睡眠时长取宽限期 + 1 秒余量
console.log(`  （等待 ${VERIFY_GRACE_SECONDS + 1} 秒使宽限窗口过期，再验证窗口外重放防护；宽限期 ${VERIFY_GRACE_SECONDS} 秒）`);
await new Promise((r) => setTimeout(r, VERIFY_GRACE_SECONDS * 1000 + 1000));

// 39. 重放防护：旧 refresh token 二次使用返回 401
const replayRes = await api('POST', '/api/auth/refresh', { jar: { ...rotSession.jar, erp_refresh_token: oldRefreshToken } });
report('重放防护：旧 refresh token 二次使用返回 401（判定为可能泄露）',
  replayRes.status === 401, { status: replayRes.status, code: replayRes.json?.code });

// 40. 重放防护连带撤销：轮换签发的新 refresh token 也已被全端撤销（再次刷新 401）
const afterRevokeRes = await api('POST', '/api/auth/refresh', { jar: rotSession.jar });
report('重放防护：触发后该用户全部 refresh token 已撤销（轮换出的新令牌亦 401）',
  afterRevokeRes.status === 401, { status: afterRevokeRes.status, code: afterRevokeRes.json?.code });

// 41. 审计日志留痕：refresh_replay_detected 事件（含 user_id/jti/IP）
{
  const r = await api('GET', '/api/audit-logs?action=refresh_replay_detected&page=1&pageSize=20', { jar: admin.jar });
  const list = r.json?.data?.list || [];
  const hit = list.find((row) => row.target === oldJti || row.target === newJti);
  report('重放防护：审计日志写入 refresh_replay_detected（含 user_id/jti/IP）',
    r.status === 200 && (r.json?.data?.total ?? 0) >= 1 && hit && hit.userId > 0 && typeof hit.ip === 'string' && hit.ip.length > 0,
    { total: r.json?.data?.total, hit });
}

// 42. 伪造令牌：签名合法但 jti 不存在的 refresh 返回 401
const unknownSession = await login('viewer01', VIEWER_PASSWORD); // 重放防护已 tv+1，重新登录取新会话
const unknownPayload = decodeJwtPayload(unknownSession?.jar?.erp_refresh_token);
const testSecret = readBackendEnv('JWT_SECRET');
const forgedToken = unknownPayload && testSecret
  ? craftJwt({ ...unknownPayload, jti: `verify-unknown-${Date.now()}` }, testSecret)
  : null;
const forgedRes = forgedToken
  ? await api('POST', '/api/auth/refresh', { jar: { erp_refresh_token: forgedToken } })
  : { status: -1, json: null };
report('伪造令牌：签名合法但 jti 不存在的 refresh 返回 401',
  forgedRes.status === 401 && !!testSecret && !!forgedToken,
  { status: forgedRes.status, hasSecret: !!testSecret, hasForged: !!forgedToken });

// 43. 登出撤销：登出后当前 refresh token 的 jti 在库中置为 revoked（只读连接直查 SQLite）
{
  const logoutSession = await login('viewer01', VIEWER_PASSWORD);
  const logoutJti = decodeJwtPayload(logoutSession?.jar?.erp_refresh_token)?.jti;
  const logoutRes2 = await api('POST', '/api/auth/logout', { jar: logoutSession.jar });
  let jtiStatus = null;
  try {
    const roDb = openReadonlyDb();
    jtiStatus = roDb.prepare('SELECT status FROM refresh_tokens WHERE jti = ?').get(logoutJti)?.status || null;
    roDb.close();
  } catch (err) {
    console.log(`  （只读查询 refresh_tokens 失败：${err?.message || err}）`);
  }
  report('登出撤销：登出后当前 refresh token 的 jti 在 refresh_tokens 表中置为 revoked',
    logoutRes2.status === 200 && jtiStatus === 'revoked',
    { logout: logoutRes2.status, jti: logoutJti, status: jtiStatus });
}

/* ======================= 第三批安全加固断言（2026-09-24）：refresh 轮换宽限窗口（多 tab 并发竞态修复） ======================= */
console.log('== 第三批安全加固断言（refresh 轮换宽限窗口 / 并发竞态复用） ==');

// 44. 并发竞态宽限：同一旧 refresh token 在宽限窗口内二次使用返回 200（视为竞态而非攻击），
//     不触发全端撤销——以宽限换发的新 access 调 /me 仍 200（若误撤销则 tv+1 会 401），
//     且轮换出的叶子令牌经只读连接直查仍为 active；宽限复用只换发 access cookie（叶子不轮换）
//     （注：2026-09-24 新增断言 44-47，原第 44 项限流断言顺延为第 48 项）
const graceSession = await login('viewer01', VIEWER_PASSWORD);
const graceOldRefresh = graceSession?.jar?.erp_refresh_token;
const graceOldJti = graceOldRefresh ? decodeJwtPayload(graceOldRefresh)?.jti : undefined;
const graceRotRes = await api('POST', '/api/auth/refresh', { jar: graceSession.jar }); // tab1：轮换 A -> B
const graceLeafRefresh = graceRotRes.cookies?.erp_refresh_token;
const graceLeafJti = graceLeafRefresh ? decodeJwtPayload(graceLeafRefresh)?.jti : undefined;
if (graceSession) Object.assign(graceSession.jar, graceRotRes.cookies);
// tab2：毫秒级并发场景，仍持旧令牌 A 请求刷新（宽限窗口内，第二次命中 rotated）
const graceReuseRes = await api('POST', '/api/auth/refresh', { jar: { ...graceSession.jar, erp_refresh_token: graceOldRefresh } });
const reuseAccess = graceReuseRes.cookies?.erp_access_token;
// 会话仍可用：以宽限换发的新 access cookie 请求 /me 应 200
const meAfterGrace = reuseAccess
  ? await api('GET', '/api/auth/me', { jar: { erp_access_token: reuseAccess, erp_refresh_token: graceLeafRefresh } })
  : { status: -1 };
// 直查 SQLite：叶子令牌未被全端撤销（仍为 active）
let leafStatusAfterGrace = null;
try {
  const roDb = openReadonlyDb();
  leafStatusAfterGrace = roDb.prepare('SELECT status FROM refresh_tokens WHERE jti = ?').get(graceLeafJti)?.status || null;
  roDb.close();
} catch (err) {
  console.log(`  （只读查询 refresh_tokens 失败：${err?.message || err}）`);
}
report('并发竞态宽限：宽限窗口内旧 refresh token 二次使用返回 200 且不触发全端撤销（会话仍可用、叶子令牌仍 active、不重发 refresh cookie）',
  graceReuseRes.status === 200 && graceReuseRes.json?.code === 0 && typeof reuseAccess === 'string'
    && graceReuseRes.cookies?.erp_refresh_token === undefined
    && meAfterGrace.status === 200 && leafStatusAfterGrace === 'active',
  { status: graceReuseRes.status, code: graceReuseRes.json?.code, hasReuseAccess: !!reuseAccess, noRefreshCookie: graceReuseRes.cookies?.erp_refresh_token === undefined, me: meAfterGrace.status, leafStatus: leafStatusAfterGrace });

// 45. 宽限命中审计：/api/audit-logs 可查到 refresh_grace_reuse 记录（含 user_id/jti/IP）
{
  const r = await api('GET', '/api/audit-logs?action=refresh_grace_reuse&page=1&pageSize=20', { jar: admin.jar });
  const list = r.json?.data?.list || [];
  const hit = list.find((row) => row.target === graceOldJti);
  report('宽限命中审计：/api/audit-logs 可查到 refresh_grace_reuse 记录（含 user_id/jti/IP）',
    r.status === 200 && (r.json?.data?.total ?? 0) >= 1 && hit && hit.userId > 0 && typeof hit.ip === 'string' && hit.ip.length > 0,
    { total: r.json?.data?.total, hit });
}

// 46. 宽限过期重放：等待超过宽限窗口后旧 token 再刷 -> 401 重放防护触发
//     （审计 refresh_replay_detected 留痕 + 轮换叶子令牌被全端撤销置 revoked）
console.log(`  （等待 ${VERIFY_GRACE_SECONDS + 1} 秒使宽限窗口过期，再验证宽限过期后重放防护）`);
await new Promise((r) => setTimeout(r, VERIFY_GRACE_SECONDS * 1000 + 1000));
const graceExpiredRes = await api('POST', '/api/auth/refresh', { jar: { ...graceSession.jar, erp_refresh_token: graceOldRefresh } });
let leafStatusAfterReplay = null;
try {
  const roDb = openReadonlyDb();
  leafStatusAfterReplay = roDb.prepare('SELECT status FROM refresh_tokens WHERE jti = ?').get(graceLeafJti)?.status || null;
  roDb.close();
} catch (err) {
  console.log(`  （只读查询 refresh_tokens 失败：${err?.message || err}）`);
}
const graceReplayAudit = await api('GET', '/api/audit-logs?action=refresh_replay_detected&page=1&pageSize=50', { jar: admin.jar });
const graceReplayHit = (graceReplayAudit.json?.data?.list || []).find((row) => row.target === graceOldJti);
report('宽限过期重放：超过宽限窗口后旧 token 再刷返回 401 重放防护触发（审计 refresh_replay_detected + 叶子令牌被全端撤销）',
  graceExpiredRes.status === 401 && !!graceReplayHit && leafStatusAfterReplay === 'revoked',
  { status: graceExpiredRes.status, auditHit: !!graceReplayHit, leafStatus: leafStatusAfterReplay });

// 47. revoked 无宽限：登出后旧 refresh token 再刷 -> 401（不进宽限逻辑，直接按重放防护处置）
const revokedSession = await login('viewer01', VIEWER_PASSWORD);
const revokedOldRefresh = revokedSession?.jar?.erp_refresh_token;
const revokedJti = revokedOldRefresh ? decodeJwtPayload(revokedOldRefresh)?.jti : undefined;
const logoutForGrace = await api('POST', '/api/auth/logout', { jar: revokedSession.jar });
const revokedReuseRes = await api('POST', '/api/auth/refresh', { jar: { ...revokedSession.jar, erp_refresh_token: revokedOldRefresh } });
report('revoked 无宽限：登出后旧 refresh token 再刷返回 401（不进宽限逻辑，直接按重放防护处置）',
  logoutForGrace.status === 200 && revokedReuseRes.status === 401,
  { logout: logoutForGrace.status, refresh: revokedReuseRes.status, code: revokedReuseRes.json?.code, jti: revokedJti });

// 48. SQLite 共享限流：登录接口计数打满返回 429，且 rate_limit_hits 表计数经第二连接可见（多进程共享存储证据）
//     （注：2026-09-24 宽限窗口断言插入后由原第 44 项顺延为第 48 项，断言逻辑不变）
{
  let got429 = false;
  for (let i = 0; i < 12 && !got429; i++) {
    const r = await api('POST', '/api/auth/login', { body: { username: `rl-nonexistent-${i}`, password: 'WrongPwd1' } });
    if (r.status === 429) got429 = true;
  }
  let storeRow;
  try {
    const roDb = openReadonlyDb();
    storeRow = roDb.prepare("SELECT key, count, reset_at FROM rate_limit_hits WHERE key LIKE 'login:%' ORDER BY count DESC LIMIT 1").get();
    roDb.close();
  } catch (err) {
    console.log(`  （只读查询 rate_limit_hits 失败：${err?.message || err}）`);
  }
  report('SQLite 共享限流：登录计数打满返回 429 且 rate_limit_hits 表计数经第二连接可见（共享存储生效）',
    got429 && storeRow !== undefined && (storeRow?.count ?? 0) >= 10,
    { got429, storeRow });
}

console.log(`\n结果: ${passCount} 通过, ${failCount} 失败`);
process.exit(failCount > 0 ? 1 : 0);
