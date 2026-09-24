<script setup lang="ts">
/**
 * 数据看板页（组件级注释）
 * ------------------------------------------------------------------
 * 核心功能：4 张统计卡（商品总数/库存总量/低库存商品数/近 7 日采购金额）+
 *          近 7 日采购金额趋势 ECharts 柱状图；低库存卡可点击跳转库存页。
 * 设计思路：统计卡加载时展示静态骨架（无扫光，R2）；失败时卡内显示错误与重试；
 *          图表柱色 #06B6D4、hover #0891B2，金额分转元保留 2 位小数，
 *          无数据日柱值 0（PRD FR-06）。
 * 适用场景：/ 路由（全部角色可见）。
 * 创建时间：2026-09-21
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import * as echarts from 'echarts';
import { Goods, Box, WarningFilled, Coin, RefreshRight } from '@element-plus/icons-vue';
import { getDashboardStats } from '@/api';
import { fen2yuan } from '@/utils/format';
import type { DashboardStats } from '@/types/api';

const router = useRouter();

/** 统计数据 */
const stats = ref<DashboardStats | null>(null);
/** 接口加载中 */
const loading = ref(true);
/** 接口失败标记 */
const loadError = ref(false);

/** 图表 DOM 容器 */
const chartEl = ref<HTMLDivElement | null>(null);
/** ECharts 实例 */
let chart: echarts.ECharts | null = null;

/**
 * 拉取统计数据并渲染
 * 执行逻辑：调看板接口 → 赋值统计卡 → 初始化/更新柱状图（日期 MM-DD、金额元）。
 * @returns Promise，失败置 loadError 供卡内重试
 */
async function loadStats(): Promise<void> {
  loading.value = true;
  loadError.value = false;
  try {
    stats.value = await getDashboardStats();
    renderChart();
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

/**
 * 渲染近 7 日采购金额柱状图
 * 执行逻辑：日期横轴 MM-DD、金额（元）纵轴；柱宽 20、圆角 [4,4,0,0]、主色渐变；
 *          空数据日显示 0；容器尺寸变化时自适应。
 * @returns void；DOM 容器不存在时静默跳过
 * @throws Error ECharts 初始化失败时由调用方兜底（不阻断统计卡展示）
 */
function renderChart(): void {
  try {
    if (!chartEl.value || !stats.value) return;
    if (!chart) chart = echarts.init(chartEl.value);
    const dates = stats.value.purchaseAmount7d.map((d) => d.date);
    const amounts = stats.value.purchaseAmount7d.map((d) => Number((d.amount / 100).toFixed(2)));
    chart.setOption({
      grid: { left: 48, right: 24, top: 24, bottom: 32 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#fff',
        borderRadius: 8,
        textStyle: { color: '#1E293B', fontSize: 13 },
        formatter: (params: unknown) => {
          const p = (params as { name: string; value: number }[])[0];
          return `${p.name}：¥${Number(p.value).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`;
        },
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLine: { lineStyle: { color: '#E2E8F0' } },
        axisTick: { show: false },
        axisLabel: { color: '#64748B', fontSize: 12 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: '#94A3B8', fontSize: 12 },
        splitLine: { lineStyle: { color: '#E2E8F0', type: 'dashed' } },
      },
      series: [
        {
          type: 'bar',
          data: amounts,
          barWidth: 20,
          itemStyle: { borderRadius: [4, 4, 0, 0], color: '#06B6D4' },
          emphasis: { itemStyle: { color: '#0891B2' } },
        },
      ],
    });
  } catch (err) {
    console.error('[dashboard] 图表渲染失败:', err);
  }
}

/**
 * 低库存卡点击：跳库存页并自动开启仅看低库存
 * @returns void
 */
function goLowStock(): void {
  router.push({ path: '/inventory', query: { lowStock: '1' } });
}

/** 生命周期：加载数据 + 图表自适应 */
onMounted(() => {
  loadStats();
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  chart?.dispose();
  chart = null;
});

/**
 * 窗口尺寸变化：图表自适应
 * @returns void
 */
function onResize(): void {
  chart?.resize();
}
</script>

<template>
  <div class="dash">
    <!-- 页头 -->
    <div class="page-head">
      <h2 class="page-title">数据看板</h2>
    </div>

    <!-- 统计卡区 -->
    <div class="stat-grid">
      <!-- 商品总数 -->
      <div class="stat-card">
        <div class="stat-top">
          <div class="stat-icon" style="background: #ECFEFF; color: #0E7490;"><el-icon :size="18"><Goods /></el-icon></div>
          <span class="stat-label">商品总数</span>
        </div>
        <template v-if="loading"><div class="sk value-sk"></div></template>
        <template v-else-if="loadError"><span class="stat-err">加载失败</span></template>
        <template v-else>
          <div class="stat-value num">{{ stats?.productCount ?? 0 }}</div>
          <p class="stat-sub">未删除商品</p>
        </template>
      </div>

      <!-- 库存总量 -->
      <div class="stat-card">
        <div class="stat-top">
          <div class="stat-icon" style="background: #DBEAFE; color: #1D4ED8;"><el-icon :size="18"><Box /></el-icon></div>
          <span class="stat-label">库存总量</span>
        </div>
        <template v-if="loading"><div class="sk value-sk"></div></template>
        <template v-else-if="loadError"><span class="stat-err">加载失败</span></template>
        <template v-else>
          <div class="stat-value num">{{ stats?.totalStock ?? 0 }}</div>
          <p class="stat-sub">全部商品库存合计</p>
        </template>
      </div>

      <!-- 低库存商品数（可点击） -->
      <div class="stat-card low-card" @click="goLowStock">
        <div class="stat-top">
          <div class="stat-icon" style="background: #FEF3C7; color: #B45309;"><el-icon :size="18"><WarningFilled /></el-icon></div>
          <span class="stat-label">低库存商品数</span>
          <span class="view-link">查看</span>
        </div>
        <template v-if="loading"><div class="sk value-sk"></div></template>
        <template v-else-if="loadError"><span class="stat-err">加载失败</span></template>
        <template v-else>
          <div class="stat-value num" :class="{ warn: (stats?.lowStockCount ?? 0) > 0 }">{{ stats?.lowStockCount ?? 0 }}</div>
          <p class="stat-sub">数量 ≤ 预警阈值</p>
        </template>
      </div>

      <!-- 近 7 日采购金额 -->
      <div class="stat-card">
        <div class="stat-top">
          <div class="stat-icon" style="background: #D1FAE5; color: #047857;"><el-icon :size="18"><Coin /></el-icon></div>
          <span class="stat-label">近 7 日采购金额</span>
        </div>
        <template v-if="loading"><div class="sk value-sk"></div></template>
        <template v-else-if="loadError"><span class="stat-err">加载失败</span></template>
        <template v-else>
          <div class="stat-value num">¥{{ fen2yuan((stats?.purchaseAmount7d ?? []).reduce((s, d) => s + d.amount, 0)) }}</div>
          <p class="stat-sub">按入库时间统计</p>
        </template>
      </div>
    </div>

    <!-- 趋势图卡片 -->
    <div class="card chart-card">
      <div class="chart-head">
        <span class="chart-title">近 7 日采购金额趋势</span>
        <span class="chart-legend">按入库单统计</span>
        <el-button v-if="loadError" text size="small" :icon="RefreshRight" @click="loadStats">重试</el-button>
      </div>
      <div v-show="!loadError" ref="chartEl" class="chart"></div>
    </div>

    <!-- 错误重试（卡片区） -->
    <div v-if="loadError" class="err-bar">
      <span>统计数据加载失败</span>
      <el-button text type="primary" :icon="RefreshRight" @click="loadStats">重试</el-button>
    </div>
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.page-title { margin: 0; font-size: 20px; font-weight: 600; color: var(--neutral-800); }

.stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
@media (max-width: 1279px) { .stat-grid { grid-template-columns: repeat(2, 1fr); gap: 12px; } }
@media (max-width: 767px) { .stat-grid { grid-template-columns: 1fr; } }

.stat-card {
  background: #fff; border: 1px solid var(--neutral-100); border-radius: 8px;
  box-shadow: var(--shadow-sm); padding: 20px;
}
.stat-top { display: flex; align-items: center; gap: 8px; }
.stat-icon { width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
.stat-label { font-size: 13px; color: var(--neutral-500); }
.view-link { margin-left: auto; font-size: 13px; color: var(--warning-text); opacity: 0; transition: opacity 150ms ease-out; }
.stat-value { margin-top: 12px; font-size: 30px; line-height: 38px; font-weight: 700; color: var(--neutral-800); }
.stat-value.warn { color: var(--warning-text); }
.stat-sub { margin: 4px 0 0; font-size: 12px; color: var(--neutral-400); }
.stat-err { display: inline-block; margin-top: 12px; font-size: 13px; color: var(--danger-500); }

/* 低库存卡：可点击、hover 阴影升级（≤200ms） */
.low-card { cursor: pointer; transition: box-shadow 200ms ease-out; }
.low-card:hover { box-shadow: var(--shadow-md); }
.low-card:hover .view-link { opacity: 1; }

/* 静态骨架（无扫光） */
.sk { background: var(--neutral-100); border-radius: 4px; }
.value-sk { width: 120px; height: 30px; margin-top: 12px; }

.chart-card { margin-top: 16px; }
.chart-head { display: flex; align-items: center; gap: 12px; }
.chart-title { font-size: 16px; font-weight: 600; color: var(--neutral-800); }
.chart-legend { font-size: 12px; color: var(--neutral-400); }
.chart { height: 320px; margin-top: 8px; }
@media (min-width: 1536px) { .chart { height: 380px; } }

.err-bar { margin-top: 16px; display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--danger-500); }
</style>
