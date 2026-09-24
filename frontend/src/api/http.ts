/**
 * axios 实例与拦截器（文件级注释）
 * ------------------------------------------------------------------
 * 核心功能：统一请求/响应拦截——请求经 withCredentials 自动携带 HttpOnly 会话
 *          Cookie（token 由后端下发于 HttpOnly Cookie，前端 JS 不可读写，彻底
 *          去除 localStorage/Authorization 通道）；响应统一拆包；401 时请求
 *          /api/auth/refresh（凭据取自 Cookie）成功后重放原请求，刷新失败则
 *          清空 Pinia 登录态并跳转登录页；403 弹"无权限"提示；其余错误弹后端 message。
 * 设计思路：刷新采用"单飞"模式（isRefreshing + 等待队列），避免并发 401 触发
 *          多次刷新；登录/刷新接口本身不进入刷新流程防止死循环；清空 Pinia 经
 *          动态 import 惰性获取 store，避免 http.ts ↔ stores/auth.ts 顶层循环依赖。
 * 适用场景：src/api 全部业务请求。
 * 创建时间：2026-09-21（2026-09-24 安全加固：token 迁移至 HttpOnly Cookie）
 */
import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import { ElMessage } from 'element-plus';
import type { ApiResp } from '@/types/api';

/** axios 实例：默认走 Vite 代理 /api；withCredentials 使同源/代理请求均携带认证 Cookie */
const http = axios.create({ baseURL: '/api', timeout: 15000, withCredentials: true });

/** 是否正在刷新会话（单飞标记） */
let refreshing = false;
/** 等待刷新完成的请求队列（resolve 值表示刷新是否成功） */
let pendingQueue: ((ok: boolean) => void)[] = [];

/**
 * 将等待中的请求挂起到刷新结束
 * @returns Promise，resolve 值为刷新是否成功（true 可重放原请求）
 */
function waitRefresh(): Promise<boolean> {
  return new Promise((resolve) => pendingQueue.push(resolve));
}

/**
 * 请求 /api/auth/refresh 换发新会话
 * 执行逻辑：凭据（refreshToken）位于 HttpOnly Cookie（path=/api/auth），请求自动
 *          携带，无需 body 传参；后端换发的新 accessToken 亦写入 Cookie。
 * @returns Promise<boolean> 刷新成功返回 true；Cookie 缺失/失效/网络异常返回 false
 */
async function doRefresh(): Promise<boolean> {
  try {
    const res = await axios.post<ApiResp<unknown>>('/api/auth/refresh', null, { withCredentials: true });
    return res.data?.code === 0;
  } catch {
    // 401（Cookie 缺失/失效）或其他异常：一律视为刷新失败，交由调用方跳转登录
    return false;
  }
}

/**
 * 清空 Pinia 登录态并跳转登录页（保留回跳地址）
 * 执行逻辑：动态 import 认证仓库（避免顶层循环依赖）调用 forceLogout 清空用户态；
 *          当前已在登录页时不重复跳转（如首登强制改密流程中的预期 401）。
 * @returns Promise<void>
 */
async function redirectToLogin(): Promise<void> {
  try {
    const { useAuthStore } = await import('@/stores/auth');
    useAuthStore().forceLogout();
  } catch {
    // Pinia 未初始化等极端场景：仅保证跳转登录，不阻断主流程
  }
  if (!location.pathname.startsWith('/login')) {
    const redirect = encodeURIComponent(location.pathname + location.search);
    location.href = `/login?redirect=${redirect}`;
  }
}

/* ---------------- 响应拦截：统一错误处理 ---------------- */
http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiResp>) => {
    const config = error.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined;
    const status = error.response?.status;
    const biz = error.response?.data;
    /** 是否为登录/刷新接口自身（不进入刷新重放流程，防止死循环） */
    const isAuthUrl = !!config?.url && (config.url.includes('/auth/login') || config.url.includes('/auth/refresh'));

    // 401：尝试刷新一次会话并重放原请求（刷新凭据经 Cookie 自动携带）
    if (status === 401 && config && !config._retried && !isAuthUrl) {
      if (refreshing) {
        const ok = await waitRefresh();
        if (ok) {
          config._retried = true;
          return http.request(config);
        }
        return Promise.reject(error);
      }
      refreshing = true;
      const ok = await doRefresh();
      refreshing = false;
      pendingQueue.forEach((fn) => fn(ok));
      pendingQueue = [];
      if (ok) {
        config._retried = true;
        return http.request(config);
      }
      // 刷新失败：清空 Pinia 用户态并静默跳登录（不弹 toast，符合 UI-DESIGN 4.6）
      await redirectToLogin();
      return Promise.reject(error);
    }

    // 403：统一提示
    if (status === 403) {
      ElMessage.error(biz?.message || '无权限执行该操作');
    } else if (status && status !== 401) {
      // 登录页自行展示错误文案（统一文案），此处不重复 toast
      if (!config?.url?.includes('/auth/login')) {
        ElMessage.error(biz?.message || `请求失败（${status}）`);
      }
    } else if (!error.response) {
      ElMessage.error('网络异常，请检查后端服务是否启动');
    }
    return Promise.reject(error);
  }
);

/**
 * 通用请求方法：拆包统一响应结构，业务 code !== 0 时抛出错误
 * @param config axios 请求配置
 * @returns 业务数据 data
 * @throws Error 业务错误（message 为后端提示），调用方需 try-catch 处理
 */
export async function request<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const res = await http.request<ApiResp<T>>(config);
    if (res.data.code !== 0) {
      throw new Error(res.data.message || '请求失败');
    }
    return res.data.data;
  } catch (err) {
    // axios 错误已在拦截器弹 toast；此处仅转发业务异常
    if (err instanceof Error && !(err instanceof AxiosError)) throw err;
    throw err instanceof Error ? err : new Error('请求失败');
  }
}

export default http;
