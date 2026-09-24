/**
 * Express 应用装配（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：装配安全头（helmet，含生产 CSP）、CORS、Cookie 解析、CSRF 防护、
 *          JSON 解析、全局限流、健康检查、各业务路由、生产静态托管（SPA fallback）、
 *          404 兜底与全局错误处理。
 * 设计思路：/api 前缀统一挂载 authenticate + 强制改密拦截（公开路由（login/refresh）
 *          声明在受保护中间件之前注册，确保放行）；CORS 仅允许配置的前端来源（S11）；
 *          CSRF 防护对全部写操作校验 Origin/Referer（cookie 方案的必配防线）；
 *          生产环境由后端托管 frontend/dist 并启用 CSP，开发环境关闭 CSP
 *          以保证 Vite dev（HMR 需 inline script/websocket 与 eval 转译）正常工作。
 * 适用场景：由 index.js 创建并监听端口。
 * 创建时间：2026-09-21（2026-09-24 安全加固：cookie 会话 + 生产 CSP + 静态托管）
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { globalLimiter } from './middlewares/rateLimit.js';
import { cookieParser } from './middlewares/cookie.js';
import { csrfProtect } from './middlewares/csrf.js';
import { authenticate, enforceNoPendingPasswordChange } from './middlewares/auth.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';

import authRoutes from './routes/auth.routes.js';
import categoryRoutes from './routes/categories.routes.js';
import productRoutes from './routes/products.routes.js';
import supplierRoutes from './routes/suppliers.routes.js';
import purchaseOrderRoutes from './routes/purchaseOrders.routes.js';
import inventoryRoutes from './routes/inventory.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import userRoutes from './routes/users.routes.js';
import auditLogRoutes from './routes/auditLogs.routes.js';

/** 是否生产环境（决定 CSP 与静态托管是否启用） */
const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * 解析前端生产构建目录 frontend/dist 的绝对路径
 * @returns {string} dist 目录绝对路径（无论是否存在）
 */
function resolveDistDir() {
  // 本文件位于 backend/src/app.js：../../frontend/dist 即项目根/frontend/dist
  return path.resolve(fileURLToPath(new URL('../../frontend/dist', import.meta.url)));
}

/**
 * 创建 Express 应用实例
 * @returns {import('express').Express} 配置完成的 app
 */
export function createApp() {
  const app = express();

  // 安全响应头（S8）：nosniff、X-Frame-Options 等。
  // CSP 仅生产启用（S12）：dev 模式 Vite HMR 依赖 inline script / websocket / 转译期 eval，
  // 开启会破坏开发体验，故 contentSecurityPolicy: false；生产策略见下。
  app.use(helmet({
    contentSecurityPolicy: IS_PROD ? {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // 不放开 script unsafe-eval / unsafe-inline，最大化压缩 XSS 执行面
        scriptSrc: ["'self'"],
        // style-src 'unsafe-inline' 为 Element Plus / Vue 运行时动态样式注入所需
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        // 同源部署，API 请求均为 self；ECharts 5 默认 Canvas 渲染无额外 CSP 需求（已实测）
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    } : false,
  }));
  // CORS：仅允许配置的来源（S11）
  const origin = process.env.CORS_ORIGIN || 'http://localhost:5173';
  app.use(cors({ origin, credentials: true }));
  // Cookie 解析：认证中间件与 /refresh 读取 HttpOnly Cookie 的前置依赖
  app.use(cookieParser);
  // CSRF 防护（cookie 方案必配）：写操作校验 Origin/Referer 与允许源一致，否则 403
  app.use(csrfProtect);
  // JSON 请求体解析
  app.use(express.json({ limit: '1mb' }));
  // 全局限流（S7）
  app.use(globalLimiter);

  /* 健康检查（公开） */
  app.get('/api/health', (_req, res) => {
    res.json({ code: 0, message: 'ok', data: { status: 'up', time: new Date().toISOString() } });
  });

  /* 公开路由（login/refresh 在 auth.routes 内部声明，位于鉴权之前注册即可放行） */
  app.use('/api/auth', authRoutes);

  /* 受保护路由：统一 JWT 校验 + 强制改密拦截 */
  const protectedApi = express.Router();
  protectedApi.use(authenticate, enforceNoPendingPasswordChange);
  protectedApi.use('/categories', categoryRoutes);
  protectedApi.use('/products', productRoutes);
  protectedApi.use('/suppliers', supplierRoutes);
  protectedApi.use('/purchase-orders', purchaseOrderRoutes);
  protectedApi.use('/inventory', inventoryRoutes);
  protectedApi.use('/dashboard', dashboardRoutes);
  protectedApi.use('/users', userRoutes);
  protectedApi.use('/audit-logs', auditLogRoutes);
  app.use('/api', protectedApi);

  /* 生产模式：托管 frontend/dist + SPA fallback（S11 改造二） */
  if (IS_PROD) {
    const distDir = resolveDistDir();
    if (fs.existsSync(distDir)) {
      // 静态资源（index.html、assets/*）
      app.use(express.static(distDir, { index: 'index.html' }));
      // SPA fallback：非 /api 的 GET 请求回 index.html（history 路由深链接直开）
      app.get('*', (req, res, next) => {
        try {
          // API 未命中路由时放行给 404 兜底，不做 SPA 回退
          if (req.path.startsWith('/api')) return next();
          res.sendFile(path.join(distDir, 'index.html'));
        } catch (err) {
          next(err);
        }
      });
    } else {
      console.warn(`[erp-backend] 生产模式未找到前端构建目录: ${distDir}（请先执行 frontend 的 pnpm build）`);
    }
  }

  // 404 与全局错误处理（顺序：先 404 后错误）
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
