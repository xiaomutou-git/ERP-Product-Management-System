/**
 * 商品路由（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：商品分页列表（名称/SKU 模糊搜索）、详情、新增/编辑（SKU 全局唯一
 *          校验、创建库存记录）、软删除（有库存时拒绝）。
 * 设计思路：搜索关键词一律参数化 LIKE 查询防注入（PRD S3）；SKU 唯一由
 *          UNIQUE 约束兜底并在业务层先行校验返回 409；商品创建时同步创建
 *          默认库存记录（数量 0，阈值默认 10）。
 * 适用场景：挂载于 /api/products。
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

/** 商品 body schema（新增/编辑共用） */
const productSchema = z.object({
  name: z.string().trim().min(1, '商品名称不能为空').max(100, '商品名称最多 100 字'),
  sku: z.string().trim().min(1, 'SKU 不能为空').max(50, 'SKU 最多 50 字符'),
  categoryId: z.number({ invalid_type_error: '分类不能为空' }).int().positive('分类不能为空'),
  unit: z.string().trim().min(1, '单位不能为空').max(10, '单位最多 10 字'),
  barcode: z.string().trim().max(64, '条形码最多 64 字符').nullable().optional(),
  spec: z.string().trim().max(100, '规格最多 100 字').nullable().optional(),
  salePrice: z.number().int('售价必须为整数分').min(0, '售价不能为负数').max(99999999, '售价不能超过 99999999 分（999999.99 元）').nullable().optional(),
  remark: z.string().trim().max(200, '备注最多 200 字').nullable().optional(),
  warnThreshold: z.number().int('阈值必须为整数').min(0, '阈值不能为负数').max(999999, '阈值不能超过 999999').optional(),
});

/** 列表查询 schema */
const listQuery = z.object({
  keyword: z.string().trim().max(100).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
  sort: z.enum(['created_at_asc', 'created_at_desc']).optional(),
});

/* ---------------- GET /api/products 分页列表（全部角色） ---------------- */
router.get('/', validate(null, listQuery), (req, res, next) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query);
    const { keyword, categoryId, sort = 'created_at_desc' } = req.query;

    const where = ['p.deleted_at IS NULL'];
    const params = [];
    // 模糊搜索：名称/SKU 做 OR 匹配（参数化防注入；通配符转义防语义篡改，VULN-06）
    if (keyword) {
      where.push("(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\')");
      params.push(`%${escapeLike(keyword)}%`, `%${escapeLike(keyword)}%`);
    }
    if (categoryId) {
      where.push('p.category_id = ?');
      params.push(categoryId);
    }
    const orderBy = sort === 'created_at_asc' ? 'p.created_at ASC' : 'p.created_at DESC';
    const whereSql = where.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) AS c FROM products p WHERE ${whereSql}`).get(...params).c;
    const list = db.prepare(`
      SELECT p.id, p.name, p.sku, p.barcode, p.category_id AS categoryId,
             c.name AS categoryName, cp.name AS parentCategoryName,
             p.unit, p.spec, p.sale_price AS salePrice, p.remark,
             IFNULL(i.quantity, 0) AS quantity, IFNULL(i.warn_threshold, 10) AS warnThreshold,
             (IFNULL(i.quantity, 0) <= IFNULL(i.warn_threshold, 10)) AS isLowStock,
             p.created_at AS createdAt
      FROM products p
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN categories cp ON cp.id = c.parent_id
      LEFT JOIN inventory i ON i.product_id = p.id
      WHERE ${whereSql}
      ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json(ok({ list, total, page, pageSize }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- GET /api/products/:id 商品详情（全部角色） ---------------- */
/* 字段契约：与列表端点一致，全部输出 camelCase（修复 SELECT * 导致的 snake_case 外漏） */
router.get('/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    // 显式列出并别名字段，禁止 SELECT * 导致 snake_case 直接外漏
    const row = db.prepare(`
      SELECT p.id, p.name, p.sku, p.barcode, p.category_id AS categoryId,
             c.name AS categoryName, cp.name AS parentCategoryName,
             p.unit, p.spec, p.sale_price AS salePrice, p.remark,
             IFNULL(i.quantity, 0) AS quantity, IFNULL(i.warn_threshold, 10) AS warnThreshold,
             (IFNULL(i.quantity, 0) <= IFNULL(i.warn_threshold, 10)) AS isLowStock,
             p.created_at AS createdAt
      FROM products p
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN categories cp ON cp.id = c.parent_id
      LEFT JOIN inventory i ON i.product_id = p.id
      WHERE p.id = ? AND p.deleted_at IS NULL
    `).get(id);
    if (!row) throw new ApiError(404, 1004, '商品不存在');
    res.json(ok(row));
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/products 新增商品（库管/管理员） ---------------- */
router.post('/', rbac('stockkeeper'), validate(productSchema), (req, res, next) => {
  try {
    const { name, sku, categoryId, unit, barcode = null, spec = null, salePrice = null, remark = null, warnThreshold = 10 } = req.body;

    const cat = db.prepare('SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL').get(categoryId);
    if (!cat) throw new ApiError(404, 1004, '所选分类不存在');
    // SKU 全局唯一（含软删除记录，防复用导致历史流水歧义）
    const dup = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
    if (dup) throw new ApiError(409, 1005, 'SKU 已存在');

    const now = new Date().toISOString();
    const create = db.transaction(() => {
      const id = db.prepare(`
        INSERT INTO products (name, sku, barcode, category_id, unit, spec, sale_price, remark, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, sku, barcode, categoryId, unit, spec, salePrice, remark, now, now).lastInsertRowid;
      // 同步创建默认库存记录：数量 0、阈值默认 10
      db.prepare('INSERT INTO inventory (product_id, quantity, warn_threshold, updated_at) VALUES (?, 0, ?, ?)').run(id, warnThreshold, now);
      return id;
    });
    const id = create();
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'create', module: 'product', target: sku, detail: { name, sku, categoryId }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ id }, '创建成功'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- PUT /api/products/:id 编辑商品（库管/管理员） ---------------- */
router.put('/:id', rbac('stockkeeper'), validate(productSchema), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!product) throw new ApiError(404, 1004, '商品不存在');
    const { name, sku, categoryId, unit, barcode = null, spec = null, salePrice = null, remark = null } = req.body;

    const cat = db.prepare('SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL').get(categoryId);
    if (!cat) throw new ApiError(404, 1004, '所选分类不存在');
    // SKU 唯一校验（排除自身，含软删除记录）
    const dup = db.prepare('SELECT id FROM products WHERE sku = ? AND id != ?').get(sku, id);
    if (dup) throw new ApiError(409, 1005, 'SKU 已存在');

    db.prepare(`
      UPDATE products SET name = ?, sku = ?, barcode = ?, category_id = ?, unit = ?, spec = ?, sale_price = ?, remark = ?, updated_at = ?
      WHERE id = ?
    `).run(name, sku, barcode, categoryId, unit, spec, salePrice, remark, new Date().toISOString(), id);
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'update', module: 'product', target: sku, detail: { id, name, sku }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ id }, '更新成功'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- DELETE /api/products/:id 软删除（库管/管理员） ---------------- */
router.delete('/:id', rbac('stockkeeper'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!product) throw new ApiError(404, 1004, '商品不存在');

    // 已有库存（数量 > 0）不允许删除（PRD FR-02 第 5 条）
    const inv = db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(id);
    if (inv && inv.quantity > 0) throw new ApiError(400, 1006, '该商品存在库存，无法删除');

    db.prepare('UPDATE products SET deleted_at = ?, updated_at = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), id);
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'delete', module: 'product', target: product.sku, detail: { id, sku: product.sku, name: product.name }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok(null, '删除成功'));
  } catch (err) {
    next(err);
  }
});

export default router;
