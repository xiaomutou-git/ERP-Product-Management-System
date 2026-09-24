/**
 * 认证与权限中间件（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：① authenticate：校验 JWT 签名/有效期/类型/token_version，注入 req.user；
 *          ② rbac(...)：按角色编码列表做垂直越权校验（admin 始终放行）；
 *          ③ enforceNoPendingPasswordChange：强制改密拦截（未改密仅放行改密/登出/个人信息）。
 * 设计思路：所有受保护接口挂 authenticate；写接口按权限矩阵挂 rbac；
 *          token_version 不匹配立即 401，实现改密后旧 token 全失效。
 * 适用场景：全部 /api 路由。
 * 创建时间：2026-09-21
 */
import db from '../db/index.js';
import { verifyToken } from '../utils/jwt.js';
import { ApiError } from '../utils/response.js';
import { ACCESS_COOKIE } from '../utils/cookies.js';

/**
 * JWT 认证中间件
 * 执行逻辑：优先从 HttpOnly Cookie（erp_access_token，安全加固后的主通道）读取
 *          accessToken，兼容 Authorization: Bearer 头（平滑过渡，供脚本/服务间
 *          调用使用）-> 校验签名与有效期 -> 校验类型为 access ->
 *          查库校验用户存在、未删除、启用、token_version 匹配 -> 注入 req.user
 * @param {import('express').Request} req  请求对象（将挂载 req.user；依赖 cookieParser 已解析 req.cookies）
 * @param {import('express').Response} res 响应对象
 * @param {import('express').NextFunction} next 下一步
 * @returns {void} 校验失败时不调用 next，直接抛出 401
 * @throws {ApiError} 1002：未携带 token / token 无效或过期 / 用户被删除或停用 / token 版本不匹配
 */
export function authenticate(req, res, next) {
  try {
    // 凭据获取：Cookie 优先（主通道），Bearer 头兼容（平滑过渡）
    const header = req.headers.authorization || '';
    const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : '';
    const cookieToken = req.cookies?.[ACCESS_COOKIE] || '';
    const token = cookieToken || bearerToken;
    if (!token) throw new ApiError(401, 1002, '未登录或登录状态已失效');

    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      throw new ApiError(401, 1002, '未登录或登录状态已失效');
    }
    if (payload.type !== 'access') throw new ApiError(401, 1002, '未登录或登录状态已失效');

    const row = db.prepare(`
      SELECT u.id, u.username, u.real_name, u.status, u.token_version, u.must_change_password, r.code AS role_code, r.name AS role_name
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ? AND u.deleted_at IS NULL
    `).get(payload.sub);
    if (!row || row.status !== 1) throw new ApiError(401, 1002, '未登录或登录状态已失效');
    if (row.token_version !== payload.tv) throw new ApiError(401, 1002, '登录状态已过期，请重新登录');

    req.user = {
      id: row.id,
      username: row.username,
      realName: row.real_name,
      role: row.role_code,
      roleName: row.role_name,
      mustChangePassword: row.must_change_password === 1,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * 角色权限中间件工厂（垂直越权防护）
 * @param {...string} allowedRoles 允许访问的角色编码（admin 恒放行，无需传入）
 * @returns {import('express').RequestHandler} Express 中间件
 * @throws {ApiError} 1003：当前角色不在允许列表时抛出"无权限执行该操作"
 */
export function rbac(...allowedRoles) {
  return (req, res, next) => {
    try {
      const role = req.user?.role;
      if (role === 'admin' || allowedRoles.includes(role)) return next();
      throw new ApiError(403, 1003, '无权限执行该操作');
    } catch (err) {
      next(err);
    }
  };
}

/** 允许在强制改密期间访问的路径白名单（前缀匹配） */
const PASSWORD_PENDING_WHITELIST = ['/api/auth/password', '/api/auth/logout', '/api/auth/me', '/api/auth/refresh'];

/**
 * 强制改密拦截中间件（挂载在 authenticate 之后、业务路由之前）
 * 执行逻辑：若当前用户 must_change_password=1 且请求路径不在白名单内，则 403 拒绝。
 * @param {import('express').Request} req 请求对象
 * @param {import('express').Response} res 响应对象
 * @param {import('express').NextFunction} next 下一步
 * @returns {void} 通过时调用 next
 * @throws {ApiError} 1003：需先修改初始密码
 */
export function enforceNoPendingPasswordChange(req, res, next) {
  try {
    if (req.user?.mustChangePassword && !PASSWORD_PENDING_WHITELIST.some((p) => req.path === p || req.path.startsWith(p + '/'))) {
      throw new ApiError(403, 1003, '请先修改初始密码后再执行其他操作');
    }
    next();
  } catch (err) {
    next(err);
  }
}
