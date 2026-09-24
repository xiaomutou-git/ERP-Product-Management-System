<script setup lang="ts">
/**
 * 根组件（组件级注释）
 * ------------------------------------------------------------------
 * 核心功能：路由出口容器；为路由切换提供 220ms 入场动画容器（R2 红线）。
 * 创建时间：2026-09-21
 */
</script>

<template>
  <router-view v-slot="{ Component }">
    <transition name="page">
      <component :is="Component" />
    </transition>
  </router-view>
</template>
