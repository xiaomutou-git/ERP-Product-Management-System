/**
 * 商品分类路由（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：分类树查询（含每类商品数）、新增/修改/删除（库管权限）。
 * 设计思路：最多两级；同级名称唯一（用 IFNULL(parent_id,0) 归一化校验）；
 *          删除前校验分类下是否存在商品（含已软删除，防止外键悬空）与子分类。
 * 适用场景：挂载于 /api/categories。
 * 创建时间：2026-09-21
 */
import { Router } from 'express';
import { z } from 'zod';
import db from '../db/index.js';
import { ok, ApiError } from '../utils/response.js';
import { writeAudit, clientIp } from '../utils/audit.js';
import { authenticate, rbac } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';

const router = Router();
router.use(authenticate);

/* ---------------- GET /api/categories 分类树（全部角色） ---------------- */
router.get('/', (req, res, next) => {
  try {
    const cats = db.prepare(`
      SELECT c.id, c.name, c.parent_id AS parentId,
        (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.deleted_at IS NULL) AS productCount
      FROM categories c WHERE c.deleted_at IS NULL ORDER BY c.id
    `).all();

    // 组装两级树
    const roots = cats.filter((c) => c.parentId == null).map((c) => ({ ...c, children: [] }));
    const children = cats.filter((c) => c.parentId != null);
    for (const ch of children) {
      const parent = roots.find((r) => r.id === ch.parentId);
      if (parent) parent.children.push(ch);
    }
    res.json(ok(roots));
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/categories 新增分类（库管/管理员） ---------------- */
const catSchema = z.object({
  name: z.string().trim().min(1, '分类名称不能为空').max(50, '分类名称最多 50 字'),
  parentId: z.number().int().positive().nullable().optional(),
});

router.post('/', rbac('stockkeeper'), validate(catSchema), (req, res, next) => {
  try {
    const { name, parentId = null } = req.body;
    // 上级分类合法性（最多两级：父分类必须是一级）
    if (parentId != null) {
      const parent = db.prepare('SELECT id, parent_id FROM categories WHERE id = ? AND deleted_at IS NULL').get(parentId);
      if (!parent) throw new ApiError(404, 1004, '上级分类不存在');
      if (parent.parent_id != null) throw new ApiError(400, 1006, '分类最多支持两级');
    }
    // 同级重名校验（409）
    const dup = db.prepare('SELECT id FROM categories WHERE name = ? AND IFNULL(parent_id, 0) = IFNULL(?, 0) AND deleted_at IS NULL').get(name, parentId);
    if (dup) throw new ApiError(409, 1005, '同级下已存在同名分类');

    const now = new Date().toISOString();
    const id = db.prepare('INSERT INTO categories (name, parent_id, created_at) VALUES (?, ?, ?)').run(name, parentId, now).lastInsertRowid;
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'create', module: 'category', target: name, detail: { name, parentId }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ id, name, parentId }, '创建成功'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- PUT /api/categories/:id 修改分类（库管/管理员） ---------------- */
router.put('/:id', rbac('stockkeeper'), validate(catSchema), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cat = db.prepare('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cat) throw new ApiError(404, 1004, '分类不存在');
    const { name } = req.body;
    const parentId = cat.parent_id; // 本期不允许移动层级（两级结构固定）
    const dup = db.prepare('SELECT id FROM categories WHERE name = ? AND IFNULL(parent_id, 0) = IFNULL(?, 0) AND id != ? AND deleted_at IS NULL').get(name, parentId, id);
    if (dup) throw new ApiError(409, 1005, '同级下已存在同名分类');

    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'update', module: 'category', target: name, detail: { id, name }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ id, name, parentId }, '更新成功'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- DELETE /api/categories/:id 删除分类（库管/管理员） ---------------- */
router.delete('/:id', rbac('stockkeeper'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cat = db.prepare('SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cat) throw new ApiError(404, 1004, '分类不存在');

    // 存在商品（含已软删除）不允许删除（PRD FR-02 第 6 条）
    const productCount = db.prepare('SELECT COUNT(*) AS c FROM products WHERE category_id = ?').get(id).c;
    if (productCount > 0) throw new ApiError(400, 1006, `该分类下存在 ${productCount} 个商品，请先移除或转移商品后再删除`);
    // 存在子分类不允许删除，防止孤儿节点
    const childCount = db.prepare('SELECT COUNT(*) AS c FROM categories WHERE parent_id = ? AND deleted_at IS NULL').get(id).c;
    if (childCount > 0) throw new ApiError(400, 1006, `该分类下存在 ${childCount} 个子分类，请先删除子分类`);

    db.prepare('UPDATE categories SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'delete', module: 'category', target: cat.name, detail: { id }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok(null, '删除成功'));
  } catch (err) {
    next(err);
  }
});

export default router;
