/**
 * CSRF 防护中间件（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：对写操作（POST/PUT/PATCH/DELETE）校验 Origin/Referer 来源，
 *          与允许源白名单（环境变量 CORS_ORIGIN，逗号分隔）或请求自身同源
 *          比对，不一致返回 403，防御跨站请求伪造。
 * 设计思路：CSRF 防线二（防线一为 Cookie SameSite=Lax）。浏览器发起的跨站
 *          写请求必然携带 Origin（或 Referer），据此校验来源即可阻断；两类头
 *          均缺失时放行——非浏览器请求（curl/脚本/服务间调用）无法自动携带
 *          受害者的 HttpOnly Cookie，本就不构成 CSRF 场景（业界通行取舍，
 *          亦保证 verify.mjs 等服务端验证脚本可直连测试）。同源生产托管模式
 *          下，浏览器 Origin 与请求 Host 推导出的自身源一致，自动放行；
 *          dev 模式前端经 Vite 代理转发，Origin 保留为 5173，由 CORS_ORIGIN
 *          白名单放行。
 * 适用场景：app.js 全局挂载（位于全部路由之前、cookieParser 之后）。
 * 创建时间：2026-09-24
 */

/** 需要 CSRF 校验的 HTTP 方法集合 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 读取允许源白名单
 * 执行逻辑：取 CORS_ORIGIN 环境变量按逗号拆分并去空格；未配置时默认放行
 *          Vite dev 源 http://localhost:5173。
 * @returns {string[]} 允许的 Origin 列表
 */
function allowedOrigins() {
  const raw = process.env.CORS_ORIGIN || 'http://localhost:5173';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 从 Referer 头推导来源 Origin
 * @param {string | undefined} referer 请求头 Referer（可能为 undefined）
 * @returns {string | null} origin（如 http://localhost:5173）；无法解析返回 null
 */
function originFromReferer(referer) {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    // Referer 非法时视为无来源信息
    return null;
  }
}

/**
 * 依据请求自身 Host 推导同源 Origin
 * @param {import('express').Request} req 请求对象
 * @returns {string} 自身 origin（如 http://localhost:3001）
 */
function selfOrigin(req) {
  return `${req.protocol}://${req.get('host') || ''}`;
}

/**
 * CSRF 校验中间件
 * 执行逻辑：非写操作直接放行；写操作取 Origin（缺失时回退 Referer 解析）；
 *          两者均缺失视为非浏览器请求放行；存在来源时必须命中
 *          CORS_ORIGIN 白名单或与自身同源，否则 403 拒绝。
 * @param {import('express').Request} req 请求对象
 * @param {import('express').Response} res 响应对象
 * @param {import('express').NextFunction} next 下一步
 * @returns {void} 放行时调用 next；拒绝时写入 403 响应
 * @throws {Error} 未知异常时下传全局错误中间件兜底
 */
export function csrfProtect(req, res, next) {
  try {
    if (!WRITE_METHODS.has(req.method)) return next();

    // 来源：优先 Origin，其次 Referer 推导
    const origin = req.headers.origin || originFromReferer(req.headers.referer);
    // Origin/Referer 均缺失：非浏览器请求，无法构成 CSRF，放行
    if (!origin) return next();

    const isAllowed = allowedOrigins().includes(origin) || origin === selfOrigin(req);
    if (isAllowed) return next();

    return res.status(403).json({ code: 1003, message: '跨站请求被拒绝（CSRF 防护）', data: null });
  } catch (err) {
    next(err);
  }
}
