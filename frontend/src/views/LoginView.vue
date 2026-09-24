<script setup lang="ts">
/**
 * 登录页（组件级注释）
 * ------------------------------------------------------------------
 * 核心功能：用户名/密码登录（可切换明文、loading 防重复提交、统一错误文案）；
 *          首登强制改密时同卡位切换为"修改初始密码"表单，完成前禁止离开；
 *          登录成功后按回跳地址跳转。
 * 设计思路：按 UI-DESIGN 5.1 落地——400px 居中卡片、装饰圆环、错误统一文案
 *          "用户名或密码错误，或账号已被锁定"；改密成功后回到登录表单重新登录。
 * 适用场景：/login 路由。
 * 创建时间：2026-09-21
 */
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { User, Lock, CircleClose, Box } from '@element-plus/icons-vue';
import { loginApi, changePasswordApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import type { LoginData } from '@/types/api';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

/** 表单数据 */
const form = reactive({ username: '', password: '' });
/** 提交中标记 */
const loading = ref(false);
/** 错误提示文案 */
const errorMsg = ref('');
/** 是否处于强制改密表单 */
const changeMode = ref(route.query.changePwd === '1');
/** 改密表单 */
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' });
/** 改密提交中 */
const pwdLoading = ref(false);

/** 密码规则提示 */
const pwdHint = '8~32 位，须同时包含字母和数字';

/** 是否可提交登录（计算属性） */
const canSubmit = computed(() => form.username.trim().length > 0 && form.password.length > 0);

/**
 * 提交登录
 * 执行逻辑：调用登录接口（token 由后端写入 HttpOnly Cookie，前端仅保存用户态）
 *          → 若 mustChangePassword=1 则切换改密表单（改密接口凭 Cookie 调用），
 *          否则跳转回跳地址；异常时展示统一错误文案。
 * @returns Promise，网络/业务异常均在 catch 中处理
 */
async function submitLogin(): Promise<void> {
  if (loading.value) return;
  errorMsg.value = '';
  loading.value = true;
  try {
    const data: LoginData = await loginApi(form.username.trim(), form.password);
    // 安全加固：token 已在响应 Set-Cookie 中下发（HttpOnly，JS 不可读），前端仅保存非敏感用户态
    auth.setLogin(data.user);
    if (data.user.mustChangePassword) {
      // 首登强制改密：停留登录页切换为改密表单（路由守卫同时阻止其访问其他页面）
      changeMode.value = true;
    } else {
      const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
      await router.replace(redirect);
    }
  } catch (err) {
    // 登录页统一错误文案（不区分密码错误/锁定，防账号枚举）
    errorMsg.value = err instanceof Error && err.message !== '网络异常，请检查后端服务是否启动'
      ? '用户名或密码错误，或账号已被锁定'
      : '网络异常，请稍后重试';
  } finally {
    loading.value = false;
  }
}

/**
 * 提交修改初始密码
 * 执行逻辑：校验两次输入一致 → 调改密接口 → 成功后清空表单回到登录模式，
 *          提示重新登录（token 已因版本号变更而失效）。
 * @returns Promise，异常经拦截器提示
 */
async function submitChangePwd(): Promise<void> {
  if (pwdForm.newPassword !== pwdForm.confirmPassword) {
    ElMessage.error('两次输入的新密码不一致');
    return;
  }
  pwdLoading.value = true;
  try {
    await changePasswordApi(pwdForm.oldPassword, pwdForm.newPassword);
    ElMessage.success('密码修改成功，请使用新密码登录');
    // 改密后 token_version 已变更，旧 token 全部失效：清空本地登录态回到登录表单
    await auth.doLogout();
    changeMode.value = false;
    pwdForm.oldPassword = '';
    pwdForm.newPassword = '';
    pwdForm.confirmPassword = '';
  } catch {
    // 错误提示由拦截器统一处理
  } finally {
    pwdLoading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <!-- 静态装饰（无动画，R2） -->
    <div class="deco-ring"></div>
    <div class="deco-circle"></div>

    <div class="login-card">
      <!-- Logo 行 -->
      <div class="logo-row">
        <div class="logo-icon"><el-icon :size="22"><Box /></el-icon></div>
        <span class="sys-name">ERP 商品管理系统</span>
      </div>
      <p class="sub-title">商品 · 采购 · 库存 一体化管理</p>

      <!-- 登录表单 -->
      <template v-if="!changeMode">
        <div class="form-area">
          <el-input v-model="form.username" size="large" placeholder="用户名" :prefix-icon="User" @keyup.enter="submitLogin" />
          <el-input v-model="form.password" size="large" type="password" show-password placeholder="密码" :prefix-icon="Lock" @keyup.enter="submitLogin" />
          <p v-if="errorMsg" class="error-line" aria-live="polite">
            <el-icon :size="14" color="#EF4444"><CircleClose /></el-icon>
            <span>{{ errorMsg }}</span>
          </p>
          <el-button type="primary" size="large" class="login-btn" :loading="loading" :disabled="!canSubmit" @click="submitLogin">
            {{ loading ? '登录中…' : '登 录' }}
          </el-button>
        </div>
      </template>

      <!-- 首登强制改密表单 -->
      <template v-else>
        <div class="form-area">
          <p class="change-title">修改初始密码</p>
          <el-input v-model="pwdForm.oldPassword" size="large" type="password" show-password placeholder="原密码" :prefix-icon="Lock" />
          <el-input v-model="pwdForm.newPassword" size="large" type="password" show-password placeholder="新密码" :prefix-icon="Lock" />
          <el-input v-model="pwdForm.confirmPassword" size="large" type="password" show-password placeholder="确认新密码" :prefix-icon="Lock" />
          <p class="pwd-hint">{{ pwdHint }}</p>
          <el-button type="primary" size="large" class="login-btn" :loading="pwdLoading" @click="submitChangePwd">确认修改</el-button>
          <el-button text class="back-btn" @click="changeMode = false">返回登录</el-button>
        </div>
      </template>
    </div>

    <p class="version">v1.0.0</p>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  background: var(--neutral-50);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}
/* 右上装饰圆环 */
.deco-ring {
  position: absolute; top: -160px; right: -160px; width: 480px; height: 480px;
  border-radius: 999px; border: 48px solid var(--brand-50); pointer-events: none;
}
/* 左下实心淡圆 */
.deco-circle {
  position: absolute; bottom: -80px; left: -60px; width: 240px; height: 240px;
  border-radius: 999px; background: rgba(236, 254, 255, 0.6); pointer-events: none;
}

.login-card {
  width: 400px; max-width: calc(100% - 32px);
  background: #ffffff; border-radius: 12px; box-shadow: var(--shadow-lg);
  padding: 40px 32px; z-index: 1;
}
.logo-row { display: flex; align-items: center; justify-content: center; gap: 12px; }
.logo-icon {
  width: 40px; height: 40px; border-radius: 8px; background: var(--brand-500);
  color: #fff; display: flex; align-items: center; justify-content: center;
}
.sys-name { font-size: 20px; font-weight: 600; color: var(--neutral-800); }
.sub-title { margin: 8px 0 0; text-align: center; font-size: 13px; color: var(--neutral-500); }

.form-area { margin-top: 32px; display: flex; flex-direction: column; gap: 16px; }
.change-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--neutral-800); text-align: center; }

.error-line { margin: 0; display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--danger-500); }
.login-btn { width: 100%; margin-top: 0; }
.pwd-hint { margin: 0; font-size: 12px; color: var(--neutral-500); }
.back-btn { align-self: center; }

.version { margin-top: 24px; text-align: center; font-size: 12px; color: var(--neutral-400); }

@media (max-width: 375px) {
  .login-card { padding: 32px 20px; }
}
</style>
