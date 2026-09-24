/**
 * 业务 API 模块集合（文件级注释）
 * ------------------------------------------------------------------
 * 核心功能：按 PRD 第 6 章封装全部 REST 接口调用（认证/分类/商品/供应商/
 *          采购/库存/看板/用户/审计日志），统一走 request 拆包。
 * 设计思路：所有函数均为薄封装，参数与后端契约一致；金额以"分"传输。
 * 适用场景：页面组件按需导入调用；调用方需 try-catch 处理异常。
 * 创建时间：2026-09-21
 */
import { request } from './http';
import type {
  ApiResp, AuditLogRow, CategoryNode, DashboardStats, InventoryLogRow, InventoryRow,
  LoginData, PageData, ProductRow, PurchaseOrderDetail, PurchaseOrderRow, SupplierRow, UserRow,
} from '@/types/api';

/** 通用分页查询参数 */
export interface PageQuery {
  page?: number;
  pageSize?: number;
  [key: string]: unknown;
}

/* ================= 认证 ================= */

/** 登录 */
export const loginApi = (username: string, password: string) =>
  request<LoginData>({ url: '/auth/login', method: 'post', data: { username, password } });

/** 登出 */
export const logoutApi = () => request<null>({ url: '/auth/logout', method: 'post' });

/** 获取当前用户信息 */
export const meApi = () => request<LoginData['user']>({ url: '/auth/me', method: 'get' });

/** 修改本人密码 */
export const changePasswordApi = (oldPassword: string, newPassword: string) =>
  request<null>({ url: '/auth/password', method: 'put', data: { oldPassword, newPassword } });

/* ================= 分类 ================= */

/** 分类树（含商品数） */
export const listCategories = () => request<CategoryNode[]>({ url: '/categories', method: 'get' });

/** 新增分类 */
export const createCategory = (name: string, parentId: number | null) =>
  request<{ id: number }>({ url: '/categories', method: 'post', data: { name, parentId } });

/** 修改分类 */
export const updateCategory = (id: number, name: string) =>
  request<unknown>({ url: `/categories/${id}`, method: 'put', data: { name } });

/** 删除分类 */
export const deleteCategory = (id: number) =>
  request<null>({ url: `/categories/${id}`, method: 'delete' });

/* ================= 商品 ================= */

/** 商品分页列表 */
export const listProducts = (params: PageQuery) =>
  request<PageData<ProductRow>>({ url: '/products', method: 'get', params });

/** 商品详情 */
export const getProduct = (id: number) => request<ProductRow>({ url: `/products/${id}`, method: 'get' });

/** 商品创建/编辑参数（salePrice 分、warnThreshold 可选） */
export interface ProductPayload {
  name: string;
  sku: string;
  categoryId: number;
  unit: string;
  barcode?: string | null;
  spec?: string | null;
  salePrice?: number | null;
  remark?: string | null;
  warnThreshold?: number;
}

/** 新增商品 */
export const createProduct = (data: ProductPayload) =>
  request<{ id: number }>({ url: '/products', method: 'post', data });

/** 编辑商品 */
export const updateProduct = (id: number, data: ProductPayload) =>
  request<unknown>({ url: `/products/${id}`, method: 'put', data });

/** 软删除商品 */
export const deleteProduct = (id: number) => request<null>({ url: `/products/${id}`, method: 'delete' });

/* ================= 供应商 ================= */

/** 供应商分页列表 */
export const listSuppliers = (params: PageQuery) =>
  request<PageData<SupplierRow>>({ url: '/suppliers', method: 'get', params });

/** 供应商详情 */
export const getSupplier = (id: number) => request<SupplierRow>({ url: `/suppliers/${id}`, method: 'get' });

/** 新增/编辑供应商参数 */
export interface SupplierPayload {
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  remark?: string | null;
}

/** 新增供应商 */
export const createSupplier = (data: SupplierPayload) =>
  request<{ id: number }>({ url: '/suppliers', method: 'post', data });

/** 编辑供应商 */
export const updateSupplier = (id: number, data: SupplierPayload) =>
  request<unknown>({ url: `/suppliers/${id}`, method: 'put', data });

/** 启用/停用供应商 */
export const toggleSupplierStatus = (id: number, status: 0 | 1) =>
  request<unknown>({ url: `/suppliers/${id}/status`, method: 'put', data: { status } });

/** 删除供应商 */
export const deleteSupplier = (id: number) => request<null>({ url: `/suppliers/${id}`, method: 'delete' });

/* ================= 采购单 ================= */

/** 采购单分页列表 */
export const listPurchaseOrders = (params: PageQuery) =>
  request<PageData<PurchaseOrderRow>>({ url: '/purchase-orders', method: 'get', params });

/** 采购单详情（含明细） */
export const getPurchaseOrder = (id: number) =>
  request<PurchaseOrderDetail>({ url: `/purchase-orders/${id}`, method: 'get' });

/** 创建/编辑采购单参数 */
export interface PurchaseOrderPayload {
  supplierId: number;
  remark?: string | null;
  items: { productId: number; quantity: number; unitPrice: number }[];
}

/** 创建草稿采购单 */
export const createPurchaseOrder = (data: PurchaseOrderPayload) =>
  request<{ id: number; orderNo: string }>({ url: '/purchase-orders', method: 'post', data });

/** 编辑草稿采购单 */
export const updatePurchaseOrder = (id: number, data: PurchaseOrderPayload) =>
  request<unknown>({ url: `/purchase-orders/${id}`, method: 'put', data });

/** 删除草稿采购单 */
export const deletePurchaseOrder = (id: number) =>
  request<null>({ url: `/purchase-orders/${id}`, method: 'delete' });

/** 提交采购单 */
export const submitPurchaseOrder = (id: number) =>
  request<{ status: string }>({ url: `/purchase-orders/${id}/submit`, method: 'post' });

/** 入库确认 */
export const receivePurchaseOrder = (id: number) =>
  request<{ status: string }>({ url: `/purchase-orders/${id}/receive`, method: 'post' });

/** 取消采购单 */
export const cancelPurchaseOrder = (id: number, reason: string) =>
  request<{ status: string }>({ url: `/purchase-orders/${id}/cancel`, method: 'post', data: { reason } });

/* ================= 库存 ================= */

/** 库存分页列表 */
export const listInventory = (params: PageQuery) =>
  request<PageData<InventoryRow>>({ url: '/inventory', method: 'get', params });

/** 修改预警阈值 */
export const updateThreshold = (productId: number, warnThreshold: number) =>
  request<unknown>({ url: `/inventory/${productId}/threshold`, method: 'put', data: { warnThreshold } });

/** 手动出入库调整 */
export const adjustInventory = (productId: number, type: 'manual_in' | 'manual_out', quantity: number, reason: string) =>
  request<{ productId: number; quantityAfter: number }>({ url: '/inventory/adjust', method: 'post', data: { productId, type, quantity, reason } });

/** 库存流水分页 */
export const listInventoryLogs = (params: PageQuery) =>
  request<PageData<InventoryLogRow>>({ url: '/inventory/logs', method: 'get', params });

/* ================= 看板 ================= */

/** 看板统计 */
export const getDashboardStats = () => request<DashboardStats>({ url: '/dashboard/stats', method: 'get' });

/* ================= 用户管理 ================= */

/** 用户分页列表 */
export const listUsers = (params: PageQuery) =>
  request<PageData<UserRow>>({ url: '/users', method: 'get', params });

/** 新增用户参数 */
export interface UserPayload {
  username: string;
  password: string;
  realName: string;
  roleCode: string;
}

/** 新增用户 */
export const createUser = (data: UserPayload) => request<{ id: number }>({ url: '/users', method: 'post', data });

/** 编辑用户（姓名/角色/状态） */
export const updateUser = (id: number, data: { realName: string; roleCode: string; status: 0 | 1 }) =>
  request<unknown>({ url: `/users/${id}`, method: 'put', data });

/** 重置密码 */
export const resetUserPassword = (id: number, newPassword: string) =>
  request<null>({ url: `/users/${id}/reset-password`, method: 'put', data: { newPassword } });

/** 解除登录锁定 */
export const unlockUser = (id: number) => request<null>({ url: `/users/${id}/unlock`, method: 'post' });

/** 软删除用户 */
export const deleteUser = (id: number) => request<null>({ url: `/users/${id}`, method: 'delete' });

/* ================= 审计日志 ================= */

/** 审计日志分页 */
export const listAuditLogs = (params: PageQuery) =>
  request<PageData<AuditLogRow>>({ url: '/audit-logs', method: 'get', params });

/** 原始响应类型导出（特殊场景使用） */
export type { ApiResp };
