<script setup lang="ts">
/**
 * 404 页面（组件级注释）
 * ------------------------------------------------------------------
 * 核心功能：居中展示 404 线性插图 + "页面不存在"提示 + 返回看板按钮。
 * 设计思路：主布局内居中（UI-DESIGN 3.6），插图自绘单色线性 SVG。
 * 适用场景：未匹配路由兜底。
 * 创建时间：2026-09-21
 */
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="nf">
    <svg width="160" height="160" viewBox="0 0 160 160" fill="none" aria-hidden="true">
      <!-- 放大镜 + 断链 -->
      <circle cx="72" cy="68" r="34" stroke="#CBD5E1" stroke-width="2" />
      <path d="M98 94l22 22" stroke="#CBD5E1" stroke-width="2" stroke-linecap="round" />
      <path d="M58 68h10M76 68h10" stroke="#06B6D4" stroke-width="2" stroke-linecap="round" />
      <path d="M62 48a20 20 0 0 1 20-8" stroke="#CBD5E1" stroke-width="1.5" stroke-linecap="round" />
      <circle cx="118" cy="42" r="4" fill="#06B6D4" />
    </svg>
    <p class="nf-title">页面不存在</p>
    <p class="nf-sub">请检查地址或返回看板</p>
    <el-button type="primary" style="width: 120px" @click="router.replace('/')">返回看板</el-button>
  </div>
</template>

<style scoped>
.nf { padding: 96px 0; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.nf-title { margin: 16px 0 0; font-size: 20px; font-weight: 600; color: var(--neutral-800); }
.nf-sub { margin: 0 0 16px; font-size: 14px; color: var(--neutral-500); }
</style>
