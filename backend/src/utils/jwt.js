/**
 * JWT 工具（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：签发/校验 access token（2h）与 refresh token（7d），HS256 签名。
 * 设计思路：payload 携带 tokenVersion（用户表字段），改密/重置密码时 +1，
 *          校验时与数据库比对不一致即拒绝，实现"改密后全端失效"；
 *          密钥必须来自环境变量且长度 >= 32 字符，否则启动即失败。
 * 适用场景：登录签发、受保护接口校验、刷新令牌。
 * 创建时间：2026-09-21
 */
import jwt from 'jsonwebtoken';

// 服务启动时校验密钥强度（PRD FR-01：未配置或不合规则启动失败）
const SECRET = process.env.JWT_SECRET || '';
if (SECRET.length < 32) {
  console.error('[startup] 环境变量 JWT_SECRET 未配置或长度不足 32 字符，服务拒绝启动');
  process.exit(1);
}

const ACCESS_TTL = parseInt(process.env.ACCESS_TOKEN_TTL || '7200', 10);   // 默认 2 小时
const REFRESH_TTL = parseInt(process.env.REFRESH_TOKEN_TTL || '604800', 10); // 默认 7 天

/**
 * 签发 access token
 * @param {{id:number, username:string, tokenVersion:number}} user 用户核心信息
 * @returns {string} JWT access token 字符串
 * @throws {Error} 签名异常时抛出 jsonwebtoken 错误（理论不发生，密钥已校验）
 */
export function signAccess(user) {
  return jwt.sign({ sub: user.id, username: user.username, tv: user.tokenVersion, type: 'access' }, SECRET, { expiresIn: ACCESS_TTL });
}

/**
 * 签发 refresh token
 * 安全加固（2026-09-24 轮换支持）：payload 增加唯一标识 jti（crypto.randomUUID），
 *          落库 refresh_tokens 表后供 /refresh 轮换与重放检测判定；
 *          旧签名兼容：不传 jti 时 payload 不含该字段（将无法通过 /refresh 的
 *          jti 校验，需重新登录，见 auth.routes.js）。
 * @param {{id:number, username:string, tokenVersion:number}} user 用户核心信息
 * @param {string} [jti] refresh token 唯一标识（UUID），登录/轮换签发时必须传入
 * @returns {string} JWT refresh token 字符串
 * @throws {Error} 签名异常时抛出 jsonwebtoken 错误
 */
export function signRefresh(user, jti) {
  const payload = { sub: user.id, username: user.username, tv: user.tokenVersion, type: 'refresh' };
  if (jti) payload.jti = jti;
  return jwt.sign(payload, SECRET, { expiresIn: REFRESH_TTL });
}

/**
 * 校验并解析 token（不校验类型，调用方自行判断 type）
 * @param {string} token JWT 字符串
 * @returns {{sub:number, username:string, tv:number, type:'access'|'refresh', exp:number}} 解析后的 payload
 * @throws {jwt.TokenExpiredError} token 过期时抛出
 * @throws {jwt.JsonWebTokenError} token 签名非法/格式错误时抛出
 */
export function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

/** @returns {number} access token 有效期（秒），供前端计算刷新时机 */
export function accessTtl() {
  return ACCESS_TTL;
}

/**
 * @returns {number} refresh token 有效期（秒），供 refresh_tokens 表写入过期时间（毫秒换算）
 */
export function refreshTtl() {
  return REFRESH_TTL;
}
