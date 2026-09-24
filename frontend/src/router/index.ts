/**
 * 路由配置与全局守卫（文件级注释）
 * ------------------------------------------------------------------
 * 核心功能：声明全部页面路由（懒加载拆 chunk）与全局前置守卫——
 *          未登录跳登录页（记录回跳地址）；/users 与 /audit-logs 仅 admin；
 *          mustChangePassword=1 的用户锁定在登录页（改密表单）。
 * 设计思路：页面组件全部路由懒加载保证首屏体积；守卫读取 Pinia 登录态。
 * 适用场景：main.ts 注册。
 * 创建时间：2026-09-21
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { can } from '@/utils/format';

/** 主布局（含侧栏/顶栏） */
import MainLayout from '@/layouts/MainLayout.vue';

/** 路由表 */
const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { title: '登录', public: true } },
  {
    path: '/',
    component: MainLayout,
    children: [
      { path: '', name: 'dashboard', component: () => import('@/views/DashboardView.vue'), meta: { title: '数据看板' } },
      { path: 'products', name: 'products', component: () => import('@/views/ProductsView.vue'), meta: { title: '商品管理' } },
      { path: 'suppliers', name: 'suppliers', component: () => import('@/views/SuppliersView.vue'), meta: { title: '供应商管理' } },
      { path: 'purchase-orders', name: 'purchase-orders', component: () => import('@/views/PurchaseOrdersView.vue'), meta: { title: '采购管理' } },
      { path: 'purchase-orders/create', name: 'purchase-order-create', component: () => import('@/views/PurchaseOrderFormView.vue'), meta: { title: '新建采购单', permission: 'purchase:write' } },
      { path: 'purchase-orders/edit/:id', name: 'purchase-order-edit', component: () => import('@/views/PurchaseOrderFormView.vue'), meta: { title: '编辑采购单', permission: 'purchase:write' } },
      { path: 'inventory', name: 'inventory', component: () => import('@/views/InventoryView.vue'), meta: { title: '库存管理' } },
      { path: 'users', name: 'users', component: () => import('@/views/UsersView.vue'), meta: { title: '用户管理', roles: ['admin'] } },
      { path: 'audit-logs', name: 'audit-logs', component: () => import('@/views/AuditLogsView.vue'), meta: { title: '操作日志', roles: ['admin'] } },
      { path: ':pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFoundView.vue'), meta: { title: '页面不存在' } },
    ],
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

/**
 * 全局前置守卫
 * 执行逻辑：公开路由放行；内存登录态为空时先经 restoreSession() 凭 HttpOnly
 *          Cookie 恢复会话（页面刷新场景，失败才跳 /login 并记录 redirect）；
 *          角色不匹配重定向首页并提示；meta.permission 声明的细粒度权限
 *          （如采购建单需 purchase:write）不满足时重定向采购列表并提示；
 *          强制改密用户仅可停留在 /login。
 * @param to   目标路由
 * @param from 来源路由
 * @returns void（通过 next() 隐式返回）
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore();

  // 页面标题
  document.title = to.meta.title ? `${to.meta.title} - ERP 商品管理系统` : 'ERP 商品管理系统';

  if (to.meta.public) {
    // 已登录访问登录页则回首页
    if (auth.isLogged && to.name === 'login') return { path: '/' };
    return true;
  }

  // 安全加固（token 迁移 HttpOnly Cookie）：用户态仅存 Pinia 内存，页面刷新后
  // 先凭 Cookie 调 /api/auth/me 恢复会话，恢复失败（Cookie 缺失/失效）才跳登录
  if (!auth.isLogged) {
    const restored = await auth.restoreSession();
    if (!restored) {
      return { path: '/login', query: { redirect: to.fullPath } };
    }
  }

  // 强制改密用户仅可停留在登录页（改密表单）
  if (auth.user?.mustChangePassword) {
    return { path: '/login', query: { changePwd: '1' } };
  }

  // 角色拦截
  const roles = to.meta.roles as string[] | undefined;
  if (roles && !roles.includes(auth.user!.role)) {
    ElMessage.warning('无权访问该页面');
    return { path: '/' };
  }

  // 细粒度权限拦截（真门禁：直接改 URL 访问建单页也会被重定向）
  const permission = to.meta.permission as string | undefined;
  if (permission && !can(auth.user!.role, permission)) {
    ElMessage.warning('您没有执行该操作的权限');
    return { path: '/purchase-orders' };
  }
  return true;
});

export default router;
