<script setup lang="ts">
/**
 * 空状态组件（组件级注释）
 * ------------------------------------------------------------------
 * 核心功能：统一空态展示——自绘单色线性 SVG 插图（120x120，纸箱线稿 +
 *          主色点缀）+ 主/副文案 + 可选操作按钮；按场景区分四类文案。
 * 设计思路：与 UI-DESIGN 4.8 对齐；无数据/搜索无结果/无权限/加载失败四种
 *          语义由调用方传入文案与按钮配置。
 * 适用场景：表格空数据、搜索无结果、加载失败重试。
 * 创建时间：2026-09-21
 */

/** 组件 props */
const props = withDefaults(
  defineProps<{
    /** 主文案，如"暂无商品数据" */
    main?: string;
    /** 副文案，如"点击右上角新增商品开始录入" */
    sub?: string;
    /** 操作按钮文字（为空则不渲染按钮） */
    actionText?: string;
    /** 点缀圆点颜色（低库存场景可用琥珀色） */
    dotColor?: string;
  }>(),
  { main: '暂无数据', sub: '', actionText: '', dotColor: '#06B6D4' }
);

/** 组件事件：按钮点击 */
const emit = defineEmits<{ (e: 'action'): void }>();
</script>

<template>
  <div class="empty-state">
    <!-- 自绘线性插图：纸箱 + 点缀（禁止表情包/照片/卡通） -->
    <svg width="120" height="120" viewBox="0 0 120 120" fill="none" aria-hidden="true">
      <rect x="28" y="42" width="64" height="48" rx="4" stroke="#CBD5E1" stroke-width="1.5" />
      <path d="M28 54h64M60 42v12M40 42l8 12M80 42l-8 12" stroke="#CBD5E1" stroke-width="1.5" />
      <path d="M36 42v-8a4 4 0 0 1 4-4h40a4 4 0 0 1 4 4v8" stroke="#CBD5E1" stroke-width="1.5" />
      <circle cx="92" cy="38" r="4" :fill="props.dotColor" />
      <circle cx="24" cy="92" r="3" :fill="props.dotColor" opacity="0.6" />
    </svg>
    <p class="empty-main">{{ props.main }}</p>
    <p v-if="props.sub" class="empty-sub">{{ props.sub }}</p>
    <el-button v-if="props.actionText" size="default" @click="emit('action')">{{ props.actionText }}</el-button>
  </div>
</template>

<style scoped>
.empty-state {
  padding: 64px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.empty-main { margin: 8px 0 0; font-size: 14px; font-weight: 500; color: var(--neutral-600); }
.empty-sub { margin: 0 0 8px; font-size: 13px; color: var(--neutral-400); }
</style>
