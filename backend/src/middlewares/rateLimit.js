/**
 * 限流中间件（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：IP 维度限流：全局 300 次/分钟，登录接口 10 次/分钟（PRD S7），
 *          超限返回 429 与统一错误码 1008。
 * 设计思路：2026-09-24 安全加固（限流计数器迁移）——由 express-rate-limit 默认
 *          MemoryStore 迁移至 SQLite 共享存储（SqliteRateLimitStore，独立表
 *          rate_limit_hits），单机多进程/多实例部署时各进程共享同一份计数，
 *          杜绝"请求分摊到不同进程绕过限流"；两个限流器以不同前缀
 *          （global:/login:）隔离键空间，共用一张表互不干扰。
 *          跨机器多实例需改用 Redis 版 store（见 sqliteRateLimitStore.js 注释）。
 * 适用场景：app 级全局限流与 /api/auth/login 专用限流。
 * 创建时间：2026-09-21（2026-09-24 安全加固：计数器迁移至 SQLite 共享存储）
 */
import rateLimit from 'express-rate-limit';
import SqliteRateLimitStore from '../utils/sqliteRateLimitStore.js';

/**
 * 生成统一格式的限流响应
 * @param {import('express').Request} _req 请求对象
 * @param {import('express').Response} res 响应对象
 * @returns {void} 写入 429 响应
 */
function limitHandler(_req, res) {
  res.status(429).json({ code: 1008, message: '请求过于频繁，请稍后再试', data: null });
}

/** 全局限流存储：窗口 60 秒，键前缀 global（与登录限流共享表但键空间隔离） */
const globalStore = new SqliteRateLimitStore({ windowMs: 60 * 1000, prefix: 'global' });

/** 登录限流存储：窗口 60 秒，键前缀 login（与全局限流共享表但键空间隔离） */
const loginStore = new SqliteRateLimitStore({ windowMs: 60 * 1000, prefix: 'login' });

/** 全局限流：每个 IP 每分钟最多 300 次（计数存 SQLite，多进程共享） */
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: globalStore,
  handler: limitHandler,
});

/** 登录限流：每个 IP 每分钟最多 10 次（防暴力破解，计数存 SQLite，多进程共享） */
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: loginStore,
  handler: limitHandler,
});
