/**
 * API 类型定义（文件级注释）
 * ------------------------------------------------------------------
 * 核心功能：声明后端统一响应结构与各业务实体的 TypeScript 类型。
 * 设计思路：与 PRD 第 6 章 API 清单一一对应，金额一律为"分"（number）。
 * 适用场景：src/api 各模块与页面组件。
 * 创建时间：2026-09-21
 */

/** 统一响应结构：code=0 成功；非 0 为业务错误码（PRD 附录 A） */
export interface ApiResp<T = unknown> {
  code: number;
  message: string;
  data: T;
}

/** 分页数据结构 */
export interface PageData<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 当前登录用户信息 */
export interface UserInfo {
  id: number;
  username: string;
  realName: string;
  role: 'admin' | 'purchaser' | 'stockkeeper' | 'viewer';
  mustChangePassword: boolean;
}

/** 登录响应数据（安全加固后：token 经 HttpOnly Cookie 下发，响应体不含任何令牌） */
export interface LoginData {
  expiresIn: number;
  user: UserInfo;
}

/** 分类节点（树形） */
export interface CategoryNode {
  id: number;
  name: string;
  parentId: number | null;
  productCount: number;
  children: CategoryNode[];
}

/** 商品列表行 */
export interface ProductRow {
  id: number;
  name: string;
  sku: string;
  barcode: string | null;
  categoryId: number;
  categoryName: string;
  parentCategoryName: string | null;
  unit: string;
  spec: string | null;
  salePrice: number | null;
  remark: string | null;
  quantity: number;
  warnThreshold: number;
  isLowStock: number;
  createdAt: string;
}

/** 供应商行 */
export interface SupplierRow {
  id: number;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  status: number;
  remark: string | null;
  createdAt: string;
  orderCount?: number;
}

/** 采购单列表行 */
export interface PurchaseOrderRow {
  id: number;
  orderNo: string;
  supplierId: number;
  supplierName: string;
  status: 'draft' | 'submitted' | 'received' | 'cancelled';
  totalAmount: number;
  remark: string | null;
  cancelReason: string | null;
  createdBy: number;
  createdByName: string;
  submittedAt: string | null;
  receivedAt: string | null;
  receivedByName: string | null;
  createdAt: string;
  itemCount: number;
}

/** 采购单明细行 */
export interface PurchaseOrderItem {
  id: number;
  productId: number;
  sku: string;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

/** 采购单详情 */
export interface PurchaseOrderDetail extends Omit<PurchaseOrderRow, 'itemCount'> {
  supplierStatus: number;
  items: PurchaseOrderItem[];
}

/** 库存行 */
export interface InventoryRow {
  productId: number;
  sku: string;
  productName: string;
  unit: string;
  categoryName: string;
  parentCategoryName: string | null;
  quantity: number;
  warnThreshold: number;
  isLowStock: number;
  updatedAt: string;
}

/** 库存流水行 */
export interface InventoryLogRow {
  id: number;
  productId: number;
  sku: string;
  productName: string;
  type: 'purchase_in' | 'manual_in' | 'manual_out';
  quantity: number;
  direction: number;
  beforeQuantity: number;
  afterQuantity: number;
  refType: string | null;
  refId: number | null;
  refNo: string | null;
  reason: string | null;
  operatorName: string;
  operatorUsername: string;
  createdAt: string;
}

/** 用户行 */
export interface UserRow {
  id: number;
  username: string;
  realName: string;
  roleCode: UserInfo['role'];
  roleName: string;
  status: number;
  lastLoginAt: string | null;
  mustChangePassword: number;
  lockedUntil: string | null;
  failedAttempts: number;
  locked: boolean;
  createdAt: string;
}

/** 审计日志行 */
export interface AuditLogRow {
  id: number;
  userId: number | null;
  username: string;
  action: string;
  module: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

/** 看板统计数据 */
export interface DashboardStats {
  productCount: number;
  totalStock: number;
  lowStockCount: number;
  purchaseAmount7d: { date: string; amount: number }[];
}

/** 商品编辑弹窗表单（前端表单口径，售价为元） */
export interface ProductForm {
  name: string;
  sku: string;
  categoryId: number | null;
  unit: string;
  barcode: string;
  spec: string;
  salePriceYuan: number | null;
  remark: string;
  warnThreshold: number;
}

/** 采购明细编辑行（进价为元） */
export interface PurchaseItemForm {
  productId: number | null;
  productName: string;
  sku: string;
  unit: string;
  quantity: number;
  unitPriceYuan: number;
}
