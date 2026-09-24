/**
 * 用户管理路由（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：用户分页列表、新增、编辑（姓名/角色/状态）、重置密码、解锁、软删除。
 * 设计思路：仅管理员可访问（rbac('admin')）——admin 之外无角色可进入；
 *          业务保护：禁止停用/删除自己；系统至少保留 1 个启用 admin；
 *          重置密码后目标用户 must_change_password=1 且 token_version+1 强制下线。
 * 适用场景：挂载于 /api/users。
 * 创建时间：2026-09-21
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import db from '../db/index.js';
import { ok, ApiError, parsePaging, escapeLike } from '../utils/response.js';
import { writeAudit, clientIp } from '../utils/audit.js';
import { authenticate, rbac } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';

const router = Router();
router.use(authenticate, rbac('admin'));

/** 用户名规则：3~20 位字母/数字/下划线 */
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
/** 密码规则：8~32 位且同时包含字母与数字 */
const pwd = z.string().min(8, '密码至少 8 位').max(32, '密码最多 32 位')
  .regex(/[A-Za-z]/, '密码必须同时包含字母和数字')
  .regex(/\d/, '密码必须同时包含字母和数字');

const listQuery = z.object({
  keyword: z.string().trim().max(20).optional(),
  roleCode: z.enum(['admin', 'purchaser', 'stockkeeper', 'viewer']).optional(),
  status: z.coerce.number().int().min(0).max(1).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

const createSchema = z.object({
  username: z.string().trim().regex(USERNAME_RE, '用户名须为 3~20 位字母/数字/下划线'),
  password: pwd,
  realName: z.string().trim().min(1, '姓名不能为空').max(20, '姓名最多 20 字'),
  roleCode: z.enum(['admin', 'purchaser', 'stockkeeper', 'viewer']),
});

const updateSchema = z.object({
  realName: z.string().trim().min(1, '姓名不能为空').max(20, '姓名最多 20 字'),
  roleCode: z.enum(['admin', 'purchaser', 'stockkeeper', 'viewer']),
  status: z.union([z.literal(0), z.literal(1)]),
});

/* ---------------- GET /api/users 用户分页列表 ---------------- */
router.get('/', validate(null, listQuery), (req, res, next) => {
  try {
    const { page, pageSize, offset } = parsePaging(req.query);
    const { keyword, roleCode, status } = req.query;

    const where = ['u.deleted_at IS NULL'];
    const params = [];
    if (keyword) {
      // 通配符转义防语义篡改（VULN-06），参数化防注入
      where.push("(u.username LIKE ? ESCAPE '\\' OR u.real_name LIKE ? ESCAPE '\\')");
      params.push(`%${escapeLike(keyword)}%`, `%${escapeLike(keyword)}%`);
    }
    if (roleCode) {
      where.push('r.code = ?');
      params.push(roleCode);
    }
    if (status !== undefined) {
      where.push('u.status = ?');
      params.push(status);
    }
    const whereSql = where.join(' AND ');

    const total = db.prepare(`
      SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id WHERE ${whereSql}
    `).get(...params).c;
    const list = db.prepare(`
      SELECT u.id, u.username, u.real_name AS realName, r.code AS roleCode, r.name AS roleName,
             u.status, u.last_login_at AS lastLoginAt, u.must_change_password AS mustChangePassword,
             u.locked_until AS lockedUntil, u.failed_attempts AS failedAttempts, u.created_at AS createdAt
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE ${whereSql}
      ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    // 附加"是否处于登录锁定"标记
    const now = Date.now();
    for (const row of list) {
      row.locked = !!(row.lockedUntil && new Date(row.lockedUntil).getTime() > now);
    }
    res.json(ok({ list, total, page, pageSize }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/users 新增用户 ---------------- */
router.post('/', validate(createSchema), (req, res, next) => {
  try {
    const { username, password, realName, roleCode } = req.body;
    const dup = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (dup) throw new ApiError(409, 1005, '用户名已存在');
    const role = db.prepare('SELECT id FROM roles WHERE code = ?').get(roleCode);
    if (!role) throw new ApiError(404, 1004, '角色不存在');

    const now = new Date().toISOString();
    // 新建用户默认标记首登强制改密（PRD FR-07 第 3 条精神）
    const id = db.prepare(`
      INSERT INTO users (username, password_hash, real_name, role_id, status, token_version, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, 1, ?, ?)
    `).run(username, bcrypt.hashSync(password, 10), realName, role.id, now, now).lastInsertRowid;
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'create', module: 'user', target: username, detail: { id, username, roleCode, realName }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ id }, '创建成功，该用户首次登录需修改密码'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- PUT /api/users/:id 编辑（姓名/角色/状态） ---------------- */
router.put('/:id', validate(updateSchema), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = db.prepare(`
      SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ? AND u.deleted_at IS NULL
    `).get(id);
    if (!user) throw new ApiError(404, 1004, '用户不存在');
    const { realName, roleCode, status } = req.body;

    // 禁止停用自己（PRD FR-07 第 2 条）
    if (id === req.user.id && status === 0) throw new ApiError(400, 1006, '不能停用自己');
    // 系统至少保留 1 个启用的 admin（当目标为启用 admin 且操作后不再是启用 admin）
    if (user.role_code === 'admin' && user.status === 1 && (status === 0 || roleCode !== 'admin')) {
      const activeAdmins = db.prepare(`
        SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.code = 'admin' AND u.status = 1 AND u.deleted_at IS NULL AND u.id != ?
      `).get(id).c;
      if (activeAdmins === 0) throw new ApiError(400, 1006, '系统至少需保留一个启用的管理员');
    }

    const role = db.prepare('SELECT id FROM roles WHERE code = ?').get(roleCode);
    if (!role) throw new ApiError(404, 1004, '角色不存在');
    // 角色/状态变更使旧 token 失效（权限即时生效）
    db.prepare('UPDATE users SET real_name = ?, role_id = ?, status = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?')
      .run(realName, role.id, status, new Date().toISOString(), id);
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'update', module: 'user', target: user.username, detail: { id, realName, roleCode, status }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok({ id }, '更新成功'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- PUT /api/users/:id/reset-password 重置密码 ---------------- */
const resetPwdSchema = z.object({ newPassword: pwd });

router.put('/:id/reset-password', validate(resetPwdSchema), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!user) throw new ApiError(404, 1004, '用户不存在');

    // 重置后目标用户下次登录强制改密；旧 token 全部失效
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
      .run(bcrypt.hashSync(req.body.newPassword, 10), new Date().toISOString(), id);
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'reset_password', module: 'user', target: user.username, detail: { id }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok(null, '密码已重置，该用户下次登录将被要求修改密码'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/users/:id/unlock 解除登录锁定 ---------------- */
router.post('/:id/unlock', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!user) throw new ApiError(404, 1004, '用户不存在');
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'unlock', module: 'user', target: user.username, detail: { id }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok(null, '已解除登录锁定'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- DELETE /api/users/:id 软删除 ---------------- */
router.delete('/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = db.prepare(`
      SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ? AND u.deleted_at IS NULL
    `).get(id);
    if (!user) throw new ApiError(404, 1004, '用户不存在');
    if (id === req.user.id) throw new ApiError(400, 1006, '不能删除自己');
    if (user.role_code === 'admin' && user.status === 1) {
      const activeAdmins = db.prepare(`
        SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.code = 'admin' AND u.status = 1 AND u.deleted_at IS NULL AND u.id != ?
      `).get(id).c;
      if (activeAdmins === 0) throw new ApiError(400, 1006, '系统至少需保留一个启用的管理员');
    }
    // 已产生业务数据的账号不允许物理删除，一律软删除（PRD 2.3 第 5 条）
    db.prepare('UPDATE users SET deleted_at = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), id);
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'delete', module: 'user', target: user.username, detail: { id }, ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.json(ok(null, '删除成功'));
  } catch (err) {
    next(err);
  }
});

export default router;
