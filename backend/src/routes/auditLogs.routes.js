/**
 * 审计日志路由（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：操作日志分页查询（按操作人/模块/动作/时间区间筛选），仅管理员可读。
 * 设计思路：日志只增不改不删，本路由仅提供 GET 查询，无任何写入口（PRD FR-08）。
 * 适用场景：挂载于 /api/audit-logs。
 * 创建时间：2026-09-21
 */
import { Router } from 'express';
import { z } from 'zod';
import db from '../db/index.js';
import { ok, parsePaging, escapeLike } from '../utils/response.js';
import { authenticate, rbac } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';

const router = Router();
router.use(authenticate, rbac('admin'));

const listQuery = z.object({
  username: z.string().trim().max(20).optional(),
  module: z.string().trim().max(20).optional(),
  action: z.string().trim().max(30).optional(),
  startDate: z.string().trim().max(10).optional(),
  endDate: z.string().trim().max(10).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

/* ---------------- GET /api/audit-logs 日志分页（仅管理员） ---------------- */
router.get('/', validate(null, listQuery), (req, res, next) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query, 1, 20);
    const { username, module, action, startDate, endDate } = req.query;

    const where = ['1=1'];
    const params = [];
    if (username) {
      // 通配符转义防语义篡改（VULN-06），参数化防注入
      where.push("a.username LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(username)}%`);
    }
    if (module) {
      where.push('a.module = ?');
      params.push(module);
    }
    if (action) {
      where.push('a.action = ?');
      params.push(action);
    }
    if (startDate) {
      where.push('date(a.created_at) >= date(?)');
      params.push(startDate);
    }
    if (endDate) {
      where.push('date(a.created_at) <= date(?)');
      params.push(endDate);
    }
    const whereSql = where.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs a WHERE ${whereSql}`).get(...params).c;
    const list = db.prepare(`
      SELECT a.id, a.user_id AS userId, a.username, a.action, a.module, a.target, a.detail,
             a.ip, a.user_agent AS userAgent, a.created_at AS createdAt
      FROM audit_logs a WHERE ${whereSql}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    res.json(ok({ list, total, page, pageSize }));
  } catch (err) {
    next(err);
  }
});

export default router;
