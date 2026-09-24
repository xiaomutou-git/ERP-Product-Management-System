/**
 * 供应商路由（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：供应商分页列表、详情、新增/编辑/启停/删除（采购员权限）。
 * 设计思路：名称全局唯一返回 409；电话/邮箱正则校验返回 400 字段级错误；
 *          已被采购单引用的供应商禁止删除；停用供应商不再出现在新建采购单下拉。
 * 适用场景：挂载于 /api/suppliers。
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

/** 电话：11 位手机号 或 带区号座机 */
const PHONE_RE = /^(1[3-9]\d{9}|0\d{2,3}-?\d{7,8})$/;
/** 邮箱格式 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const supplierSchema = z.object({
  name: z.string().trim().min(1, '供应商名称不能为空').max(100, '名称最多 100 字'),
  contactPerson: z.string().trim().max(20, '联系人最多 20 字').nullable().optional(),
  phone: z.string().trim().max(20, '电话最多 20 字').refine((v) => v === '' || PHONE_RE.test(v), '电话格式不正确').nullable().optional(),
  email: z.string().trim().max(100, '邮箱最多 100 字').refine((v) => v === '' || EMAIL_RE.test(v), '邮箱格式不正确').nullable().optional(),
  address: z.string().trim().max(200, '地址最多 200 字').nullable().optional(),
  remark: z.string().trim().max(200, '备注最多 200 字').nullable().optional(),
});

const listQuery = z.object({
  keyword: z.string().trim().max(100).optional(),
  status: z.coerce.number().int().min(0).max(1).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

/* ---------------- GET /api/suppliers 分页列表（全部角色） ---------------- */
router.get('/', validate(null, listQuery), (req, res, next) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query);
    const { keyword, status } = req.query;

    const where = ['s.deleted_at IS NULL'];
    const params = [];
    if (keyword) {
      // 通配符转义防语义篡改（VULN-06），参数化防注入
      where.push("s.name LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(keyword)}%`);
    }
    if (status !== undefined) {
      where.push('s.status = ?');
      params.push(status);
    }
    const whereSql = where.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) AS c FROM suppliers s WHERE ${whereSql}`).get(...params).c;
    const list = db.prepare(`
      SELECT s.id, s.name, s.contact_person AS contactPerson, s.phone, s.email, s.address,
             s.status, s.remark, s.created_at AS createdAt
      FROM suppliers s WHERE ${whereSql}
      ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    res.json(ok({ list, total, page, pageSize }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- GET /api/suppliers/:id 详情（全部角色） ---------------- */
/* 字段契约：与列表端点一致，全部输出 camelCase（修复 SELECT * 导致的 snake_case 外漏） */
router.get('/:id', (req, res, next) => {
  try {
    // 显式列出并别名字段，禁止 SELECT * 导致 snake_case 直接外漏
    const row = db.prepare(`
      SELECT s.id, s.name, s.contact_person AS contactPerson, s.phone, s.email, s.address,
             s.status, s.remark, s.created_at AS createdAt,
             (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id) AS orderCount
      FROM suppliers s WHERE s.id = ? AND s.deleted_at IS NULL
    `).get(Number(req.params.id));
    if (!row) throw new ApiError(404, 1004, '供应商不存在');
    res.json(ok(row));
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/suppliers 新增（采购员/管理员） ---------------- */
router.post('/', rbac('purchaser'), validate(supplierSchema), (req, res, next) => {
  try {
    const { name, contactPerson = null, phone = null, email = null, address = null, remark = null } = req.body;
    const dup = db.prepare('SELECT id FROM suppliers WHERE name = ? AND deleted_at IS NULL').get(name);
    if (dup) throw new ApiError(409, 1005, '供应商名称已存在');

    const now = new Date().toISOString();
    const id = db.prepare(`
      INSERT INTO suppliers (name, contact_person, phone, email, address, status, remark, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(name, contactPerson, phone, email, address, remark, now, now).lastInsertRowid;
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'create', module: 'supplier', target: name, detail: { name }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ id }, '创建成功'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- PUT /api/suppliers/:id 编辑（采购员/管理员） ---------------- */
router.put('/:id', rbac('purchaser'), validate(supplierSchema), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const sup = db.prepare('SELECT * FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!sup) throw new ApiError(404, 1004, '供应商不存在');
    const { name, contactPerson = null, phone = null, email = null, address = null, remark = null } = req.body;
    const dup = db.prepare('SELECT id FROM suppliers WHERE name = ? AND id != ? AND deleted_at IS NULL').get(name, id);
    if (dup) throw new ApiError(409, 1005, '供应商名称已存在');

    db.prepare(`
      UPDATE suppliers SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?, remark = ?, updated_at = ?
      WHERE id = ?
    `).run(name, contactPerson, phone, email, address, remark, new Date().toISOString(), id);
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'update', module: 'supplier', target: name, detail: { id, name }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ id }, '更新成功'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- PUT /api/suppliers/:id/status 启用/停用（采购员/管理员） ---------------- */
const statusSchema = z.object({ status: z.union([z.literal(0), z.literal(1)], { errorMap: () => ({ message: 'status 仅允许 0 或 1' }) }) });

router.put('/:id/status', rbac('purchaser'), validate(statusSchema), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const sup = db.prepare('SELECT * FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!sup) throw new ApiError(404, 1004, '供应商不存在');
    db.prepare('UPDATE suppliers SET status = ?, updated_at = ? WHERE id = ?').run(req.body.status, new Date().toISOString(), id);
    writeAudit({
      userId: req.user.id, username: req.user.username, action: 'update', module: 'supplier', target: sup.name,
      detail: { id, status: req.body.status, action: req.body.status === 1 ? '启用' : '停用' },
      ip: clientIp(req), userAgent: req.headers['user-agent'],
    });
    res.json(ok({ id, status: req.body.status }, req.body.status === 1 ? '已启用' : '已停用'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- DELETE /api/suppliers/:id 删除（采购员/管理员） ---------------- */
router.delete('/:id', rbac('purchaser'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const sup = db.prepare('SELECT * FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!sup) throw new ApiError(404, 1004, '供应商不存在');
    // 已被采购单引用不允许删除（PRD FR-03 第 3 条）
    const ref = db.prepare('SELECT COUNT(*) AS c FROM purchase_orders WHERE supplier_id = ?').get(id).c;
    if (ref > 0) throw new ApiError(400, 1006, '该供应商已被采购单引用，无法删除');

    db.prepare('UPDATE suppliers SET deleted_at = ?, updated_at = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), id);
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'delete', module: 'supplier', target: sup.name, detail: { id }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok(null, '删除成功'));
  } catch (err) {
    next(err);
  }
});

export default router;
