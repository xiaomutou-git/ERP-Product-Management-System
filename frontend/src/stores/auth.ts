/**
 * 认证状态仓库（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：Pinia 管理登录态——用户信息（非敏感展示数据）、强制改密标记、
 *          登录/登出动作与低库存角标数量。
 * 设计思路：安全加固（2026-09-24，token 存储迁移）后，双令牌全部由后端经
 *          HttpOnly Cookie 管理，前端不持有、不存储任何 token（localStorage/
 *          sessionStorage/可被 JS 读取的 Cookie 一律禁用）；本仓库仅保存用户名/
 *          角色等非敏感展示数据（内存态，页面刷新即失）；页面刷新后经
 *          restoreSession() 调 /api/auth/me 恢复会话（Cookie 自动携带，access
 *          失效时 axios 拦截器自动走 refresh 重放），恢复失败视为未登录。
 * 适用场景：登录页、主布局、路由守卫。
 * 创建时间：2026-09-21（2026-09-24 安全加固：去除本地 token 存储 + 会话恢复）
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { meApi, logoutApi } from '@/api';
import type { UserInfo } from '@/types/api';

export const useAuthStore = defineStore('auth', () => {
  /** 当前用户信息（非敏感展示数据；null 表示未登录/会话未恢复） */
  const user = ref<UserInfo | null>(null);
  /** 低库存商品数（顶栏角标） */
  const lowStockCount = ref<number>(0);

  /** 是否已登录（计算属性） */
  const isLogged = computed(() => !!user.value);

  /** 会话恢复去重句柄：并发守卫导航共用同一次 /me 请求 */
  let restorePromise: Promise<boolean> | null = null;

  /**
   * 保存登录态（登录成功后调用；token 已由后端写入 HttpOnly Cookie，前端不落盘）
   * @param u 后端返回的用户信息
   * @returns void
   */
  function setLogin(u: UserInfo): void {
    user.value = { ...u };
  }

  /**
   * 仅更新用户信息（如改密后清除强制改密标记）
   * @param u 新用户信息
   * @returns void
   */
  function setUser(u: UserInfo): void {
    user.value = { ...u };
  }

  /**
   * 恢复会话（页面刷新后调用）：凭 Cookie 请求 /api/auth/me 重建内存登录态
   * 执行逻辑：access Cookie 失效时由 axios 拦截器自动经 /refresh 换新并重放；
   *          均失败（未登录/会话过期）则清空用户态返回 false；同一次导航内的
   *          并发调用复用同一 Promise 防止重复请求。
   * @returns Promise<boolean> 会话有效且用户态已恢复返回 true；否则 false
   */
  function restoreSession(): Promise<boolean> {
    if (!restorePromise) {
      restorePromise = (async () => {
        try {
          user.value = await meApi();
          return true;
        } catch {
          // 会话无效/网络异常：视为未登录，等待跳转登录页
          user.value = null;
          return false;
        }
      })();
      // 完成后释放句柄，允许登出后再次进入时重新恢复
      restorePromise.finally(() => {
        restorePromise = null;
      });
    }
    return restorePromise;
  }

  /**
   * 登出：调用后端接口（使令牌全端失效并清除 HttpOnly Cookie）并清空本地登录态
   * @returns Promise，失败不抛出（登出尽力而为；401 场景拦截器会尝试刷新后重放）
   */
  async function doLogout(): Promise<void> {
    try {
      await logoutApi();
    } catch {
      // 后端登出失败不阻断本地登出
    }
    user.value = null;
  }

  /**
   * 本地强制登出（清空内存登录态不调接口；token 由后端 Cookie 管理无需本地清理）
   * @returns void
   */
  function forceLogout(): void {
    user.value = null;
  }

  return { user, lowStockCount, isLogged, setLogin, setUser, restoreSession, doLogout, forceLogout };
});
