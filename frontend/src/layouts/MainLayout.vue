<script setup lang="ts">
/**
 * 主布局组件（组件级注释）
 * ------------------------------------------------------------------
 * 核心功能：左侧导航（桌面 240px 展开 / 64px 折叠 / 移动端抽屉）+ 顶栏
 *          （面包屑、低库存角标铃铛、用户下拉）+ 内容区；用户下拉含
 *          修改密码弹窗与退出登录。
 * 设计思路：菜单按角色显隐（/users、/audit-logs 仅 admin）；低库存角标经
 *          看板统计接口获取；响应式断点经 matchMedia 监听（lg/md/sm/xs）。
 * 适用场景：全部受保护页面的父级布局。
 * 创建时间：2026-09-21
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Odometer, Goods, OfficeBuilding, ShoppingCart, Box, User, Document, Bell, Fold, Expand, CaretBottom, Lock } from '@element-plus/icons-vue';
import { useAuthStore } from '@/stores/auth';
import { getDashboardStats, changePasswordApi } from '@/api';
import { ROLE_MAP } from '@/utils/format';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

/** 菜单项结构 */
interface MenuItem {
  path: string;
  title: string;
  icon: typeof Odometer;
  adminOnly?: boolean;
}

/** 侧栏菜单清单（顺序固定，UI-DESIGN 3.3） */
const menus: MenuItem[] = [
  { path: '/', title: '数据看板', icon: Odometer },
  { path: '/products', title: '商品管理', icon: Goods },
  { path: '/suppliers', title: '供应商管理', icon: OfficeBuilding },
  { path: '/purchase-orders', title: '采购管理', icon: ShoppingCart },
  { path: '/inventory', title: '库存管理', icon: Box },
  { path: '/users', title: '用户管理', icon: User, adminOnly: true },
  { path: '/audit-logs', title: '操作日志', icon: Document, adminOnly: true },
];

/** 当前窗口宽度（px） */
const winWidth = ref(window.innerWidth);
/** 侧栏是否折叠（桌面） */
const collapsed = ref(window.innerWidth < 1280);
/** 移动端抽屉是否打开 */
const drawerOpen = ref(false);
/** 改密弹窗可见性 */
const pwdDialogVisible = ref(false);
/** 改密表单 */
const pwdForm = ref({ oldPassword: '', newPassword: '', confirmPassword: '' });
/** 改密提交中 */
const pwdLoading = ref(false);

/** 是否移动端（<1024 抽屉模式） */
const isMobile = computed(() => winWidth.value < 1024);

/** 按角色过滤后的菜单 */
const visibleMenus = computed(() => menus.filter((m) => !m.adminOnly || auth.user?.role === 'admin'));

/** 当前页面标题（面包屑） */
const pageTitle = computed(() => (route.meta.title as string) || '');

/**
 * 窗口尺寸变化监听：更新宽度、按断点重置折叠态
 * @returns void
 */
function onResize(): void {
  winWidth.value = window.innerWidth;
  if (winWidth.value < 1024) {
    drawerOpen.value = false;
  } else {
    collapsed.value = winWidth.value < 1280;
  }
}

/**
 * 菜单点击跳转
 * @param path 目标路由路径
 * @returns void
 */
function goMenu(path: string): void {
  drawerOpen.value = false;
  if (route.path !== path) router.push(path);
}

/**
 * 铃铛点击：跳转库存页并开启仅看低库存
 * @returns void
 */
function goLowStock(): void {
  router.push({ path: '/inventory', query: { lowStock: '1' } });
}

/**
 * 刷新低库存角标数量
 * @returns Promise，失败静默（角标保持旧值）
 */
async function refreshBadge(): Promise<void> {
  try {
    const stats = await getDashboardStats();
    auth.lowStockCount = stats.lowStockCount;
  } catch {
    // 静默失败：角标不影响主流程
  }
}

/**
 * 提交修改密码
 * 执行逻辑：校验两次输入一致 → 调改密接口 → 成功后强制重新登录。
 * @returns Promise，异常经拦截器 toast 提示
 */
async function submitChangePwd(): Promise<void> {
  if (pwdForm.value.newPassword !== pwdForm.value.confirmPassword) {
    ElMessage.error('两次输入的新密码不一致');
    return;
  }
  pwdLoading.value = true;
  try {
    await changePasswordApi(pwdForm.value.oldPassword, pwdForm.value.newPassword);
    ElMessage.success('密码修改成功，请重新登录');
    pwdDialogVisible.value = false;
    await auth.doLogout();
    router.push('/login');
  } catch {
    // 错误提示已由拦截器统一处理
  } finally {
    pwdLoading.value = false;
  }
}

/** 生命周期：挂载监听窗口变化并拉取角标 */
onMounted(() => {
  window.addEventListener('resize', onResize);
  refreshBadge();
});
onBeforeUnmount(() => window.removeEventListener('resize', onResize));

// 路由变化时刷新角标（低库存可能被其他操作改变）
watch(() => route.path, () => refreshBadge());
</script>

<template>
  <div class="layout">
    <!-- ============ 侧栏 ============ -->
    <aside v-if="!isMobile" class="sidebar" :class="{ collapsed }">
      <div class="logo-row">
        <div class="logo-icon"><el-icon :size="18"><Box /></el-icon></div>
        <span v-show="!collapsed" class="logo-name">ERP 商品管理</span>
      </div>
      <nav class="menu">
        <div
          v-for="m in visibleMenus"
          :key="m.path"
          class="menu-item"
          :class="{ active: route.path === m.path || (m.path !== '/' && route.path.startsWith(m.path)) }"
          :title="collapsed ? m.title : undefined"
          @click="goMenu(m.path)"
        >
          <el-icon :size="18"><component :is="m.icon" /></el-icon>
          <span v-show="!collapsed" class="menu-text">{{ m.title }}</span>
        </div>
      </nav>
      <div class="sidebar-foot">
        <span v-show="!collapsed" class="version">v1.0.0</span>
        <el-icon class="fold-btn" :size="16" @click="collapsed = !collapsed">
          <Expand v-if="collapsed" /><Fold v-else />
        </el-icon>
      </div>
    </aside>

    <!-- 移动端抽屉遮罩 -->
    <div v-if="isMobile && drawerOpen" class="drawer-mask" @click="drawerOpen = false"></div>
    <aside v-if="isMobile" class="sidebar drawer" :class="{ open: drawerOpen }">
      <div class="logo-row">
        <div class="logo-icon"><el-icon :size="18"><Box /></el-icon></div>
        <span class="logo-name">ERP 商品管理</span>
      </div>
      <nav class="menu">
        <div
          v-for="m in visibleMenus"
          :key="m.path"
          class="menu-item"
          :class="{ active: route.path === m.path || (m.path !== '/' && route.path.startsWith(m.path)) }"
          @click="goMenu(m.path)"
        >
          <el-icon :size="18"><component :is="m.icon" /></el-icon>
          <span class="menu-text">{{ m.title }}</span>
        </div>
      </nav>
    </aside>

    <!-- ============ 右侧区域 ============ -->
    <div class="main-area" :class="{ 'sidebar-collapsed': !isMobile && collapsed }">
      <header class="topbar">
        <div class="topbar-left">
          <el-icon v-if="isMobile" class="hamburger" :size="20" @click="drawerOpen = true"><Expand /></el-icon>
          <span class="breadcrumb">
            <span class="crumb-root">ERP</span>
            <span class="crumb-sep">/</span>
            <span class="crumb-current">{{ pageTitle }}</span>
          </span>
        </div>
        <div class="topbar-right">
          <el-badge :value="auth.lowStockCount" :hidden="auth.lowStockCount <= 0" :max="99" class="bell-badge">
            <el-icon class="bell" :size="20" @click="goLowStock"><Bell /></el-icon>
          </el-badge>
          <span class="v-sep"></span>
          <el-dropdown trigger="click" @command="(cmd: string) => cmd === 'pwd' ? (pwdDialogVisible = true) : auth.doLogout().then(() => router.push('/login'))">
            <div class="user-chip">
              <div class="avatar">{{ (auth.user?.realName || '?').slice(0, 1) }}</div>
              <span class="user-name">{{ auth.user?.realName }}</span>
              <el-icon :size="12"><CaretBottom /></el-icon>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>{{ ROLE_MAP[auth.user?.role || 'viewer']?.label }}</el-dropdown-item>
                <el-dropdown-item divided command="pwd" :icon="Lock">修改密码</el-dropdown-item>
                <el-dropdown-item command="logout" class="logout-item">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <main class="content">
        <router-view v-slot="{ Component }">
          <transition name="page" appear>
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>

    <!-- ============ 修改密码弹窗 ============ -->
    <el-dialog v-model="pwdDialogVisible" title="修改密码" width="440px" :close-on-click-modal="false">
      <el-form label-width="96px" label-position="left">
        <el-form-item label="原密码" required>
          <el-input v-model="pwdForm.oldPassword" type="password" show-password placeholder="请输入原密码" />
        </el-form-item>
        <el-form-item label="新密码" required>
          <el-input v-model="pwdForm.newPassword" type="password" show-password placeholder="8~32 位，须同时包含字母和数字" />
        </el-form-item>
        <el-form-item label="确认新密码" required>
          <el-input v-model="pwdForm.confirmPassword" type="password" show-password placeholder="再次输入新密码" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="pwdLoading" @click="submitChangePwd">确定修改</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 布局骨架：flex（R6 禁止写死总宽） */
.layout { display: flex; min-height: 100vh; }

/* ---------- 侧栏 ---------- */
.sidebar {
  width: var(--sidebar-w);
  height: 100vh;
  position: fixed;
  inset: 0 auto 0 0;
  background: #ffffff;
  border-right: 1px solid var(--neutral-100);
  display: flex;
  flex-direction: column;
  transition: width 200ms ease-out;
  z-index: 30;
}
.sidebar.collapsed { width: var(--sidebar-collapsed-w); }

.logo-row { height: var(--topbar-h); display: flex; align-items: center; gap: 12px; padding: 0 12px; }
.logo-icon {
  width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0;
  background: var(--brand-500); color: #fff;
  display: flex; align-items: center; justify-content: center;
}
.logo-name { font-size: 16px; font-weight: 600; color: var(--neutral-800); white-space: nowrap; }

.menu { flex: 1; padding: 8px 12px; overflow-y: auto; }
.menu-item {
  height: 40px; border-radius: 8px; display: flex; align-items: center; gap: 8px;
  padding: 0 12px; margin-bottom: 4px; cursor: pointer;
  color: var(--neutral-600); font-size: 14px; white-space: nowrap;
  transition: background-color 150ms ease-out, color 150ms ease-out;
}
.menu-item:hover { background: var(--neutral-25); color: var(--neutral-800); }
.menu-item.active {
  background: var(--brand-50); color: var(--brand-700); font-weight: 500;
  box-shadow: inset 3px 0 0 var(--brand-500);
}

.sidebar-foot { display: flex; align-items: center; justify-content: space-between; padding: 12px; }
.version { font-size: 12px; color: var(--neutral-400); }
.fold-btn { cursor: pointer; color: var(--neutral-400); }
.fold-btn:hover { color: var(--neutral-800); }

/* 移动端抽屉 */
.drawer { transform: translateX(-100%); transition: transform 240ms ease-out; width: var(--sidebar-w); }
.drawer.open { transform: translateX(0); }
.drawer-mask {
  position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); z-index: 25;
}

/* ---------- 右侧 ---------- */
.main-area { flex: 1; margin-left: var(--sidebar-w); display: flex; flex-direction: column; min-width: 0; transition: margin-left 200ms ease-out; }
.main-area.sidebar-collapsed { margin-left: var(--sidebar-collapsed-w); }

.topbar {
  height: var(--topbar-h); background: #ffffff; border-bottom: 1px solid var(--neutral-100);
  display: flex; align-items: center; justify-content: space-between; padding: 0 16px;
  position: sticky; top: 0; z-index: 20;
}
.topbar-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.hamburger { cursor: pointer; color: var(--neutral-600); }
.breadcrumb { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.crumb-root { color: var(--neutral-500); }
.crumb-sep { color: var(--neutral-300); margin: 0 6px; }
.crumb-current { color: var(--neutral-800); font-weight: 500; }

.topbar-right { display: flex; align-items: center; gap: 12px; }
.bell-badge { display: flex; }
.bell { cursor: pointer; color: var(--neutral-600); }
.bell:hover { color: var(--neutral-800); }
:deep(.el-badge__content) { background-color: var(--warning-500); }
.v-sep { width: 1px; height: 20px; background: var(--neutral-100); }

.user-chip {
  display: flex; align-items: center; gap: 8px; height: 40px; border-radius: 8px;
  padding: 0 8px; cursor: pointer;
}
.user-chip:hover { background: var(--neutral-25); }
.avatar {
  width: 28px; height: 28px; border-radius: 999px; background: var(--brand-500);
  color: #fff; font-size: 13px; display: flex; align-items: center; justify-content: center;
}
.user-name { font-size: 14px; color: var(--neutral-800); }
.logout-item { color: var(--danger-500) !important; }

.content { padding: 24px 24px 32px; }
@media (max-width: 767px) {
  .content { padding: 16px 12px 24px; }
  .user-name { display: none; }
}
</style>
