import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 数据库连接模块（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：创建并持有全局唯一的 better-sqlite3 数据库连接实例，
 *          开启 WAL 模式与外键约束，对外导出 db 实例供各 service 使用。
 * 设计思路：better-sqlite3 为同步 API，Node 单线程事件循环下天然串行，
 *          事务内多步骤写操作可借助 db.transaction 保证原子性；
 *          连接采用单例模式，避免多连接导致的锁竞争。
 * 适用场景：本系统全部的持久化读写（users/products/orders 等全部表）。
 * 创建时间：2026-09-21
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 数据库文件目录（默认 backend/data），不存在则自动创建
const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || './data/erp.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

/**
 * 创建数据库连接
 * @returns {import('better-sqlite3').Database} SQLite 数据库连接实例
 * @throws {Error} 当数据库文件损坏或磁盘不可写时抛出打开异常
 */
const db = new Database(dbPath);

// 开启 WAL 提升读写并发性能；开启外键约束保证引用完整性
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export default db;
export { dbPath };
