/**
 * 参数校验中间件（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：基于 zod 对请求 body/query 进行 schema 校验，非法输入返回 400
 *          与字段级错误明细（PRD S5）。
 * 设计思路：中间件工厂模式，路由声明时绑定各自的 schema；错误明细统一放到
 *          ApiError.details 供前端逐字段渲染。
 * 适用场景：全部需要入参校验的路由。
 * 创建时间：2026-09-21
 */
import { ApiError } from '../utils/response.js';

/**
 * 创建参数校验中间件
 * @param {import('zod').ZodType} bodySchema   body 校验 schema（可为 null 表示不校验）
 * @param {import('zod').ZodType} [querySchema] query 校验 schema（可选）
 * @returns {import('express').RequestHandler} Express 中间件；通过后 req.body/req.query 为解析结果
 * @throws {ApiError} 1001：参数校验失败，details 为 [{ path, message }] 字段级数组
 */
export function validate(bodySchema, querySchema = null) {
  return (req, res, next) => {
    try {
      if (querySchema) {
        const q = querySchema.safeParse(req.query);
        if (!q.success) {
          throw new ApiError(400, 1001, '参数校验失败', formatZod(q.error));
        }
        // 将解析结果写回（保留 getter 兼容）
        Object.defineProperty(req, 'query', { value: q.data, writable: true, configurable: true });
      }
      if (bodySchema) {
        const b = bodySchema.safeParse(req.body ?? {});
        if (!b.success) {
          throw new ApiError(400, 1001, '参数校验失败', formatZod(b.error));
        }
        req.body = b.data;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * 将 zod 错误格式化为字段级明细数组
 * @param {import('zod').ZodError} zodError zod 校验错误对象
 * @returns {Array<{path: string, message: string}>} [{path:'body.name', message:'必填'}]
 */
function formatZod(zodError) {
  return zodError.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}
