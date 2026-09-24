/**
 * SQLite 共享限流存储（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：基于 better-sqlite3 实现 express-rate-limit（v7.5 Promise 风格 Store
 *          契约）兼容的自定义 Store，将限流计数从进程内存（默认 MemoryStore）
 *          迁移到 SQLite 独立表 rate_limit_hits，实现"单机多进程"共享计数，
 *          杜绝请求被分摊到不同进程从而绕过限流阈值的问题。
 * 设计思路：
 *          ① increment 用单条 UPSERT（INSERT ... ON CONFLICT ... DO UPDATE ...
 *          RETURNING）原子完成"窗口过期清零 + 计数 +1"——SQLite 语句级原子性
 *          保证多进程并发计数不丢不乱；命中已过期 key 时自动清零重开窗口；
 *          ② 各限流器以 prefix 前缀隔离键空间（如 global:127.0.0.1 与
 *          login:127.0.0.1），共用一张表互不干扰，resetAll 仅清理本前缀键；
 *          ③ 防表膨胀：模块级共享定时器每 10 分钟删除 reset_at 过期的行，
 *          服务退出时由 index.js 调 stopRateLimitCleanup()（或 Store.shutdown()）
 *          执行 clearInterval；④ 复用全局 db 连接（WAL 模式），多进程各持连接
 *          读写同一文件安全，并设置 busy_timeout 缓解多进程写锁竞争。
 * 接口契约（express-rate-limit v7.5 Store）：increment(key) 同步返回
 *          { totalHits, resetTime }；decrement/resetKey/resetAll 同步执行；
 *          get(key) 返回当前计数（可选）；init(options) 接收中间件配置；
 *          shutdown() 停止定时器释放资源；localKeys 未设置（false，数据库共享键）。
 * 适用范围说明（重要）：本方案覆盖"单机多进程"共享计数；若跨机器部署多实例，
 *          需改用 Redis 版 store（如 rate-limit-redis + ioredis），各实例共享
 *          同一 Redis 方可全局限流，SQLite 文件无法跨机器共享。
 * 适用场景：middlewares/rateLimit.js 的全局限流与登录限流（每个限流器一个独立实例，
 *          以满足 express-rate-limit 的 ERR_ERL_STORE_REUSE 约束）。
 * 创建时间：2026-09-24
 */
import db from '../db/index.js';

/** 过期记录清理周期（毫秒）：每 10 分钟执行一次删除 */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/** 模块级共享清理定时器：多个 store 实例（全局/登录限流）共用一个，避免重复建定时器 */
let cleanupTimer = null;

/**
 * 启动过期限流记录定时清理（幂等：已存在定时器则跳过）
 * 执行逻辑：周期性 DELETE reset_at < 当前时间的行；写库异常仅打印服务端日志，
 *          绝不中断限流主流程（清理失败只影响表体积，不影响计数正确性）。
 * @returns {void} 无返回值
 * @throws {Error} 不向外抛出（内部 try-catch 兜底）
 */
function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    try {
      db.prepare('DELETE FROM rate_limit_hits WHERE reset_at < ?').run(Date.now());
    } catch (err) {
      console.error('[rate-limit-store] 过期限流记录清理失败:', err && err.message);
    }
  }, CLEANUP_INTERVAL_MS);
  // unref：定时器不阻止进程自然退出（优雅退出由显式 stop/shutdown 保证）
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

/**
 * 停止限流存储定时清理（服务优雅退出或 Store.shutdown 时调用，
 * 满足"服务退出时 clearInterval"要求）
 * @returns {void} 无返回值
 */
export function stopRateLimitCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * SQLite 限流存储类
 * ------------------------------------------------------------------
 * 核心功能：以 SQLite 表 rate_limit_hits(key, count, reset_at) 存储限流窗口计数，
 *          实现 express-rate-limit v7.5 Store 接口（Promise/同步返回值风格）。
 * 设计思路：构造时幂等建表 + 索引；窗口到期判定基于 reset_at 时间戳（毫秒）；
 *          better-sqlite3 为同步 API，increment 直接同步返回计数对象（库会自动
 *          await 兼容）；increment 抛出的异常由限流中间件统一捕获处理。
 * 适用场景：express-rate-limit 的 store 配置项（每个限流器独立实例 + 独立前缀）。
 * 创建时间：2026-09-24
 */
class SqliteRateLimitStore {
  /**
   * 构造函数：校验配置、幂等建表、启动共享清理定时器
   * @param {object} options 存储配置
   * @param {number} options.windowMs 限流窗口时长（毫秒），必须为正数
   * @param {string} [options.prefix='rl'] 键前缀（隔离不同限流器的键空间，
   *        同时作为 store.prefix 元数据供库的双计数校验避免误报）
   * @throws {Error} windowMs 缺失或非法时抛出（启动期快速失败）
   */
  constructor(options) {
    if (!options || !Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error('SqliteRateLimitStore 需要合法的 windowMs 配置（毫秒，> 0）');
    }
    this.windowMs = options.windowMs;
    /** @type {string} 键前缀（express-rate-limit Store.prefix 元数据约定） */
    this.prefix = options.prefix || 'rl';
    // 幂等建表：独立表 rate_limit_hits（多进程共享计数载体）
    db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_hits (
        key      TEXT    PRIMARY KEY,
        count    INTEGER NOT NULL DEFAULT 0,
        reset_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_reset ON rate_limit_hits(reset_at);
    `);
    // 多进程写锁竞争缓解：busy_timeout 内自动重试，避免 SQLITE_BUSY 直接报错
    db.pragma('busy_timeout = 3000');
    ensureCleanupTimer();
  }

  /**
   * 拼接带前缀的存储键（隔离不同限流器，避免同 IP 计数串扰）
   * @param {string} key 原始键（express-rate-limit 默认为客户端 IP）
   * @returns {string} 形如 "login:127.0.0.1" 的完整键
   */
  fullKey(key) {
    return `${this.prefix}:${key}`;
  }

  /**
   * 接收限流中间件配置（express-rate-limit Store 可选接口；本实现窗口时长由
   * 构造函数传入，此处保留以满足接口契约并兜底同步窗口配置）
   * @param {object} options 限流中间件配置对象
   * @returns {void}
   */
  init(options) {
    if (options && Number.isFinite(options.windowMs) && options.windowMs > 0) {
      this.windowMs = options.windowMs;
    }
  }

  /**
   * 计数 +1（express-rate-limit Store 核心接口）
   * 执行逻辑：单条 UPSERT 原子操作——键不存在则新建（count=1，reset_at=now+windowMs）；
   *          键存在且窗口未过期则 count+1；键存在但已过期则清零重开窗口（count=1，
   *          reset_at=now+windowMs），即"命中过期 key 自动清零"。
   * @param {string} key 计数键（默认为客户端 IP）
   * @returns {{ totalHits: number, resetTime: Date }} 当前窗口累计次数与窗口到期时间
   * @throws {Error} SQL 执行异常时抛出，由限流中间件统一捕获（默认 next(err)）
   */
  increment(key) {
    const now = Date.now();
    const row = db.prepare(`
      INSERT INTO rate_limit_hits (key, count, reset_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN rate_limit_hits.reset_at <= ? THEN 1 ELSE rate_limit_hits.count + 1 END,
        reset_at = CASE WHEN rate_limit_hits.reset_at <= ? THEN excluded.reset_at ELSE rate_limit_hits.reset_at END
      RETURNING count, reset_at
    `).get(this.fullKey(key), now + this.windowMs, now, now);
    return { totalHits: row.count, resetTime: new Date(row.reset_at) };
  }

  /**
   * 计数 -1（express-rate-limit Store 接口；用于 skipFailedRequests 等可选行为）
   * @param {string} key 计数键
   * @returns {void} 无返回值；计数已为 0 时不产生负数
   */
  decrement(key) {
    try {
      db.prepare('UPDATE rate_limit_hits SET count = count - 1 WHERE key = ? AND count > 0')
        .run(this.fullKey(key));
    } catch (err) {
      console.error('[rate-limit-store] decrement 失败:', err && err.message);
    }
  }

  /**
   * 重置单个键的计数（express-rate-limit Store 接口）
   * @param {string} key 计数键
   * @returns {void} 无返回值
   */
  resetKey(key) {
    try {
      db.prepare('DELETE FROM rate_limit_hits WHERE key = ?').run(this.fullKey(key));
    } catch (err) {
      console.error('[rate-limit-store] resetKey 失败:', err && err.message);
    }
  }

  /**
   * 重置全部计数（express-rate-limit Store 接口；仅清理本 store 前缀的键，
   * 避免多限流器共用一张表时误清其他限流器的计数）
   * @returns {void} 无返回值
   */
  resetAll() {
    try {
      db.prepare('DELETE FROM rate_limit_hits WHERE key LIKE ?').run(`${this.prefix}:%`);
    } catch (err) {
      console.error('[rate-limit-store] resetAll 失败:', err && err.message);
    }
  }

  /**
   * 查询单键当前计数（express-rate-limit Store 可选 get 接口，供调试与验证脚本使用）
   * @param {string} key 计数键
   * @returns {{ totalHits: number, resetTime: Date } | undefined} 存在则返回计数与窗口到期时间；不存在返回 undefined
   */
  get(key) {
    try {
      const row = db.prepare('SELECT count, reset_at FROM rate_limit_hits WHERE key = ?')
        .get(this.fullKey(key));
      if (!row) return undefined;
      return { totalHits: row.count, resetTime: new Date(row.reset_at) };
    } catch (err) {
      console.error('[rate-limit-store] get 失败:', err && err.message);
      return undefined;
    }
  }

  /**
   * 关闭存储并释放资源（express-rate-limit Store 可选 shutdown 接口：
   * 停止共享清理定时器；由 index.js 的优雅退出流程调用 stopRateLimitCleanup 实现）
   * @returns {void} 无返回值
   */
  shutdown() {
    stopRateLimitCleanup();
  }
}

export default SqliteRateLimitStore;
