/**
 * 数据库建表脚本（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：按 PRD 第 5 章数据模型创建全部 10 张表及索引、预置角色数据。
 * 设计思路：金额一律以"分"为单位存 INTEGER；时间为 ISO8601 UTC 文本；
 *          软删除使用 deleted_at；只增表（inventory_logs / audit_logs）
 *          不提供任何更新删除入口；SKU/用户名/供应商名以 UNIQUE 约束兜底。
 * 适用场景：服务启动时自动执行（幂等，使用 IF NOT EXISTS）。
 * 创建时间：2026-09-21
 */
import db from './index.js';

/**
 * 初始化全部表结构与预置角色
 * @returns {void} 无返回值
 * @throws {Error} SQL 语法错误或磁盘故障时抛出，服务启动将失败
 */
export function initSchema() {
  db.exec(`
    /* 1. 角色表：预置 4 个固定角色，权限在代码中按 role code 判定 */
    CREATE TABLE IF NOT EXISTS roles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      description TEXT
    );

    /* 2. 用户表：密码 bcrypt 哈希存储；token_version 支持改密后全端失效 */
    CREATE TABLE IF NOT EXISTS users (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      username             TEXT    NOT NULL UNIQUE,
      password_hash        TEXT    NOT NULL,
      real_name            TEXT    NOT NULL,
      role_id              INTEGER NOT NULL REFERENCES roles(id),
      status               INTEGER NOT NULL DEFAULT 1,          -- 1=启用 0=停用
      token_version        INTEGER NOT NULL DEFAULT 0,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      last_login_at        TEXT,
      locked_until         TEXT,
      failed_attempts      INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT    NOT NULL,
      updated_at           TEXT    NOT NULL,
      deleted_at           TEXT
    );

    /* 3. 商品分类表：最多两级；同级名称唯一（parent_id 为 NULL 用表达式索引兜底） */
    CREATE TABLE IF NOT EXISTS categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      parent_id  INTEGER REFERENCES categories(id),
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name_parent
      ON categories(name, IFNULL(parent_id, 0));

    /* 4. 商品表：SKU 全局唯一（含软删除记录，由 UNIQUE 约束保证不可复用） */
    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      sku         TEXT    NOT NULL UNIQUE,
      barcode     TEXT,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      unit        TEXT    NOT NULL,
      spec        TEXT,
      sale_price  INTEGER,
      remark      TEXT,
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL,
      deleted_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

    /* 5. 供应商表 */
    CREATE TABLE IF NOT EXISTS suppliers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT    NOT NULL UNIQUE,
      contact_person TEXT,
      phone          TEXT,
      email          TEXT,
      address        TEXT,
      status         INTEGER NOT NULL DEFAULT 1,                -- 1=合作中 0=已停用
      remark         TEXT,
      created_at     TEXT    NOT NULL,
      updated_at     TEXT    NOT NULL,
      deleted_at     TEXT
    );

    /* 6. 采购单主表：状态机 draft -> submitted -> received；draft/submitted -> cancelled */
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no     TEXT    NOT NULL UNIQUE,
      supplier_id  INTEGER NOT NULL REFERENCES suppliers(id),
      status       TEXT    NOT NULL DEFAULT 'draft',
      total_amount INTEGER NOT NULL DEFAULT 0,                  -- 分
      remark       TEXT,
      cancel_reason TEXT,
      created_by   INTEGER NOT NULL REFERENCES users(id),
      submitted_at TEXT,
      received_at  TEXT,
      received_by  INTEGER REFERENCES users(id),
      created_at   TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status_created ON purchase_orders(status, created_at);

    /* 7. 采购单明细表：同一单内商品不允许重复 */
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity   INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,                              -- 进价快照（分）
      created_at TEXT    NOT NULL,
      UNIQUE(order_id, product_id)
    );

    /* 8. 库存表：一商品一条库存记录；商品创建时同步创建，默认 0 / 阈值 10 */
    CREATE TABLE IF NOT EXISTS inventory (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id     INTEGER NOT NULL UNIQUE REFERENCES products(id),
      quantity       INTEGER NOT NULL DEFAULT 0,
      warn_threshold INTEGER NOT NULL DEFAULT 10,
      updated_at     TEXT    NOT NULL,
      updated_by     INTEGER REFERENCES users(id)
    );

    /* 9. 库存流水表：只增不改不删 */
    CREATE TABLE IF NOT EXISTS inventory_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id      INTEGER NOT NULL REFERENCES products(id),
      type            TEXT    NOT NULL,                          -- purchase_in/manual_in/manual_out
      quantity        INTEGER NOT NULL,                          -- 变动数量（正数）
      direction       INTEGER NOT NULL,                          -- +1 增加 / -1 减少
      before_quantity INTEGER NOT NULL,
      after_quantity  INTEGER NOT NULL,
      ref_type        TEXT,
      ref_id          INTEGER,
      ref_no          TEXT,
      reason          TEXT,
      operator_id     INTEGER NOT NULL REFERENCES users(id),
      created_at      TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inv_logs_product_time ON inventory_logs(product_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_inv_logs_time ON inventory_logs(created_at);

    /* 10. 审计日志表：只增不改不删 */
    CREATE TABLE IF NOT EXISTS audit_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER,
      username   TEXT    NOT NULL,
      action     TEXT    NOT NULL,
      module     TEXT    NOT NULL,
      target     TEXT,
      detail     TEXT,
      ip         TEXT,
      user_agent TEXT,
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_logs(username, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_module_time ON audit_logs(module, created_at);

    /* 11. refresh token 会话表（2026-09-24 安全加固：refresh 轮换 + 重放检测；
     *     2026-09-24 宽限窗口：新增 rotated_at 记录轮换发生时刻，供多 tab 并发
     *     竞态的宽限判定——宽限窗口内的旧令牌复用视为竞态而非攻击）：
     * 每个 refresh token 携带唯一 jti 并落库；/refresh 轮换时旧行置 rotated、记
     * replaced_by 与 rotated_at，宽限窗口外再次使用旧 jti 判定为重放（泄露）
     * 触发全端撤销。expires_at 为毫秒时间戳，与 JWT exp 同源，定时清理任务删除过期行。 */
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      jti         TEXT    PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      expires_at  INTEGER NOT NULL,                 -- 过期时间（毫秒时间戳，与 JWT exp 同源）
      status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotated','revoked')),
      replaced_by TEXT,                              -- 轮换时的新 jti（重放溯源链）
      rotated_at  INTEGER,                           -- 轮换发生时刻（毫秒时间戳；未轮换为 NULL；宽限窗口判定依据）
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
  `);

  // 幂等迁移（2026-09-24 宽限窗口加固）：老库的 refresh_tokens 表缺少 rotated_at 列时
  // 补齐（新库由上方建表语句直接带列，此迁移自动跳过）；历史已轮换行 rotated_at 为 NULL，
  // 宽限判定视为"不在宽限内"（按重放防护处理，安全优先）。
  // @throws {Error} PRAGMA/ALTER TABLE 执行失败（如库文件损坏）时抛出，服务启动将失败
  const refreshTokenColumns = db.prepare('PRAGMA table_info(refresh_tokens)').all().map((col) => col.name);
  if (!refreshTokenColumns.includes('rotated_at')) {
    db.exec('ALTER TABLE refresh_tokens ADD COLUMN rotated_at INTEGER');
  }

  // 预置角色（幂等：存在即跳过）
  const insertRole = db.prepare(
    'INSERT INTO roles (code, name, description) VALUES (?, ?, ?)'
  );
  const roleCount = db.prepare('SELECT COUNT(*) AS c FROM roles').get().c;
  if (roleCount === 0) {
    insertRole.run('admin', '系统管理员', '全部权限，含用户管理与审计日志');
    insertRole.run('purchaser', '采购员', '供应商与采购单维护');
    insertRole.run('stockkeeper', '库存管理员', '商品/分类/入库/库存调整');
    insertRole.run('viewer', '普通查看员', '只读查看');
  }
}
