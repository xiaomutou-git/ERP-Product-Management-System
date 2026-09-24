/**
 * 看板路由（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：数据看板统计——商品总数、库存总量、低库存商品数、近 7 日采购金额趋势。
 * 设计思路：趋势按"入库时间"统计最近 7 天（含当日）每日已入库采购单金额合计；
 *          为保证时区正确（ISO UTC 存储 vs 本地日期分组），取近 7 日已入库单据
 *          在内存中按本地日期分桶，无数据日期补 0（PRD FR-06）。
 * 适用场景：挂载于 /api/dashboard。
 * 创建时间：2026-09-21
 */
import { Router } from 'express';
import db from '../db/index.js';
import { ok } from '../utils/response.js';
import { authenticate } from '../middlewares/auth.js';

const router = Router();
router.use(authenticate);

/* ---------------- GET /api/dashboard/stats 统计数据（全部角色） ---------------- */
router.get('/stats', (req, res, next) => {
  try {
    // ① 商品总数（未软删除）
    const productCount = db.prepare('SELECT COUNT(*) AS c FROM products WHERE deleted_at IS NULL').get().c;

    // ② 库存总量（未删除商品库存之和）
    const totalStock = db.prepare(`
      SELECT IFNULL(SUM(i.quantity), 0) AS s FROM inventory i
      JOIN products p ON p.id = i.product_id WHERE p.deleted_at IS NULL
    `).get().s;

    // ③ 低库存商品数（quantity <= warn_threshold）
    const lowStockCount = db.prepare(`
      SELECT COUNT(*) AS c FROM inventory i
      JOIN products p ON p.id = i.product_id
      WHERE p.deleted_at IS NULL AND i.quantity <= i.warn_threshold
    `).get().c;

    // ④ 近 7 日采购金额趋势（按入库时间，本地日期分桶，空数据日补 0）
    const days = [];
    const buckets = new Map();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days.push(key);
      buckets.set(key, 0);
    }
    // 仅取最近 7 天起点之后的已入库单据（本地时区口径）
    const startIso = new Date(Date.now() - 6 * 86400000);
    startIso.setHours(0, 0, 0, 0);
    const orders = db.prepare(`
      SELECT received_at AS receivedAt, total_amount AS totalAmount
      FROM purchase_orders WHERE status = 'received' AND received_at >= ?
    `).all(startIso.toISOString());
    for (const o of orders) {
      const d = new Date(o.receivedAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (buckets.has(key)) buckets.set(key, buckets.get(key) + o.totalAmount);
    }
    const purchaseAmount7d = days.map((key) => ({
      date: key.slice(5).replace('-', '-'), // MM-DD
      amount: buckets.get(key),
    }));

    res.json(ok({ productCount, totalStock, lowStockCount, purchaseAmount7d }));
  } catch (err) {
    next(err);
  }
});

export default router;
