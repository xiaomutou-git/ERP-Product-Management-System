/**
 * 库存路由（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：库存分页列表（低库存筛选）、修改预警阈值、手动出入库调整（事务内
 *          更新库存 + 写流水）、库存流水分页（只读）。
 * 设计思路：数量变动仅允许发生在事务内（采购入库/手动调整），禁止绕过流水直改；
 *          手动出库时校验调整后库存 >= 0，否则 400"库存不足"且无流水产生；
 *          低库存判定 quantity <= warn_threshold。
 * 适用场景：挂载于 /api/inventory。
 * 创建时间：2026-09-21
 */
import { Router } from 'express';
import { z } from 'zod';
import db from '../db/index.js';
import { ok, ApiError, parsePaging, escapeLike } from '../utils/response.js';
import { writeAudit, clientIp } from '../utils/audit.js';
import { authenticate, rbac } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';

const router = Router();
router.use(authenticate);

const listQuery = z.object({
  keyword: z.string().trim().max(100).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  lowStock: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

/* ---------------- GET /api/inventory 库存分页列表（全部角色） ---------------- */
router.get('/', validate(null, listQuery), (req, res, next) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query);
    const { keyword, categoryId, lowStock } = req.query;

    const where = ['p.deleted_at IS NULL'];
    const params = [];
    if (keyword) {
      // 通配符转义防语义篡改（VULN-06），参数化防注入
      where.push("(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\')");
      params.push(`%${escapeLike(keyword)}%`, `%${escapeLike(keyword)}%`);
    }
    if (categoryId) {
      where.push('p.category_id = ?');
      params.push(categoryId);
    }
    if (lowStock === 'true') {
      where.push('i.quantity <= i.warn_threshold');
    }
    const whereSql = where.join(' AND ');

    const total = db.prepare(`
      SELECT COUNT(*) AS c FROM inventory i JOIN products p ON p.id = i.product_id WHERE ${whereSql}
    `).get(...params).c;
    const list = db.prepare(`
      SELECT i.product_id AS productId, p.sku, p.name AS productName, p.unit,
             c.name AS categoryName, cp.name AS parentCategoryName,
             i.quantity, i.warn_threshold AS warnThreshold,
             (i.quantity <= i.warn_threshold) AS isLowStock,
             i.updated_at AS updatedAt
      FROM inventory i
      JOIN products p ON p.id = i.product_id
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN categories cp ON cp.id = c.parent_id
      WHERE ${whereSql}
      ORDER BY (i.quantity <= i.warn_threshold) DESC, i.updated_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    res.json(ok({ list, total, page, pageSize }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- PUT /api/inventory/:productId/threshold 修改预警阈值（库管/管理员） ---------------- */
const thresholdSchema = z.object({
  warnThreshold: z.number({ invalid_type_error: '阈值必须为数字' }).int('阈值必须为整数').min(0, '阈值不能为负数').max(999999, '阈值不能超过 999999'),
});

router.put('/:productId/threshold', rbac('stockkeeper'), validate(thresholdSchema), (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    const inv = db.prepare(`
      SELECT i.*, p.sku FROM inventory i JOIN products p ON p.id = i.product_id
      WHERE i.product_id = ? AND p.deleted_at IS NULL
    `).get(productId);
    if (!inv) throw new ApiError(404, 1004, '库存记录不存在');

    db.prepare('UPDATE inventory SET warn_threshold = ?, updated_at = ?, updated_by = ? WHERE product_id = ?')
      .run(req.body.warnThreshold, new Date().toISOString(), req.user.id, productId);
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'adjust', module: 'inventory', target: inv.sku, detail: { productId, warnThreshold: req.body.warnThreshold, type: '阈值调整' }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ productId, warnThreshold: req.body.warnThreshold }, '阈值已更新'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/inventory/adjust 手动出入库调整（库管/管理员） ---------------- */
const adjustSchema = z.object({
  productId: z.number({ invalid_type_error: '商品不能为空' }).int().positive(),
  type: z.enum(['manual_in', 'manual_out'], { errorMap: () => ({ message: '调整类型仅允许手动入库/手动出库' }) }),
  quantity: z.number().int('数量必须为整数').min(1, '数量至少为 1').max(999999, '数量最多 999999'),
  reason: z.string().trim().min(1, '调整原因不能为空').max(200, '调整原因最多 200 字'),
});

router.post('/adjust', rbac('stockkeeper'), validate(adjustSchema), (req, res, next) => {
  try {
    const { productId, type, quantity, reason } = req.body;
    const inv = db.prepare(`
      SELECT i.*, p.sku, p.name FROM inventory i JOIN products p ON p.id = i.product_id
      WHERE i.product_id = ? AND p.deleted_at IS NULL
    `).get(productId);
    if (!inv) throw new ApiError(404, 1004, '库存记录不存在');

    const before = inv.quantity;
    const after = type === 'manual_in' ? before + quantity : before - quantity;
    // 出库下限保护：调整后库存 < 0 直接拒绝，且无流水产生（PRD FR-05 / A11）
    if (after < 0) throw new ApiError(400, 1006, '库存不足');
    // 安全修复（VULN-02）：入库上限保护，防止多次调整累计导致数值精度溢出
    if (after > 999999999) throw new ApiError(400, 1006, '调整后库存超出系统上限（999999999）');

    const now = new Date().toISOString();
    const adjust = db.transaction(() => {
      db.prepare('UPDATE inventory SET quantity = ?, updated_at = ?, updated_by = ? WHERE product_id = ?')
        .run(after, now, req.user.id, productId);
      db.prepare(`
        INSERT INTO inventory_logs (product_id, type, quantity, direction, before_quantity, after_quantity,
          ref_type, ref_id, ref_no, reason, operator_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'manual', NULL, NULL, ?, ?, ?)
      `).run(productId, type, quantity, type === 'manual_in' ? 1 : -1, before, after, reason, req.user.id, now);
    });
    adjust();

    writeAudit({ userId: req.user.id, username: req.user.username, action: 'adjust', module: 'inventory', target: inv.sku, detail: { productId, type, quantity, before, after, reason }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ productId, quantityAfter: after }, '调整成功'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- GET /api/inventory/logs 流水分页（只读，全部角色） ---------------- */
const logsQuery = z.object({
  productId: z.coerce.number().int().positive().optional(),
  type: z.enum(['purchase_in', 'manual_in', 'manual_out']).optional(),
  startDate: z.string().trim().max(10).optional(),
  endDate: z.string().trim().max(10).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

router.get('/logs', validate(null, logsQuery), (req, res, next) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query);
    const { productId, type, startDate, endDate } = req.query;

    const where = ['1=1'];
    const params = [];
    if (productId) {
      where.push('l.product_id = ?');
      params.push(productId);
    }
    if (type) {
      where.push('l.type = ?');
      params.push(type);
    }
    if (startDate) {
      where.push('date(l.created_at) >= date(?)');
      params.push(startDate);
    }
    if (endDate) {
      where.push('date(l.created_at) <= date(?)');
      params.push(endDate);
    }
    const whereSql = where.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) AS c FROM inventory_logs l WHERE ${whereSql}`).get(...params).c;
    const list = db.prepare(`
      SELECT l.id, l.product_id AS productId, p.sku, p.name AS productName, l.type,
             l.quantity, l.direction, l.before_quantity AS beforeQuantity, l.after_quantity AS afterQuantity,
             l.ref_type AS refType, l.ref_id AS refId, l.ref_no AS refNo, l.reason,
             u.real_name AS operatorName, u.username AS operatorUsername, l.created_at AS createdAt
      FROM inventory_logs l
      JOIN products p ON p.id = l.product_id
      JOIN users u ON u.id = l.operator_id
      WHERE ${whereSql}
      ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    res.json(ok({ list, total, page, pageSize }));
  } catch (err) {
    next(err);
  }
});

export default router;
