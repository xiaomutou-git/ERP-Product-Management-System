/**
 * 格式化工具集（文件级注释）
 * ------------------------------------------------------------------
 * 核心功能：金额分转元、日期格式化、采购单状态与流水类型的展示映射、
 *          前端权限判定（与 PRD 2.2 权限矩阵一致）。
 * 设计思路：状态颜色映射与 UI-DESIGN 4.5 的全站唯一状态来源保持一致；
 *          权限集中在此维护，避免散落在各页面。
 * 适用场景：全部页面组件。
 * 创建时间：2026-09-21
 */
import type { UserInfo } from '@/types/api';

/**
 * 分转元字符串（2 位小数）
 * @param cents 金额（分），可为 null/undefined
 * @param withSymbol 是否带 ¥ 符号，默认 false
 * @returns 金额字符串，如 "123.45"；空值返回 "—"
 */
export function fen2yuan(cents?: number | null, withSymbol = false): string {
  if (cents === null || cents === undefined) return '—';
  const v = (cents / 100).toFixed(2);
  return withSymbol ? `¥${v}` : v;
}

/**
 * 元转分整数
 * @param yuan 金额（元），可为 null
 * @returns 分（整数），null 返回 null
 */
export function yuan2fen(yuan: number | null | undefined): number | null {
  if (yuan === null || yuan === undefined || Number.isNaN(yuan)) return null;
  return Math.round(yuan * 100);
}

/**
 * ISO 时间转本地显示格式 yyyy-MM-dd HH:mm
 * @param iso ISO8601 时间字符串，可为空
 * @param withSeconds 是否带秒，默认 false
 * @returns 格式化字符串；空值返回 "—"
 */
export function fmtTime(iso?: string | null, withSeconds = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withSeconds ? `${base}:${p(d.getSeconds())}` : base;
}

/** 采购单状态展示映射（Tag 文案与配色，UI-DESIGN 4.5） */
export const ORDER_STATUS_MAP: Record<string, { label: string; color: string; bg: string }> = {
  draft: { label: '草稿', color: '#475569', bg: '#F1F5F9' },
  submitted: { label: '已提交', color: '#1D4ED8', bg: '#DBEAFE' },
  received: { label: '已入库', color: '#047857', bg: '#D1FAE5' },
  cancelled: { label: '已取消', color: '#B91C1C', bg: '#FEE2E2' },
};

/** 库存流水类型展示映射 */
export const LOG_TYPE_MAP: Record<string, { label: string; color: string; bg: string }> = {
  purchase_in: { label: '采购入库', color: '#0E7490', bg: '#CFFAFE' },
  manual_in: { label: '手动入库', color: '#047857', bg: '#D1FAE5' },
  manual_out: { label: '手动出库', color: '#B45309', bg: '#FEF3C7' },
};

/** 角色展示映射（用户列表 Tag） */
export const ROLE_MAP: Record<string, { label: string; color: string; bg: string; desc: string }> = {
  admin: { label: '系统管理员', color: '#155E75', bg: '#CFFAFE', desc: '全部权限，含用户管理与审计日志' },
  purchaser: { label: '采购员', color: '#1D4ED8', bg: '#DBEAFE', desc: '供应商与采购单维护、查看商品库存' },
  stockkeeper: { label: '库存管理员', color: '#047857', bg: '#D1FAE5', desc: '商品/分类维护、入库确认、库存调整' },
  viewer: { label: '查看员', color: '#475569', bg: '#F1F5F9', desc: '仅查看商品、库存、看板数据' },
};

/** 审计动作展示映射 */
export const AUDIT_ACTION_MAP: Record<string, { label: string; danger?: boolean }> = {
  login_success: { label: '登录成功' },
  login_failed: { label: '登录失败', danger: true },
  logout: { label: '登出' },
  create: { label: '新增' },
  update: { label: '修改' },
  delete: { label: '删除', danger: true },
  submit: { label: '提交' },
  receive: { label: '入库' },
  cancel: { label: '取消', danger: true },
  adjust: { label: '调整' },
  change_password: { label: '修改密码' },
  reset_password: { label: '重置密码', danger: true },
  unlock: { label: '解锁' },
};

/** 审计模块中文映射 */
export const AUDIT_MODULE_MAP: Record<string, string> = {
  auth: '登录',
  product: '商品',
  category: '分类',
  supplier: '供应商',
  purchase: '采购',
  inventory: '库存',
  user: '用户',
};

/** 用户角色类型 */
export type Role = UserInfo['role'];

/**
 * 判断当前用户是否拥有指定权限（与 PRD 2.2 权限矩阵一致；admin 恒放行）
 * @param role   当前角色
 * @param action 权限动作编码
 * @returns 是否有权限
 */
export function can(role: Role | undefined, action: string): boolean {
  if (!role) return false;
  if (role === 'admin') return true;
  const matrix: Record<string, Role[]> = {
    'product:write': ['stockkeeper'],
    'category:write': ['stockkeeper'],
    'supplier:write': ['purchaser'],
    'purchase:write': ['purchaser'],
    'purchase:receive': ['stockkeeper'],
    'inventory:write': ['stockkeeper'],
  };
  return (matrix[action] || []).includes(role);
}
