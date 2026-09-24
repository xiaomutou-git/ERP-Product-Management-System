/**
 * 认证路由（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：登录（含失败锁定、限流）、刷新令牌（轮换 + 重放检测）、登出、
 *          个人信息、修改本人密码。
 * 设计思路：登录失败锁定策略——同一账号连续 5 次密码错误锁定 15 分钟，
 *          锁定期间无论密码正确与否统一返回 423；登录成功清零失败计数；
 *          改密成功后 token_version+1 使旧 token 全失效。
 *          安全加固（2026-09-24，token 存储迁移）：双令牌一律经 HttpOnly Cookie
 *          下发（accessToken path=/，refreshToken path 收窄 /api/auth），响应 JSON
 *          不再返回任何 token 明文；/refresh 仅从 Cookie 读取 refreshToken；
 *          登出清除两类 Cookie。
 *          安全加固（2026-09-24，refresh 轮换 + 重放检测）：refresh token 签发时
 *          携带唯一 jti 并落库 refresh_tokens（status=active）；/refresh 校验签名
 *          与过期后查 jti 状态——active 则轮换（旧行置 rotated 记 replaced_by，
 *          签发全新 refresh + access 双 Cookie，滑动续期 7 天）；rotated/revoked
 *          判定为重放（可能泄露），立即撤销该用户全部 active refresh token 并
 *          token_version+1 全端失效，返回 401 并写审计日志 refresh_replay_detected；
 *          jti 不存在（伪造/未知）返回 401。登出将当前 jti 置 revoked。
 *          安全加固（2026-09-24，宽限窗口）：修复多 tab 并发竞态误伤——同一旧
 *          refresh token 被多标签页并发刷新时，后到者命中 rotated 不再直接判重放：
 *          宽限窗口内（REFRESH_GRACE_PERIOD_SECONDS，默认 30 秒，设 0 关闭）视为
 *          竞态，沿 replaced_by 链复用家族当前 active 叶子令牌换发 access cookie
 *          （叶子不轮换、窗口不重置），写审计 refresh_grace_reuse；窗口外 rotated
 *          复用与 revoked 复用仍走重放防护（全端撤销 + tv+1 + 审计 + 401）。
 * 适用场景：挂载于 /api/auth。
 * 创建时间：2026-09-21（2026-09-24 安全加固：refresh 轮换 + 重放检测 + 宽限窗口）
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import db from '../db/index.js';
import { ok, ApiError } from '../utils/response.js';
import { signAccess, signRefresh, verifyToken, accessTtl, refreshTtl } from '../utils/jwt.js';
import { issueRefreshToken, getRefreshToken, markRotated, findActiveLeafFromChain, revokeRefreshToken, revokeAllActiveForUser } from '../utils/refreshTokenStore.js';
import { writeAudit, clientIp } from '../utils/audit.js';
import { authenticate } from '../middlewares/auth.js';
import { setAuthCookies, setAccessCookie, setRefreshCookie, clearAuthCookies, REFRESH_COOKIE } from '../utils/cookies.js';
import { validate } from '../middlewares/validate.js';
import { loginLimiter } from '../middlewares/rateLimit.js';

const router = Router();

/** 用户名规则：3~20 位字母/数字/下划线 */
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

/**
 * refresh 轮换宽限窗口（毫秒）——多 tab 并发竞态容忍期
 * 来源：环境变量 REFRESH_GRACE_PERIOD_SECONDS（单位：秒，默认 30；设为 0 关闭宽限，
 *      回到严格重放模式；非法/负值按 0 处理即 fail-closed 收紧到严格模式）。
 * 安全边界说明：宽限窗口内的旧令牌复用不触发全端撤销，仅复用家族当前 active 叶子
 *      换发 access token（叶子不轮换、窗口以首次轮换的 rotated_at 为准不重置）；
 *      窗口默认 30 秒远小于 refresh 7 天有效期，攻击者即使窃取旧令牌也只能在该
 *      短窗内换取与合法用户同源的会话，且每次复用均留审计日志（refresh_grace_reuse）
 *      可供监测，风险可控。
 */
const GRACE_PERIOD_MS = (function parseGracePeriodMs() {
  const seconds = parseInt(process.env.REFRESH_GRACE_PERIOD_SECONDS || '30', 10);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 0) * 1000;
})();

/**
 * 占位 bcrypt 哈希（安全修复 VULN-07）
 * 说明：对"用户不存在"的登录请求也执行一次等代价（cost=10）的 bcrypt 比对，
 *      使"用户不存在"与"密码错误"的响应耗时趋于一致，防止通过时序差枚举有效用户名。
 *      该哈希对应一个随机无意义密码，永远不会匹配成功。
 */
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('timing-attack-mitigation-placeholder-' + Math.random(), 10);

/* ---------------- POST /api/auth/login 登录（公开，限流 10 次/分/IP） ---------------- */
const loginSchema = z.object({
  username: z.string().min(1, '用户名不能为空').max(20, '用户名过长'),
  password: z.string().min(1, '密码不能为空').max(64, '密码过长'),
});

router.post('/login', loginLimiter, validate(loginSchema), (req, res, next) => {
  try {
    const { username, password } = req.body;
    const ip = clientIp(req);
    const ua = req.headers['user-agent'] || null;
    const user = db.prepare(`
      SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.username = ? AND u.deleted_at IS NULL
    `).get(username);

    // 用户不存在：直接按密码错误处理，不泄露账号是否存在
    if (!user) {
      // 恒时缓解（VULN-07）：与真实用户密码比对同代价的 bcrypt 运算，抹平时序差
      bcrypt.compareSync(password, DUMMY_BCRYPT_HASH);
      writeAudit({ userId: null, username, action: 'login_failed', module: 'auth', target: username, detail: { reason: '用户名不存在或密码错误' }, ip, userAgent: ua });
      throw new ApiError(400, 1006, '用户名或密码错误，或账号已被锁定');
    }

    // 停用账号：给出明确提示（PRD 2.3 第 4 条）
    if (user.status !== 1) {
      writeAudit({ userId: user.id, username, action: 'login_failed', module: 'auth', target: username, detail: { reason: '账号已停用' }, ip, userAgent: ua });
      throw new ApiError(403, 1003, '账号已停用，请联系管理员');
    }

    // 锁定校验：锁定期间无论密码对错统一 423（满足验收 A02）
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      writeAudit({ userId: user.id, username, action: 'login_failed', module: 'auth', target: username, detail: { reason: '账号锁定期间尝试登录' }, ip, userAgent: ua });
      throw new ApiError(423, 1007, '账号已锁定，请 15 分钟后重试');
    }

    // 密码校验
    if (!bcrypt.compareSync(password, user.password_hash)) {
      const failed = user.failed_attempts + 1;
      let lockedUntil = null;
      if (failed >= 5) lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 连续 5 次错误锁定 15 分钟
      db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?')
        .run(failed, lockedUntil, new Date().toISOString(), user.id);
      writeAudit({ userId: user.id, username, action: 'login_failed', module: 'auth', target: username, detail: { reason: '密码错误', failedAttempts: failed, locked: !!lockedUntil }, ip, userAgent: ua });
      throw new ApiError(400, 1006, '用户名或密码错误，或账号已被锁定');
    }

    // 登录成功：清零失败计数、清空锁定、更新最近登录时间
    db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), new Date().toISOString(), user.id);
    writeAudit({ userId: user.id, username, action: 'login_success', module: 'auth', target: username, detail: null, ip, userAgent: ua });

    const payloadUser = { id: user.id, username: user.username, tokenVersion: user.token_version };
    // 安全加固（2026-09-24 refresh 轮换）：签发带唯一 jti 的 refresh token，
    // 并在 refresh_tokens 表写入 active 会话行（过期时间与 JWT exp 同源），
    // 为 /refresh 的轮换与重放检测提供服务端依据
    const refreshJti = randomUUID();
    issueRefreshToken({ jti: refreshJti, userId: user.id, expiresAt: Date.now() + refreshTtl() * 1000 });
    // 安全加固（token 存储迁移）：双令牌写入 HttpOnly Cookie，不再进入响应 JSON，
    // 由浏览器自动携带（前端 JS 不可读），杜绝 XSS 窃取令牌的渠道
    setAuthCookies(res, {
      accessToken: signAccess(payloadUser),
      refreshToken: signRefresh(payloadUser, refreshJti),
    });
    // 响应体仅含非敏感数据：expiresIn 供前端了解会话时长，user 供 Pinia 展示
    res.json(ok({
      expiresIn: accessTtl(),
      user: {
        id: user.id,
        username: user.username,
        realName: user.real_name,
        role: user.role_code,
        mustChangePassword: user.must_change_password === 1,
      },
    }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/auth/refresh 刷新令牌（公开；轮换 + 重放检测，凭据取自 HttpOnly Cookie） ---------------- */
router.post('/refresh', (req, res, next) => {
  try {
    // 安全加固（token 存储迁移）：refreshToken 一律从 HttpOnly Cookie 读取
    // （Cookie path 收窄为 /api/auth，仅认证接口可携带），不再接受 body 传参，
    // 避免令牌进入前端 JS 可读的请求体；缺失/无效统一 401 引导重新登录。
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!refreshToken) throw new ApiError(401, 1002, '登录状态已失效，请重新登录');

    let payload;
    try {
      payload = verifyToken(refreshToken);
    } catch {
      throw new ApiError(401, 1002, '登录状态已失效，请重新登录');
    }
    if (payload.type !== 'refresh') throw new ApiError(401, 1002, '登录状态已失效，请重新登录');

    // 安全加固（2026-09-24 轮换）：payload 必须携带 jti（旧版本无 jti 的令牌
    // 一律拒绝，需重新登录换取新会话），否则无法进行服务端状态判定
    const jti = payload.jti;
    if (!jti) throw new ApiError(401, 1002, '登录状态已失效，请重新登录');

    // jti 不存在（伪造令牌/记录已被过期清理）→ 401
    const tokenRow = getRefreshToken(jti);
    if (!tokenRow) throw new ApiError(401, 1002, '登录状态已失效，请重新登录');

    // ===== 状态分流（2026-09-24 宽限窗口加固）：jti 状态非 active 时按三段处置 =====
    // a) rotated 且在宽限窗口内（now - rotated_at <= GRACE_PERIOD_MS）：多 tab 并发竞态
    //    ——同一浏览器多个标签页同时持有同一旧 refresh token 并发刷新，后到者命中
    //    rotated，若按重放处置会误伤正常用户（全端撤销+跳登录）。改为沿 replaced_by
    //    溯源链找到家族当前 active 叶子令牌，直接以其所属用户信息换发新 access cookie
    //    （叶子不轮换、宽限窗口以原 rotated_at 为准不重置，即复用叶子），返回 200；
    //    写审计日志 refresh_grace_reuse（区别于攻击事件）供安全监测。
    //    链上找不到可用 active 叶子（叶子已被撤销/过期）则按重放处理；
    //    历史已轮换行 rotated_at 为 NULL（本版本升级前产生）同样不在宽限内，按重放处理。
    // b) rotated 但已超宽限窗口：维持重放防护（窗口外复用旧令牌是泄露信号）。
    // c) revoked（用户主动登出/被撤销的令牌）：无宽限，直接按重放防护处理——明确攻击信号。
    if (tokenRow.status !== 'active') {
      const withinGrace = tokenRow.status === 'rotated'
        && tokenRow.rotated_at != null
        && GRACE_PERIOD_MS > 0
        && Date.now() - tokenRow.rotated_at <= GRACE_PERIOD_MS;

      if (withinGrace) {
        const graceLeaf = findActiveLeafFromChain(jti);
        if (graceLeaf) {
          // 与 active 路径一致的用户校验：存在、未软删除、启用、token_version 与旧令牌
          // payload 一致——改密/全端失效后旧令牌即使落在宽限内也不放行，直接 401
          const graceUser = db.prepare('SELECT id, username, token_version, status FROM users WHERE id = ? AND deleted_at IS NULL').get(tokenRow.user_id);
          if (graceUser && graceUser.status === 1 && graceUser.token_version === payload.tv) {
            writeAudit({
              userId: graceUser.id,
              username: graceUser.username,
              action: 'refresh_grace_reuse',
              module: 'auth',
              target: jti,
              detail: { leafJti: graceLeaf.jti, rotatedAt: tokenRow.rotated_at, gracePeriodMs: GRACE_PERIOD_MS },
              ip: clientIp(req),
              userAgent: req.headers['user-agent'] || null,
            });
            // 仅换发新 access cookie（叶子不轮换、不签发新 refresh、不重置宽限窗口）；
            // 浏览器侧的 refresh cookie 已由先到的并发请求更新为叶子令牌
            setAccessCookie(res, signAccess({ id: graceUser.id, username: graceUser.username, tokenVersion: graceUser.token_version }));
            return res.json(ok({ expiresIn: accessTtl() }));
          }
          // 用户已删除/停用或 token_version 已变化：宽限不放行，清 Cookie 后 401
          //（与 active 路径用户校验失败行为一致：普通 401，不触发全端撤销）
          clearAuthCookies(res);
          throw new ApiError(401, 1002, '登录状态已失效，请重新登录');
        }
        // 链上无可用 active 叶子（叶子已被撤销/过期）→ 落入下方重放防护
      }

      // 重放防护（b/c 段及"宽限内但无可用叶子"情形）：令牌被二次使用——极可能已泄露。
      // 处置：① 撤销该用户全部 active refresh token；② token_version+1 全端失效（含 access）；
      // ③ 写审计日志（refresh_replay_detected，含 user_id/jti/IP）；④ 清除 Cookie 并返回 401。
      const replayUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(tokenRow.user_id);
      revokeAllActiveForUser(tokenRow.user_id);
      db.prepare('UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), tokenRow.user_id);
      writeAudit({
        userId: tokenRow.user_id,
        username: replayUser?.username || payload.username || 'unknown',
        action: 'refresh_replay_detected',
        module: 'auth',
        target: jti,
        detail: { status: tokenRow.status, replacedBy: tokenRow.replaced_by, withinGrace },
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] || null,
      });
      clearAuthCookies(res);
      throw new ApiError(401, 1002, '检测到会话令牌重放，全部会话已失效，请重新登录');
    }

    // 双保险：JWT 签名有效但会话行已过期（正常场景被 jwt 过期校验先行拦截，
    // 仅时钟偏移等极端情况触发）；置 revoked 后要求重新登录
    if (tokenRow.expires_at < Date.now()) {
      db.prepare("UPDATE refresh_tokens SET status = 'revoked' WHERE jti = ?").run(jti);
      throw new ApiError(401, 1002, '登录状态已失效，请重新登录');
    }

    const user = db.prepare('SELECT id, username, token_version, status FROM users WHERE id = ? AND deleted_at IS NULL').get(payload.sub);
    if (!user || user.status !== 1 || user.token_version !== payload.tv) {
      throw new ApiError(401, 1002, '登录状态已失效，请重新登录');
    }

    // 轮换（rotation）：旧 jti 置 rotated 并记录 replaced_by 溯源链，
    // 签发全新 jti 的 refresh token（滑动续期 7 天）+ 新 access token，
    // 全部经 Set-Cookie 下发；此后旧令牌再使用即触发重放防护
    const newJti = randomUUID();
    markRotated(jti, newJti);
    issueRefreshToken({ jti: newJti, userId: user.id, expiresAt: Date.now() + refreshTtl() * 1000 });
    const payloadUser = { id: user.id, username: user.username, tokenVersion: user.token_version };
    setAccessCookie(res, signAccess(payloadUser));
    setRefreshCookie(res, signRefresh(payloadUser, newJti));
    res.json(ok({ expiresIn: accessTtl() }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- POST /api/auth/logout 登出（令牌全端失效 + 清除 Cookie + 记录审计） ---------------- */
router.post('/logout', authenticate, (req, res, next) => {
  try {
    // 安全加固（2026-09-24 refresh 轮换）：登出时先把当前 refresh token 的 jti
    // 置为 revoked（服务端撤销该会话行），再走现有 token_version 全端失效逻辑；
    // 这样即使登出后 refresh Cookie 因故残留，其 jti 状态也已是非 active，
    // 二次使用会直接进入 /refresh 的重放防护分支被全端止损。
    // 令牌无 jti（历史令牌）或解析失败均不影响登出主流程（tv+1 已兜底）。
    const refreshTokenCookie = req.cookies?.[REFRESH_COOKIE];
    if (refreshTokenCookie) {
      try {
        const logoutPayload = verifyToken(refreshTokenCookie);
        if (logoutPayload.type === 'refresh' && logoutPayload.jti) {
          revokeRefreshToken(logoutPayload.jti);
        }
      } catch {
        // refresh token 无效/过期：不影响登出主流程
      }
    }
    // 安全修复（VULN-01）：登出必须使令牌失效，防止被盗 token 在登出后继续使用。
    // 通过 token_version + 1 使该用户当前全部 access/refresh token 立即失效
    // （authenticate 与 refresh 均校验 tv 与库中值一致，不一致返回 401）。
    // 注意：该策略为"全端失效"——同一账号在其他设备的会话也会一并下线，属安全优先取舍。
    db.prepare('UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), req.user.id);
    writeAudit({ userId: req.user.id, username: req.user.username, action: 'logout', module: 'auth', target: req.user.username, detail: null, ip: clientIp(req), userAgent: req.headers['user-agent'] || null });
    // 安全加固（token 存储迁移）：登出同步清除两类 HttpOnly Cookie（maxAge=0 立即过期）
    clearAuthCookies(res);
    res.json(ok(null, '已退出登录'));
  } catch (err) {
    next(err);
  }
});

/* ---------------- GET /api/auth/me 当前用户信息 ---------------- */
router.get('/me', authenticate, (req, res, next) => {
  try {
    res.json(ok({
      id: req.user.id,
      username: req.user.username,
      realName: req.user.realName,
      role: req.user.role,
      mustChangePassword: req.user.mustChangePassword,
    }));
  } catch (err) {
    next(err);
  }
});

/* ---------------- PUT /api/auth/password 修改本人密码 ---------------- */
const pwdSchema = z.object({
  oldPassword: z.string().min(1, '原密码不能为空'),
  newPassword: z.string()
    .min(8, '新密码至少 8 位').max(32, '新密码最多 32 位')
    .regex(/[A-Za-z]/, '新密码必须同时包含字母和数字')
    .regex(/\d/, '新密码必须同时包含字母和数字'),
});

router.put('/password', authenticate, validate(pwdSchema), (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.user.id);
    if (!row) throw new ApiError(404, 1004, '用户不存在');
    if (!bcrypt.compareSync(req.body.oldPassword, row.password_hash)) {
      throw new ApiError(400, 1006, '原密码不正确');
    }

    // 改密：更新哈希 + token_version+1（旧 token 全失效）+ 清除强制改密标记与登录锁定计数
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE users SET password_hash = ?, token_version = token_version + 1,
        must_change_password = 0, failed_attempts = 0, locked_until = NULL, updated_at = ?
      WHERE id = ?
    `).run(bcrypt.hashSync(req.body.newPassword, 10), now, row.id);
    writeAudit({ userId: row.id, username: row.username, action: 'change_password', module: 'auth', target: row.username, detail: null, ip: clientIp(req), userAgent: req.headers['user-agent'] || null });
    res.json(ok(null, '密码修改成功，请重新登录'));
  } catch (err) {
    next(err);
  }
});

export default router;
