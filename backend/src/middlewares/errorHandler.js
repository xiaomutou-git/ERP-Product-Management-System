/**
 * 全局错误处理中间件（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：捕获所有路由抛出的异常，转换为统一响应结构对外返回；
 *          业务异常（ApiError）按其 status/code 输出；未知异常统一 5000，
 *          对外不泄露堆栈/SQL/文件路径（PRD S10），服务端完整记录错误日志。
 * 设计思路：四参中间件为 Express 错误处理约定；zod 校验错误在 validate 中间件
 *          已转换，此处仅兜底。
 * 适用场景：全局 app.use 挂载于全部路由之后。
 * 创建时间：2026-09-21
 */
import { ApiError } from '../utils/response.js';

/**
 * 全局错误处理中间件
 * @param {unknown} err  抛出的异常对象（ApiError / SQLite 约束错误 / 未知错误）
 * @param {import('express').Request} req  请求对象
 * @param {import('express').Response} res 响应对象
 * @param {import('express').NextFunction} _next 下一步（错误中间件不再下传）
 * @returns {void} 直接写入错误响应
 */
export function errorHandler(err, req, res, _next) {
  // 请求体 JSON 解析失败（body-parser entity.parse.failed）
  if (err && typeof err === 'object' && err.type === 'entity.parse.failed') {
    return res.status(400).json({ code: 1001, message: '请求体不是合法的 JSON', data: null });
  }

  // 唯一性约束冲突兜底（SKU/用户名/供应商名等 UNIQUE 索引）
  if (err && typeof err === 'object' && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ code: 1005, message: '数据已存在（唯一性冲突）', data: null });
  }

  if (err instanceof ApiError) {
    return res.status(err.status).json({ code: err.code, message: err.message, data: err.details ?? null });
  }

  // 未知异常：服务端记录完整错误，对外统一文案
  console.error('[error]', req.method, req.originalUrl, err);
  return res.status(500).json({ code: 5000, message: '服务器内部错误，请稍后重试', data: null });
}

/**
 * 404 兜底处理（未匹配任何路由时）
 * @param {import('express').Request} req  请求对象
 * @param {import('express').Response} res 响应对象
 * @returns {void} 写入 404 响应
 */
export function notFoundHandler(req, res) {
  res.status(404).json({ code: 1004, message: '接口不存在', data: null });
}
