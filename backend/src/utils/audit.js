/**
 * 审计日志工具（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：向 audit_logs 表写入操作日志，敏感字段（密码类）自动脱敏为 ******。
 * 设计思路：日志写入失败绝不阻断业务主流程（PRD FR-08），所有异常仅打印服务端日志；
 *          detail 字段统一为 JSON 字符串，写入前做脱敏与长度截断。
 * 适用场景：登录成功/失败、登出、商品/分类/供应商/采购/库存/用户的全部写操作。
 * 创建时间：2026-09-21
 */
import db from '../db/index.js';

/** 需要脱敏的字段名（命中后值替换为 ******） */
const SENSITIVE_KEYS = ['password', 'oldPassword', 'newPassword', 'passwordHash', 'token', 'accessToken', 'refreshToken'];

/**
 * 对 detail 对象做敏感字段脱敏
 * @param {Record<string, unknown>} detail 原始详情对象
 * @returns {Record<string, unknown>} 脱敏后的新对象（原对象不被修改）
 */
function maskSensitive(detail) {
  if (!detail || typeof detail !== 'object') return detail;
  const clone = { ...detail };
  for (const k of Object.keys(clone)) {
    if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s.toLowerCase()))) {
      clone[k] = '******';
    }
  }
  return clone;
}

/**
 * 写入一条审计日志（异步兜底，绝不抛出）
 * @param {object} p                    日志参数对象
 * @param {number|null} p.userId        操作人 ID（登录失败且用户名不存在时为 null）
 * @param {string} p.username           操作人用户名快照
 * @param {string} p.action             动作：login_success/login_failed/logout/create/update/delete/submit/receive/adjust 等
 * @param {string} p.module             模块：auth/product/category/supplier/purchase/inventory/user
 * @param {string|null} [p.target]      目标对象标识（如商品 SKU、采购单号）
 * @param {Record<string, unknown>|null} [p.detail] 详情对象（写入前 JSON 序列化并脱敏）
 * @param {string|null} [p.ip]          客户端 IP
 * @param {string|null} [p.userAgent]   User-Agent
 * @returns {void} 无返回值；任何写入失败仅打印服务端错误日志
 */
export function writeAudit({ userId = null, username, action, module, target = null, detail = null, ip = null, userAgent = null }) {
  try {
    let detailStr = null;
    if (detail) {
      detailStr = JSON.stringify(maskSensitive(detail));
      if (detailStr.length > 2000) detailStr = detailStr.slice(0, 2000); // 防止超长写入
    }
    db.prepare(`
      INSERT INTO audit_logs (user_id, username, action, module, target, detail, ip, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, username || 'unknown', action, module, target, detailStr, ip, userAgent, new Date().toISOString());
  } catch (err) {
    // 日志写失败不阻断主流程（PRD FR-08 第 4 条）
    console.error('[audit] 审计日志写入失败:', err && err.message);
  }
}

/**
 * 从 Express 请求中提取客户端 IP（安全修复 VULN-03）
 * 执行逻辑：仅在应用显式设置 trust proxy（req.app.get('trust proxy') 为真值）时
 *          才信任 X-Forwarded-For 头——此时请求来自可信反向代理，XFF 由代理写入；
 *          未设置 trust proxy 时（直连部署）XFF 可被任意客户端伪造，一律忽略，
 *          改用 req.ip（socket 地址），防止攻击者向审计日志写入伪造 IP。
 * @param {import('express').Request} req 请求对象
 * @returns {string} 客户端 IP，如 192.168.1.10；无法识别时返回 0.0.0.0
 */
export function clientIp(req) {
  const trustProxy = req.app && typeof req.app.get === 'function' && req.app.get('trust proxy');
  const xf = req.headers['x-forwarded-for'];
  if (trustProxy && typeof xf === 'string' && xf.length > 0) return xf.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || '0.0.0.0';
}
