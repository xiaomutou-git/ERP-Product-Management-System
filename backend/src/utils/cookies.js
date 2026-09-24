/**
 * 认证 Cookie 工具（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：统一定义 accessToken / refreshToken 两类 HttpOnly Cookie 的名称、
 *          属性与写入/清除方法，供登录、刷新、登出三处复用。
 * 设计思路：token 一律不进响应 JSON、不落前端可读存储，改为 HttpOnly Cookie 传输；
 *          accessToken（短期）path=/ 全站可用；refreshToken（长期）path 收窄为
 *          /api/auth 精确前缀，仅刷新/登出/改密等认证接口可携带，缩小暴露面；
 *          SameSite=Lax 阻断跨站 POST 自动带 Cookie（CSRF 第一道防线），
 *          production 环境追加 Secure 仅经 HTTPS 传输。
 * 适用场景：auth.routes.js（login/refresh/logout）。
 * 创建时间：2026-09-24
 */
import { accessTtl } from './jwt.js';

/** accessToken 的 Cookie 名称 */
export const ACCESS_COOKIE = 'erp_access_token';

/** refreshToken 的 Cookie 名称（path 收窄为 /api/auth） */
export const REFRESH_COOKIE = 'erp_refresh_token';

/** refreshToken 的 Cookie 作用路径（仅认证接口可携带） */
export const REFRESH_COOKIE_PATH = '/api/auth';

/** 是否生产环境（决定是否追加 Secure 属性） */
const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * 计算 accessToken Cookie 的存活时间（毫秒）
 * @returns {number} 毫秒数（与 JWT access 有效期一致）
 */
function accessCookieMaxAge() {
  return accessTtl() * 1000;
}

/**
 * 计算 refreshToken Cookie 的存活时间（毫秒）
 * @returns {number} 毫秒数（环境变量 REFRESH_TOKEN_TTL，默认 7 天）
 */
function refreshCookieMaxAge() {
  return parseInt(process.env.REFRESH_TOKEN_TTL || '604800', 10) * 1000;
}

/**
 * 写入 accessToken 的 HttpOnly Cookie
 * @param {import('express').Response} res 响应对象
 * @param {string} accessToken 已签发的 access token
 * @returns {void}
 * @throws {Error} Express res.cookie 内部异常时抛出（由全局错误中间件兜底）
 */
export function setAccessCookie(res, accessToken) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax', // CSRF 防线一：跨站 POST/PUT/DELETE 不自动携带
    secure: IS_PROD, // 生产环境仅 HTTPS 传输
    maxAge: accessCookieMaxAge(),
  });
}

/**
 * 写入 refreshToken 的 HttpOnly Cookie（path 收窄为 /api/auth）
 * @param {import('express').Response} res 响应对象
 * @param {string} refreshToken 已签发的 refresh token
 * @returns {void}
 * @throws {Error} Express res.cookie 内部异常时抛出
 */
export function setRefreshCookie(res, refreshToken) {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: refreshCookieMaxAge(),
  });
}

/**
 * 登录成功后一次性写入两类认证 Cookie
 * @param {import('express').Response} res 响应对象
 * @param {{accessToken: string, refreshToken: string}} tokens 已签发的双令牌
 * @returns {void}
 * @throws {Error} Express res.cookie 内部异常时抛出
 */
export function setAuthCookies(res, tokens) {
  setAccessCookie(res, tokens.accessToken);
  setRefreshCookie(res, tokens.refreshToken);
}

/**
 * 登出时清除两类认证 Cookie（maxAge=0 立即过期）
 * @param {import('express').Response} res 响应对象
 * @returns {void}
 * @throws {Error} Express res.clearCookie 内部异常时抛出
 */
export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
  });
  res.clearCookie(REFRESH_COOKIE, {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
  });
}
