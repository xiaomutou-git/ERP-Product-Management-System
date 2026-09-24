/**
 * 轻量 Cookie 解析中间件（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：解析请求头 Cookie 字符串为 req.cookies 对象，供认证中间件与
 *          /refresh 路由读取 HttpOnly Cookie 中的令牌。
 * 设计思路：项目仅需读取少量认证 Cookie，为避免引入额外依赖（cookie-parser），
 *          自行实现 RFC6265 兼容的最小解析：按分号拆分、首个等号切分键值、
 *          百分号解码；解码失败时保留原值（token 为 base64url 字符，不含分号）。
 * 适用场景：app.js 全局挂载（位于全部路由之前）。
 * 创建时间：2026-09-24
 */

/**
 * 解析 Cookie 请求头并挂载到 req.cookies
 * 执行逻辑：无 Cookie 头时挂载空对象直接放行；有值时逐段解析为键值对。
 * @param {import('express').Request} req 请求对象（挂载 req.cookies）
 * @param {import('express').Response} _res 响应对象（未使用）
 * @param {import('express').NextFunction} next 下一步
 * @returns {void}
 * @throws {Error} 解析过程未知异常时下传全局错误中间件兜底
 */
export function cookieParser(req, _res, next) {
  try {
    const header = req.headers.cookie;
    req.cookies = {};
    if (header) {
      for (const pair of header.split(';')) {
        const idx = pair.indexOf('=');
        // 跳过无等号或空键的非法片段
        if (idx <= 0) continue;
        const key = pair.slice(0, idx).trim();
        const rawVal = pair.slice(idx + 1).trim();
        if (!key) continue;
        try {
          req.cookies[key] = decodeURIComponent(rawVal);
        } catch {
          // 值含非法百分号序列时保留原值（不影响 base64url 形态的 JWT）
          req.cookies[key] = rawVal;
        }
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}
