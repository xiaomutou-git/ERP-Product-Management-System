/**
 * 采购单路由（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：采购单全状态机管理——创建/编辑/删除草稿、提交、入库确认、取消，
 *          以及分页列表与详情查询。
 * 设计思路：状态机 draft -> submitted -> received（终态）；draft/submitted -> cancelled；
 *          单号规则 PO+yyyyMMdd+4 位流水，生成于创建事务内；
 *          入库确认在单事务内完成"锁定状态 -> 逐条加库存 -> 写流水 -> 更新单据"，
 *          任何一步失败整体回滚；状态更新用条件 UPDATE（WHERE status='submitted'）
 *          保证并发重复入库的幂等性（PRD FR-04）。
 * 适用场景：挂载于 /api/purchase-orders。
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

/** 明细 schema（安全修复 VULN-02：进价设置上限，防止超大数值导致总金额整数精度溢出） */
const itemSchema = z.object({
  productId: z.number({ invalid_type_error: '商品不能为空' }).int().positive(),
  quantity: z.number().int('数量必须为整数').min(1, '数量至少为 1').max(999999, '数量最多 999999'),
  unitPrice: z.number().int('进价必须为整数分').min(1, '进价必须大于 0').max(99999999, '进价不能超过 99999999 分（999999.99 元）'),
});

/** 单商品库存数量系统上限（安全修复 VULN-02：防止多次调整累计导致数值精度溢出） */
const MAX_STOCK = 999999999;

/**
 * 单张采购单总金额系统上限（分）——安全修复 R2-VULN-01
 * 背景：VULN-02 仅限制了单行 quantity/unitPrice（单行最大 subtotal ≈ 1e14 分），
 *      但一张单最多 200 行明细，多行聚合时 JS reduce 求和可越过
 *      Number.MAX_SAFE_INTEGER（约 9.007e15），产生精度丢失
 *      （实测 91 行满额明细入库总金额比精确值偏差 +1 分）。
 * 设定：上限 999999999999 分（约 99.99 亿元），对中小企业单笔采购足够宽松；
 *      在该上限内所有部分和 < 2^53，JS 整数累加全程精确，精度偏差不可能发生。
 */
const MAX_ORDER_TOTAL = 999999999999;

/** 创建/编辑 body schema */
const orderSchema = z.object({
  supplierId: z.number({ invalid_type_error: '供应商不能为空' }).int().positive('供应商不能为空'),
  remark: z.string().trim().max(200, '备注最多 200 字').nullable().optional(),
  items: z.array(itemSchema).min(1, '至少需要一条采购明细').max(200, '明细最多 200 行'),
});

const listQuery = z.object({
  keyword: z.string().trim().max(100).optional(),
  status: z.enum(['draft', 'submitted', 'received', 'cancelled']).optional(),
  startDate: z.string().trim().max(10).optional(),
  endDate: z.string().trim().max(10).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

/**
 * 生成采购单号：PO + yyyyMMdd + 4 位流水（按当日最大流水 +1）
 * @returns {string} 新单号，如 PO202609210001
 */
function generateOrderNo() {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const prefix = `PO${day}`;
  const last = db.prepare("SELECT order_no FROM purchase_orders WHERE order_no LIKE ? ORDER BY order_no DESC LIMIT 1").get(`${prefix}%`);
  let seq = 1;
  if (last) seq = parseInt(last.order_no.slice(prefix.length), 10) + 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

/**
 * 校验明细商品合法性并返回标准化明细
 * @param {Array<{productId:number, quantity:number, unitPrice:number}>} items 请求明细
 * @param {number|null} [excludeOrderId] 编辑草稿时排除自身（无额外影响，预留）
 * @returns {Array<{productId:number, quantity:number, unitPrice:number, name:string, sku:string}>} 校验后的明细
 * @throws {ApiError} 400：明细重复；404：商品不存在或已删除
 */
function validateItems(items, excludeOrderId = null) {
  const seen = new Set();
  const result = [];
  for (const it of items) {
    if (seen.has(it.productId)) throw new ApiError(400, 1006, '同一采购单内不允许出现重复商品');
    seen.add(it.productId);
    const p = db.prepare('SELECT id, name, sku, deleted_at FROM products WHERE id = ?').get(it.productId);
    if (!p || p.deleted_at) throw new ApiError(404, 1004, `商品不存在或已删除（ID: ${it.productId}）`);
    result.push({ ...it, name: p.name, sku: p.sku });
  }
  return result;
}

/* ---------------- GET /api/purchase-orders 分页列表（全部角色） ---------------- */
router.get('/', validate(null, listQuery), (req, res, next) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query);
    const { keyword, status, startDate, endDate } = req.query;

    const where = ['1=1'];
    const params = [];
    if (keyword) {
      // 通配符转义防语义篡改（VULN-06），参数化防注入
      // 注意：generateOrderNo 中的 LIKE 前缀拼接为内部生成的单号，非用户输入，无需转义
      where.push("(po.order_no LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')");
      params.push(`%${escapeLike(keyword)}%`, `%${escapeLike(keyword)}%`);
    }
    if (status) {
      where.push('po.status = ?');
      params.push(status);
    }
    if (startDate) {
      where.push("date(po.created_at) >= date(?)");
      params.push(startDate);
    }
    if (endDate) {
      where.push("date(po.created_at) <= date(?)");
      params.push(endDate);
    }
    const whereSql = where.join(' AND ');

    const total = db.prepare(`
      SELECT COUNT(*) AS c FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE ${whereSql}
    `).get(...params).c;
    const list = db.prepare(`
      SELECT po.id, po.order_no AS orderNo, po.supplier_id AS supplierId, s.name AS supplierName,
             po.status, po.total_amount AS totalAmount, po.remark, po.cancel_reason AS cancelReason,
             po.created_by AS createdBy, cu.real_name AS createdByName,
             po.submitted_at AS submittedAt, po.received_at AS receivedAt, ru.real_name AS receivedByName,
             po.created_at AS createdAt,
             (SELECT COUNT(*) FROM purchase_order_items i WHERE i.order_id = po.id) AS itemCount
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id
      JOIN users cu ON cu.id = po.created_by
      LEFT JOIN users ru ON ru.id = po.received_by
      WHERE ${whereSql}
      ORDER BY po.created_at DESC, po.id DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    res.json(ok({ list, total, page, pageSize }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- GET /api/purchase-orders/:id 详情（全部角色） ---------------- */
/* 字段契约：与列表端点一致，全部输出 camelCase（修复详情抽屉 snake_case/camelCase 断链）；
   supplierId 为编辑草稿回填所必需（与列表端点同样对外暴露，非敏感字段） */
router.get('/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    // 显式列出并别名字段，禁止 SELECT * 导致 snake_case 直接外漏
    const order = db.prepare(`
      SELECT po.id, po.order_no AS orderNo, po.supplier_id AS supplierId, po.status,
             po.total_amount AS totalAmount, po.remark, po.cancel_reason AS cancelReason,
             po.created_by AS createdBy, cu.real_name AS createdByName,
             po.submitted_at AS submittedAt, po.received_at AS receivedAt,
             ru.real_name AS receivedByName, po.created_at AS createdAt,
             s.name AS supplierName, s.status AS supplierStatus
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id
      JOIN users cu ON cu.id = po.created_by
      LEFT JOIN users ru ON ru.id = po.received_by
      WHERE po.id = ?
    `).get(id);
    if (!order) throw new ApiError(404, 1004, '采购单不存在');
    const items = db.prepare(`
      SELECT i.id, i.product_id AS productId, p.sku, p.name AS productName, p.unit,
             i.quantity, i.unit_price AS unitPrice, (i.quantity * i.unit_price) AS subtotal
      FROM purchase_order_items i JOIN products p ON p.id = i.product_id
      WHERE i.order_id = ? ORDER BY i.id
    `).all(id);
    res.json(ok({ ...order, items }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/purchase-orders 创建草稿（采购员/管理员） ---------------- */
router.post('/', rbac('purchaser'), validate(orderSchema), (req, res, next) => {
  try {
    const { supplierId, remark = null, items } = req.body;
    const supplier = db.prepare('SELECT id, name, status FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(supplierId);
    if (!supplier) throw new ApiError(404, 1004, '供应商不存在');
    if (supplier.status !== 1) throw new ApiError(400, 1006, '已停用的供应商不可用于新采购单');
    const normItems = validateItems(items);

    const now = new Date().toISOString();
    const result = db.transaction(() => {
      const orderNo = generateOrderNo();
      const total = normItems.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
      // 安全修复（R2-VULN-01）：单据总金额上限校验，拦截多行聚合越过 2^53 导致的精度丢失
      if (total > MAX_ORDER_TOTAL) throw new ApiError(400, 1006, '采购单总金额超出系统上限（9999999999.99 元），请核实明细金额');
      const oid = db.prepare(`
        INSERT INTO purchase_orders (order_no, supplier_id, status, total_amount, remark, created_by, created_at, updated_at)
        VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)
      `).run(orderNo, supplierId, total, remark, req.user.id, now, now).lastInsertRowid;
      const ins = db.prepare('INSERT INTO purchase_order_items (order_id, product_id, quantity, unit_price, created_at) VALUES (?, ?, ?, ?, ?)');
      for (const it of normItems) ins.run(oid, it.productId, it.quantity, it.unitPrice, now);
      return { id: oid, orderNo, total };
    })();

    writeAudit({ userId: req.user.id, username: req.user.username, action: 'create', module: 'purchase', target: result.orderNo, detail: { orderNo: result.orderNo, supplier: supplier.name, itemCount: normItems.length, totalAmount: result.total }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ id: result.id, orderNo: result.orderNo }, '创建成功'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- PUT /api/purchase-orders/:id 编辑草稿（采购员/管理员） ---------------- */
router.put('/:id', rbac('purchaser'), validate(orderSchema), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
    if (!order) throw new ApiError(404, 1004, '采购单不存在');
    if (order.status !== 'draft') throw new ApiError(400, 1006, '已提交的采购单不可编辑');

    const { supplierId, remark = null, items } = req.body;
    const supplier = db.prepare('SELECT id, name, status FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(supplierId);
    if (!supplier) throw new ApiError(404, 1004, '供应商不存在');
    // 供应商变更时要求合作中；未变更（含原供应商已停用）允许保留
    if (supplierId !== order.supplier_id && supplier.status !== 1) {
      throw new ApiError(400, 1006, '已停用的供应商不可用于新采购单');
    }
    const normItems = validateItems(items);

    const now = new Date().toISOString();
    db.transaction(() => {
      const total = normItems.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
      // 安全修复（R2-VULN-01）：编辑草稿同样执行单据总金额上限校验
      if (total > MAX_ORDER_TOTAL) throw new ApiError(400, 1006, '采购单总金额超出系统上限（9999999999.99 元），请核实明细金额');
      db.prepare('UPDATE purchase_orders SET supplier_id = ?, remark = ?, total_amount = ?, updated_at = ? WHERE id = ?')
        .run(supplierId, remark, total, now, id);
      db.prepare('DELETE FROM purchase_order_items WHERE order_id = ?').run(id);
      const ins = db.prepare('INSERT INTO purchase_order_items (order_id, product_id, quantity, unit_price, created_at) VALUES (?, ?, ?, ?, ?)');
      for (const it of normItems) ins.run(id, it.productId, it.quantity, it.unitPrice, now);
    })();

    writeAudit({ userId: req.user.id, username: req.user.username, action: 'update', module: 'purchase', target: order.order_no, detail: { id, supplierId, itemCount: normItems.length }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ id }, '更新成功'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- DELETE /api/purchase-orders/:id 删除草稿（采购员/管理员） ---------------- */
router.delete('/:id', rbac('purchaser'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
    if (!order) throw new ApiError(404, 1004, '采购单不存在');
    if (order.status !== 'draft') throw new ApiError(400, 1006, '仅草稿状态的采购单可删除');

    db.transaction(() => {
      db.prepare('DELETE FROM purchase_order_items WHERE order_id = ?').run(id);
      db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id);
    })();
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'delete', module: 'purchase', target: order.order_no, detail: { id, orderNo: order.order_no }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok(null, '删除成功'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/purchase-orders/:id/submit 提交（采购员/管理员） ---------------- */
router.post('/:id/submit', rbac('purchaser'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
    if (!order) throw new ApiError(404, 1004, '采购单不存在');
    if (order.status !== 'draft') throw new ApiError(400, 1006, '仅草稿状态的采购单可提交');

    const now = new Date().toISOString();
    // 提交时重算总金额并锁定明细（安全修复 R2-VULN-01：防御性二次校验单据总金额上限）
    const total = db.prepare('SELECT IFNULL(SUM(quantity * unit_price), 0) AS t FROM purchase_order_items WHERE order_id = ?').get(id).t;
    if (total > MAX_ORDER_TOTAL) throw new ApiError(400, 1006, '采购单总金额超出系统上限，无法提交，请核实明细金额');
    const r = db.prepare("UPDATE purchase_orders SET status = 'submitted', total_amount = ?, submitted_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'").run(total, now, now, id);
    if (r.changes === 0) throw new ApiError(400, 1006, '单据状态已变更，请刷新后重试');

    writeAudit({ userId: req.user.id, username: req.user.username, action: 'submit', module: 'purchase', target: order.order_no, detail: { id, orderNo: order.order_no, totalAmount: total }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ status: 'submitted' }, '提交成功'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/purchase-orders/:id/receive 入库确认（库管/管理员） ---------------- */
router.post('/:id/receive', rbac('stockkeeper'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
    if (!order) throw new ApiError(404, 1004, '采购单不存在');
    if (order.status === 'received') throw new ApiError(400, 1006, '单据状态已变更：该采购单已入库');
    if (order.status !== 'submitted') throw new ApiError(400, 1006, '仅已提交状态的采购单可入库确认');

    const now = new Date().toISOString();
    const items = db.prepare(`
      SELECT i.product_id AS productId, i.quantity, i.unit_price AS unitPrice, p.name, p.sku
      FROM purchase_order_items i JOIN products p ON p.id = i.product_id
      WHERE i.order_id = ?
    `).all(id);
    if (items.length === 0) throw new ApiError(400, 1006, '采购单明细为空，无法入库');

    // 事务：条件更新锁定状态（幂等） -> 逐条加库存 -> 写流水 -> 记录入库人/时间
    const receive = db.transaction(() => {
      // 条件更新锁定状态（幂等）：仅当仍为 submitted 时才生效
      const guard = db.prepare("UPDATE purchase_orders SET status = 'received', received_at = ?, received_by = ?, updated_at = ? WHERE id = ? AND status = 'submitted'")
        .run(now, req.user.id, now, id);
      if (guard.changes === 0) throw new ApiError(400, 1006, '单据状态已变更，请刷新后重试');

      for (const it of items) {
        const inv = db.prepare('SELECT id, quantity FROM inventory WHERE product_id = ?').get(it.productId);
        const before = inv ? inv.quantity : 0;
        const after = before + it.quantity;
        // 安全修复（VULN-02）：入库后数量不得超过系统上限，防止累计精度溢出（抛出后事务整体回滚）
        if (after > MAX_STOCK) throw new ApiError(400, 1006, '入库后库存超出系统上限（999999999），请核实采购数量');
        if (inv) {
          db.prepare('UPDATE inventory SET quantity = ?, updated_at = ?, updated_by = ? WHERE product_id = ?')
            .run(after, now, req.user.id, it.productId);
        } else {
          db.prepare('INSERT INTO inventory (product_id, quantity, warn_threshold, updated_at, updated_by) VALUES (?, ?, 10, ?, ?)')
            .run(it.productId, after, now, req.user.id);
        }
        db.prepare(`
          INSERT INTO inventory_logs (product_id, type, quantity, direction, before_quantity, after_quantity,
            ref_type, ref_id, ref_no, reason, operator_id, created_at)
          VALUES (?, 'purchase_in', ?, 1, ?, ?, 'purchase_order', ?, ?, NULL, ?, ?)
        `).run(it.productId, it.quantity, before, after, id, order.order_no, req.user.id, now);
      }
    });
    receive();

    writeAudit({ userId: req.user.id, username: req.user.username, action: 'receive', module: 'purchase', target: order.order_no, detail: { id, orderNo: order.order_no, itemCount: items.length, totalAmount: order.total_amount }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ status: 'received' }, '入库成功'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/purchase-orders/:id/cancel 取消（采购员/管理员） ---------------- */
const cancelSchema = z.object({ reason: z.string().trim().min(1, '取消原因不能为空').max(200, '取消原因最多 200 字') });

router.post('/:id/cancel', rbac('purchaser'), validate(cancelSchema), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
    if (!order) throw new ApiError(404, 1004, '采购单不存在');
    if (order.status !== 'draft' && order.status !== 'submitted') {
      throw new ApiError(400, 1006, '仅草稿或已提交状态的采购单可取消');
    }

    const now = new Date().toISOString();
    const r = db.prepare("UPDATE purchase_orders SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ? AND status IN ('draft','submitted')")
      .run(req.body.reason, now, id);
    if (r.changes === 0) throw new ApiError(400, 1006, '单据状态已变更，请刷新后重试');

    writeAudit({ userId: req.user.id, username: req.user.username, action: 'cancel', module: 'purchase', target: order.order_no, detail: { id, orderNo: order.order_no, reason: req.body.reason }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ status: 'cancelled' }, '已取消'));
  } catch (err) {
    next(err);
  }
});

export default router;
