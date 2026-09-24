/**
 * 服务启动入口（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：加载环境变量 -> 校验 JWT 密钥 -> 初始化表结构与种子数据 -> 启动
 *          HTTP 服务 -> 开启周期性维护任务（限流计数表 / refresh token 会话表
 *          的过期记录清理，每 10 分钟一次）。
 * 设计思路：启动即完成建库建表（幂等），任何致命配置错误直接退出并给出明确报错；
 *          注意 ESM 静态导入按声明顺序求值，故 'dotenv/config' 必须置于首个导入，
 *          以保证后续模块（jwt.js 等）在模块级读取环境变量时已完成加载；
 *          清理任务在 initSchema 之后开启（依赖表已建好），服务退出时 clearInterval。
 * 适用场景：node src/index.js（或 pnpm dev）。
 * 创建时间：2026-09-21（2026-09-24 安全加固：限流 SQLite 共享存储 + refresh 轮换维护任务）
 */
import 'dotenv/config';

import { initSchema } from './db/schema.js';
import { seed } from './db/seed.js';
import { createApp } from './app.js';
import { startRefreshTokenCleanup, stopRefreshTokenCleanup } from './utils/refreshTokenStore.js';
import { stopRateLimitCleanup } from './utils/sqliteRateLimitStore.js';

// 初始化数据库（幂等：表存在则跳过；用户表为空则写入种子数据）
initSchema();
seed();

// 启动周期性维护任务：refresh_tokens 过期记录清理（限流表清理由 store 自行托管）
startRefreshTokenCleanup();

const PORT = parseInt(process.env.PORT || '3001', 10);
const app = createApp();

/**
 * 启动 HTTP 监听
 * @throws {Error} 端口被占用时触发 error 事件并退出进程
 */
const server = app.listen(PORT, () => {
  console.log(`[erp-backend] 服务已启动: http://localhost:${PORT}  (环境: ${process.env.NODE_ENV || 'development'})`);
});

server.on('error', (err) => {
  console.error('[erp-backend] 服务启动失败:', err.message);
  process.exit(1);
});

/**
 * 优雅退出：SIGINT/SIGTERM 时停止维护任务定时器（clearInterval 防泄漏）并关闭服务
 * @returns {void}
 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[erp-backend] 收到 ${sig}，正在关闭服务...`);
    stopRefreshTokenCleanup();
    stopRateLimitCleanup();
    server.close(() => process.exit(0));
  });
}
