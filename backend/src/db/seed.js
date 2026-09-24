/**
 * 种子数据脚本（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：向空库写入默认管理员（admin/***REMOVED-SEED-PASSWORD***）、演示账号、
 *          演示分类/商品/供应商/采购单/库存与流水数据，供验收演示使用。
 * 设计思路：仅在 users 表为空时执行（幂等）；密码使用 bcrypt(cost=10) 哈希；
 *          默认管理员按 PRD 2.3 标记 must_change_password=1（首登强制改密）；
 *          演示采购单包含一张近 7 日"已入库"单据，用于看板趋势图展示。
 * 适用场景：服务首次启动时自动执行。
 * 创建时间：2026-09-21
 */
import bcrypt from 'bcryptjs';
import db from './index.js';

/**
 * 执行种子数据写入（仅当用户表为空时）
 * @returns {void} 无返回值
 * @throws {Error} 数据库写入失败时抛出（事务回滚，不影响已有数据）
 */
export function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0) return; // 已有数据则跳过，保证幂等

  const now = new Date().toISOString();
  const run = db.transaction(() => {
    /* ---------- 1. 账号 ---------- */
    const insertUser = db.prepare(`
      INSERT INTO users (username, password_hash, real_name, role_id, status,
        token_version, must_change_password, created_at, updated_at)
      VALUES (@username, @passwordHash, @realName, @roleId, 1, 0, @mustChange, @now, @now)
    `);
    const roleMap = {};
    for (const r of db.prepare('SELECT id, code FROM roles').all()) roleMap[r.code] = r.id;

    // 默认管理员：首登强制改密（PRD 2.3 / A01）
    insertUser.run({
      username: 'admin',
      passwordHash: bcrypt.hashSync('***REMOVED-SEED-PASSWORD***', 10),
      realName: '系统管理员',
      roleId: roleMap.admin,
      mustChange: 1,
      now,
    });
    // 演示账号（首登不强制改密，便于验收各角色）
    insertUser.run({
      username: 'purchaser01',
      passwordHash: bcrypt.hashSync('***REMOVED-SEED-PASSWORD***', 10),
      realName: '王小采',
      roleId: roleMap.purchaser,
      mustChange: 0,
      now,
    });
    insertUser.run({
      username: 'stocker01',
      passwordHash: bcrypt.hashSync('***REMOVED-SEED-PASSWORD***', 10),
      realName: '李库管',
      roleId: roleMap.stockkeeper,
      mustChange: 0,
      now,
    });
    insertUser.run({
      username: 'viewer01',
      passwordHash: bcrypt.hashSync('***REMOVED-SEED-PASSWORD***', 10),
      realName: '赵查看',
      roleId: roleMap.viewer,
      mustChange: 0,
      now,
    });

    /* ---------- 2. 分类 ---------- */
    const insertCat = db.prepare(
      'INSERT INTO categories (name, parent_id, created_at) VALUES (?, ?, ?)'
    );
    const catElectronic = insertCat.run('电子产品', null, now).lastInsertRowid;
    const catOffice = insertCat.run('办公用品', null, now).lastInsertRowid;
    const catHome = insertCat.run('家居日用', null, now).lastInsertRowid;
    const catPhone = insertCat.run('手机数码', catElectronic, now).lastInsertRowid;
    const catPc = insertCat.run('电脑配件', catElectronic, now).lastInsertRowid;
    const catPaper = insertCat.run('纸张耗材', catOffice, now).lastInsertRowid;

    /* ---------- 3. 商品（12 个，其中 2 个低库存演示） ---------- */
    const insertProduct = db.prepare(`
      INSERT INTO products (name, sku, category_id, unit, spec, sale_price, remark, created_at, updated_at)
      VALUES (@name, @sku, @categoryId, @unit, @spec, @salePrice, @remark, @now, @now)
    `);
    const insertInv = db.prepare(
      'INSERT INTO inventory (product_id, quantity, warn_threshold, updated_at) VALUES (?, ?, ?, ?)'
    );
    const demoProducts = [
      { name: '无线蓝牙耳机 Pro', sku: 'SKU-1001', categoryId: catPhone, unit: '个', spec: '白色/主动降噪', salePrice: 29900, qty: 45, threshold: 10 },
      { name: '智能手环 S6', sku: 'SKU-1002', categoryId: catPhone, unit: '个', spec: '黑色', salePrice: 19900, qty: 4, threshold: 8 },   // 低库存
      { name: '机械键盘 K870', sku: 'SKU-1003', categoryId: catPc, unit: '把', spec: '87键/青轴', salePrice: 34900, qty: 22, threshold: 10 },
      { name: '无线鼠标 M220', sku: 'SKU-1004', categoryId: catPc, unit: '个', spec: '静音款', salePrice: 6900, qty: 3, threshold: 15 },    // 低库存
      { name: '27英寸显示器', sku: 'SKU-1005', categoryId: catPc, unit: '台', spec: '2K/IPS', salePrice: 129900, qty: 12, threshold: 5 },
      { name: 'USB-C 数据线 2米', sku: 'SKU-1006', categoryId: catPc, unit: '根', spec: '100W 快充', salePrice: 3900, qty: 120, threshold: 30 },
      { name: 'A4 复印纸 70g', sku: 'SKU-1007', categoryId: catPaper, unit: '包', spec: '500张/包', salePrice: 1500, qty: 300, threshold: 50 },
      { name: '中性笔 0.5mm', sku: 'SKU-1008', categoryId: catOffice, unit: '盒', spec: '黑色/12支装', salePrice: 1200, qty: 85, threshold: 20 },
      { name: '订书机 12号', sku: 'SKU-1009', categoryId: catOffice, unit: '个', spec: '标准型', salePrice: 1800, qty: 30, threshold: 10 },
      { name: '抽纸 三层软包', sku: 'SKU-1010', categoryId: catHome, unit: '提', spec: '8包/提', salePrice: 2500, qty: 60, threshold: 15 },
      { name: '不锈钢保温杯 500ml', sku: 'SKU-1011', categoryId: catHome, unit: '个', spec: '银色', salePrice: 5900, qty: 18, threshold: 10 },
      { name: '收纳箱 45L', sku: 'SKU-1012', categoryId: catHome, unit: '个', spec: '透明/带轮', salePrice: 4900, qty: 9, threshold: 12 },
    ];
    const productIds = {};
    for (const p of demoProducts) {
      const id = insertProduct.run({ ...p, salePrice: p.salePrice, remark: null, now }).lastInsertRowid;
      productIds[p.sku] = id;
      insertInv.run(id, p.qty, p.threshold, now);
    }

    /* ---------- 4. 供应商 ---------- */
    const insertSupplier = db.prepare(`
      INSERT INTO suppliers (name, contact_person, phone, email, address, status, remark, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?)
    `);
    const supA = insertSupplier.run('深圳华强电子有限公司', '陈经理', '13800138001', 'chen@huaqiang.com', '深圳市福田区华强北路 100 号', now, now).lastInsertRowid;
    const supB = insertSupplier.run('晨光办公用品批发部', '刘女士', '021-65558899', 'liu@mg-office.cn', '上海市普陀区中山北路 1250 号', now, now).lastInsertRowid;
    const supC = insertSupplier.run('杭州百家居贸商行', '周先生', '13900139002', 'zhou@baijia.com', '杭州市拱墅区祥园路 28 号', now, now).lastInsertRowid;

    /* ---------- 5. 采购单（1 张已入库[近7日]、1 张已提交、1 张草稿） ---------- */
    const insertOrder = db.prepare(`
      INSERT INTO purchase_orders (order_no, supplier_id, status, total_amount, remark,
        created_by, submitted_at, received_at, received_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertItem = db.prepare(
      'INSERT INTO purchase_order_items (order_id, product_id, quantity, unit_price, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const insertLog = db.prepare(`
      INSERT INTO inventory_logs (product_id, type, quantity, direction, before_quantity, after_quantity,
        ref_type, ref_id, ref_no, reason, operator_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
    const buyerId = db.prepare("SELECT id FROM users WHERE username='purchaser01'").get().id;

    // 5.1 已入库单（入库时间 = 2 天前，用于看板近 7 日趋势）
    const d2 = new Date(Date.now() - 2 * 86400000);
    const d2Iso = d2.toISOString();
    const dayStr = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const no1 = `PO${dayStr(d2)}0001`;
    const oid1 = insertOrder.run(no1, supA, 'received', 0, '常规补货', buyerId, d2Iso, d2Iso, adminId, d2Iso, d2Iso).lastInsertRowid;
    // 明细：耳机 x10@180元 = 1800 元；手环 x20@120 元 = 2400 元；合计 420000 分 = 4200 元
    insertItem.run(oid1, productIds['SKU-1001'], 10, 18000, d2Iso);
    insertItem.run(oid1, productIds['SKU-1002'], 20, 12000, d2Iso);
    db.prepare('UPDATE purchase_orders SET total_amount = 420000 WHERE id = ?').run(oid1);
    // 入库流水：耳机 +10、手环 +20
    insertLog.run(productIds['SKU-1001'], 'purchase_in', 10, 1, 35, 45, 'purchase_order', oid1, no1, null, adminId, d2Iso);
    insertLog.run(productIds['SKU-1002'], 'purchase_in', 20, 1, 0, 20, 'purchase_order', oid1, no1, null, adminId, d2Iso);

    // 5.2 已提交单（待库管入库）
    const d1 = new Date(Date.now() - 1 * 86400000).toISOString();
    const no2 = `PO${dayStr(new Date(Date.now() - 86400000))}0001`;
    const oid2 = insertOrder.run(no2, supB, 'submitted', 0, '办公用品月度采购', buyerId, d1, null, null, d1, d1).lastInsertRowid;
    insertItem.run(oid2, productIds['SKU-1007'], 50, 1100, d1);
    insertItem.run(oid2, productIds['SKU-1008'], 30, 800, d1);
    db.prepare('UPDATE purchase_orders SET total_amount = 79000 WHERE id = ?').run(oid2); // 50*11 + 30*8 = 790 元

    // 5.3 草稿单
    const no3 = `PO${dayStr(new Date())}0001`;
    const oid3 = insertOrder.run(no3, supC, 'draft', 0, '家居用品试单', buyerId, null, null, null, now, now).lastInsertRowid;
    insertItem.run(oid3, productIds['SKU-1010'], 40, 1800, now);
    db.prepare('UPDATE purchase_orders SET total_amount = 72000 WHERE id = ?').run(oid3); // 40*18 = 720 元
  });

  run();
  console.log('[seed] 种子数据写入完成（默认管理员 admin / ***REMOVED-SEED-PASSWORD***，首登需改密）');
}
