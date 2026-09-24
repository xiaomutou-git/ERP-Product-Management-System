/**
 * refresh token 会话存储工具（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：封装 refresh_tokens 表的全部读写（签发 active 行、轮换标记并记录
 *          rotated_at、沿链查找 active 叶子、撤销单个/全部、查状态、过期清理），
 *          供 auth.routes.js 的登录 / 刷新轮换 / 宽限窗口竞态复用 / 重放检测 /
 *          登出撤销复用。
 * 设计思路：所有函数为同步 better-sqlite3 调用，参数化查询防注入；表结构由
 *          db/schema.js 启动时幂等创建（本模块不建表，仅做数据操作）；
 *          过期清理走独立定时任务（每 10 分钟删除 expires_at 已过期行），
 *          已轮换（rotated）/已撤销（revoked）的行保留至过期——这是重放
 *          检测的判定依据，过期后清理不影响安全（JWT 本身也已失效）。
 * 适用场景：auth.routes.js（login/refresh/logout）与 index.js（清理任务）。
 * 创建时间：2026-09-24
 */
import db from '../db/index.js';

/** 过期记录清理周期（毫秒）：每 10 分钟执行一次 */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/** 模块级清理定时器句柄（服务退出时 clearInterval 防泄漏） */
let cleanupTimer = null;

/**
 * 写入一条 active 状态的 refresh token 会话记录
 * @param {object} p 参数对象
 * @param {string} p.jti refresh token 唯一标识（UUID），与 JWT payload.jti 一致
 * @param {number} p.userId 用户 ID
 * @param {number} p.expiresAt 过期时间（毫秒时间戳，与 JWT exp 同源）
 * @returns {void} 无返回值
 * @throws {Error} SQLite 写入失败（如库文件不可写）时抛出，由调用方 try-catch 处理
 */
export function issueRefreshToken({ jti, userId, expiresAt }) {
  db.prepare(`
    INSERT INTO refresh_tokens (jti, user_id, expires_at, status, replaced_by, created_at)
    VALUES (?, ?, ?, 'active', NULL, ?)
  `).run(jti, userId, expiresAt, Date.now());
}

/**
 * 按 jti 查询 refresh token 会话记录
 * @param {string} jti refresh token 唯一标识
 * @returns {{jti:string, user_id:number, expires_at:number, status:'active'|'rotated'|'revoked', replaced_by:string|null, created_at:number} | undefined}
 *          存在返回记录；不存在返回 undefined
 */
export function getRefreshToken(jti) {
  return db.prepare('SELECT * FROM refresh_tokens WHERE jti = ?').get(jti);
}

/**
 * 将 jti 标记为 rotated（已轮换），记录替换它的新 jti 与轮换发生时刻
 * 安全加固（2026-09-24 宽限窗口）：rotated_at 记录轮换时刻（毫秒时间戳），
 *          供 /refresh 判定"旧令牌复用是否落在宽限窗口内"——窗口内视为多 tab
 *          并发竞态而非攻击；窗口以首次轮换的 rotated_at 为准，后续复用不刷新该值
 *          （防止宽限窗口被无限延长）。
 * @param {string} jti 被轮换的旧 refresh token 唯一标识
 * @param {string} replacedBy 轮换后签发的新 jti（重放溯源链）
 * @returns {void} 无返回值
 * @throws {Error} SQLite 写入失败时抛出
 */
export function markRotated(jti, replacedBy) {
  db.prepare("UPDATE refresh_tokens SET status = 'rotated', replaced_by = ?, rotated_at = ? WHERE jti = ?")
    .run(replacedBy, Date.now(), jti);
}

/**
 * 沿 replaced_by 溯源链查找轮换家族当前 active 的叶子令牌（宽限窗口复用专用）
 * 执行逻辑：从给定 jti 对应行出发——active 行即叶子（还需未过期）；rotated 行沿
 *          replaced_by 继续下探；revoked 行或断链（rotated 但无 replaced_by）立即
 *          返回 null；深度上限 MAX_CHAIN_DEPTH 防御性防环（正常链为树状单向生长，
 *          不可能成环，此处仅兜底防脏数据导致死循环）。
 * 依赖条件：refresh_tokens 表已由 schema.js 建表；调用方需自行保证传入 jti 存在
 *          （本函数对不存在的 jti 返回 null）。
 * 安全边界：返回前校验叶子 expires_at——叶子已过期视同"无可用叶子"，由调用方
 *          按重放防护处置，避免为已过期会话续发 access token。
 * @param {string} jti 起始 refresh token 唯一标识（通常为命中宽限窗口的 rotated 旧 jti）
 * @param {number} [maxDepth=10] 沿链查找最大深度（防环兜底，默认 10 层）
 * @returns {{jti:string, user_id:number, expires_at:number, status:'active', replaced_by:null, rotated_at:number|null, created_at:number} | null}
 *          找到未过期的 active 叶子返回该行记录；链上无可用叶子（被撤销/过期/断链/超深）返回 null
 * @throws {Error} SQLite 查询失败（如库文件损坏）时抛出，由调用方 try-catch 处理
 */
export function findActiveLeafFromChain(jti, maxDepth = 10) {
  let current = getRefreshToken(jti);
  for (let depth = 0; current && depth <= maxDepth; depth++) {
    // 命中 active 行：即家族当前叶子，未过期则可用
    if (current.status === 'active') {
      return current.expires_at > Date.now() ? current : null;
    }
    // 已撤销或断链（rotated 但缺失 replaced_by）：链上不存在可用叶子
    if (current.status === 'revoked' || !current.replaced_by) return null;
    // rotated：沿溯源链继续向叶子下探
    current = getRefreshToken(current.replaced_by);
  }
  // 超过最大深度仍未命中叶子（防御性兜底）：按无可用叶子处理
  return null;
}

/**
 * 撤销单个 refresh token（置 status=revoked，登出时使用）
 * @param {string} jti 待撤销的 refresh token 唯一标识
 * @returns {void} 无返回值；已撤销/已轮换的行保持原状态（幂等）
 * @throws {Error} SQLite 写入失败时抛出
 */
export function revokeRefreshToken(jti) {
  db.prepare("UPDATE refresh_tokens SET status = 'revoked' WHERE jti = ? AND status = 'active'")
    .run(jti);
}

/**
 * 撤销指定用户全部 active 状态的 refresh token（重放检测触发时的全端止损）
 * @param {number} userId 用户 ID
 * @returns {number} 实际被撤销（状态发生变化）的记录条数
 * @throws {Error} SQLite 写入失败时抛出
 */
export function revokeAllActiveForUser(userId) {
  const info = db.prepare("UPDATE refresh_tokens SET status = 'revoked' WHERE user_id = ? AND status = 'active'")
    .run(userId);
  return info.changes;
}

/**
 * 清理已过期的 refresh token 会话记录（expires_at < 当前时间）
 * @returns {number} 删除的记录条数（用于服务端日志观测）
 * @throws {Error} SQLite 写入失败时抛出（由定时任务 try-catch 兜底）
 */
export function cleanupExpiredRefreshTokens() {
  const info = db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(Date.now());
  return info.changes;
}

/**
 * 启动过期 refresh token 定时清理任务（幂等：重复调用不会创建多个定时器）
 * 执行逻辑：每 10 分钟删除一次 expires_at 已过期的行（含 active/rotated/revoked），
 *          防止表无限膨胀；清理失败仅打印服务端日志，不影响业务。
 * @returns {void} 无返回值
 * @throws {Error} 不向外抛出（定时器回调内部 try-catch 兜底）
 */
export function startRefreshTokenCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    try {
      const removed = cleanupExpiredRefreshTokens();
      if (removed > 0) console.log(`[refresh-token-store] 已清理 ${removed} 条过期 refresh token 记录`);
    } catch (err) {
      console.error('[refresh-token-store] 过期记录清理失败:', err && err.message);
    }
  }, CLEANUP_INTERVAL_MS);
  // unref：定时器不阻止进程自然退出（优雅退出由显式 stopRefreshTokenCleanup 保证）
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

/**
 * 停止过期清理任务（服务优雅退出时调用，clearInterval 防止定时器泄漏）
 * @returns {void} 无返回值
 */
export function stopRefreshTokenCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
