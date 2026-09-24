<script setup lang="ts">
/**
 * 操作日志页（组件级注释）
 * ------------------------------------------------------------------
 * 核心功能：仅管理员可见——按操作人/模块/动作/时间区间筛选，分页表格；
 *          详情经表格展开行展示格式化 JSON（密码类字段后端已脱敏为 ******），
 *          UA 全文展示；只读无任何写入口。
 * 设计思路：动作 Tag 按危险/常规配色（UI-DESIGN 5.8）；JSON 展示做格式化与
 *          转义（纯文本渲染，无 v-html，防 XSS）。
 * 适用场景：/audit-logs 路由。
 * 创建时间：2026-09-21
 */
import { onMounted, reactive, ref } from 'vue';
import { Search, Refresh } from '@element-plus/icons-vue';
import EmptyState from '@/components/EmptyState.vue';
import { listAuditLogs } from '@/api';
import { AUDIT_ACTION_MAP, AUDIT_MODULE_MAP, fmtTime } from '@/utils/format';
import type { AuditLogRow } from '@/types/api';

/** 筛选 */
const filters = reactive({ username: '', module: undefined as string | undefined, action: undefined as string | undefined, startDate: '', endDate: '' });
const rows = ref<AuditLogRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const tableLoading = ref(false);
const firstLoading = ref(true);

/** 模块下拉选项（UI-DESIGN 5.8 固定清单） */
const MODULE_OPTIONS = [
  { value: 'auth', label: '登录' },
  { value: 'product', label: '商品' },
  { value: 'category', label: '分类' },
  { value: 'supplier', label: '供应商' },
  { value: 'purchase', label: '采购' },
  { value: 'inventory', label: '库存' },
  { value: 'user', label: '用户' },
];

/** 动作下拉选项 */
const ACTION_OPTIONS = Object.entries(AUDIT_ACTION_MAP).map(([value, v]) => ({ value, label: v.label }));

/**
 * 加载日志列表
 * @returns Promise，失败清空
 */
async function loadList(): Promise<void> {
  tableLoading.value = true;
  try {
    const data = await listAuditLogs({
      page: page.value,
      pageSize: pageSize.value,
      username: filters.username || undefined,
      module: filters.module,
      action: filters.action,
      startDate: filters.startDate || undefined,
      endDate: filters.endDate || undefined,
    });
    rows.value = data.list;
    total.value = data.total;
  } catch {
    rows.value = [];
  } finally {
    tableLoading.value = false;
    firstLoading.value = false;
  }
}

/** 搜索 */
function doSearch(): void {
  page.value = 1;
  loadList();
}

/** 重置 */
function doReset(): void {
  filters.username = '';
  filters.module = undefined;
  filters.action = undefined;
  filters.startDate = '';
  filters.endDate = '';
  doSearch();
}

/**
 * 将 detail JSON 字符串格式化为多行文本（纯文本插值，防 XSS）
 * @param detail JSON 字符串
 * @returns 格式化后的文本；解析失败展示原文
 */
function prettyDetail(detail: string | null): string {
  if (!detail) return '—';
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

/**
 * 动作 Tag 样式
 * @param action 动作编码
 * @returns 行内样式对象
 */
function actionStyle(action: string): Record<string, string> {
  const danger = AUDIT_ACTION_MAP[action]?.danger;
  return danger ? { color: '#B91C1C', background: '#FEE2E2' } : { color: '#0E7490', background: '#CFFAFE' };
}

onMounted(loadList);
</script>

<template>
  <div class="logs-page">
    <div class="page-head">
      <h2 class="page-title">操作日志</h2>
    </div>

    <!-- 筛选区（无任何新增类按钮） -->
    <div class="card filter-card">
      <div class="filter-row">
        <el-input v-model="filters.username" class="w-160" placeholder="操作人" clearable :prefix-icon="Search" @keyup.enter="doSearch" @clear="doSearch" />
        <el-select v-model="filters.module" class="w-140" placeholder="全部模块" clearable>
          <el-option v-for="m in MODULE_OPTIONS" :key="m.value" :label="m.label" :value="m.value" />
        </el-select>
        <el-select v-model="filters.action" class="w-140" placeholder="全部动作" clearable>
          <el-option v-for="a in ACTION_OPTIONS" :key="a.value" :label="a.label" :value="a.value" />
        </el-select>
        <div class="date-pair">
          <el-date-picker v-model="filters.startDate" type="date" placeholder="开始日期" value-format="YYYY-MM-DD" class="w-140" />
          <span class="sep">至</span>
          <el-date-picker v-model="filters.endDate" type="date" placeholder="结束日期" value-format="YYYY-MM-DD" class="w-140" />
        </div>
        <el-button type="primary" :icon="Search" @click="doSearch">搜索</el-button>
        <el-button :icon="Refresh" @click="doReset">重置</el-button>
      </div>
    </div>

    <!-- 表格（时间倒序，仅查看） -->
    <div class="card table-card">
      <div v-if="firstLoading" class="skeleton">
        <div v-for="i in 5" :key="i" class="sk row-sk"><span style="width: 60%"></span><span style="width: 30%"></span></div>
      </div>
      <template v-else-if="rows.length === 0">
        <EmptyState main="暂无日志记录" sub="系统关键操作将自动记录于此" />
      </template>
      <template v-else>
        <div class="table-wrap">
          <el-table :data="rows" v-loading="tableLoading" stripe :header-cell-style="{ background: '#F8FAFC' }">
            <el-table-column type="expand">
              <template #default="{ row }">
                <div class="expand-body">
                  <pre class="detail-json">{{ prettyDetail(row.detail) }}</pre>
                  <p class="ua">User-Agent：{{ row.userAgent || '—' }}</p>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="时间" width="170">
              <template #default="{ row }"><span class="time">{{ fmtTime(row.createdAt, true) }}</span></template>
            </el-table-column>
            <el-table-column label="操作人" width="130">
              <template #default="{ row }"><span class="mono">{{ row.username }}</span></template>
            </el-table-column>
            <el-table-column label="动作" width="110">
              <template #default="{ row }">
                <span class="tag" :style="actionStyle(row.action)">{{ AUDIT_ACTION_MAP[row.action]?.label || row.action }}</span>
              </template>
            </el-table-column>
            <el-table-column label="模块" width="100">
              <template #default="{ row }">{{ AUDIT_MODULE_MAP[row.module] || row.module }}</template>
            </el-table-column>
            <el-table-column label="目标对象" width="170" show-overflow-tooltip>
              <template #default="{ row }"><span class="mono">{{ row.target || '—' }}</span></template>
            </el-table-column>
            <el-table-column label="详情" width="80">
              <template #default="{ row }">
                <span class="detail-link">{{ row.detail ? '查看' : '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="IP" width="140">
              <template #default="{ row }"><span class="mono ip">{{ row.ip || '—' }}</span></template>
            </el-table-column>
          </el-table>
        </div>
        <div class="pager">
          <el-pagination
            v-model:current-page="page" v-model:page-size="pageSize" :total="total"
            :page-sizes="[10, 20, 50, 100]" layout="total, prev, pager, next, sizes" background
            @current-change="loadList" @size-change="doSearch"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.page-head { margin-bottom: 16px; }
.page-title { margin: 0; font-size: 20px; font-weight: 600; color: var(--neutral-800); }
.filter-card { padding: 16px 20px; margin-bottom: 16px; }
.filter-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.w-160 { width: 160px; }
.w-140 { width: 140px; }
.date-pair { display: flex; align-items: center; gap: 8px; }
.sep { color: var(--neutral-400); font-size: 13px; }
.table-card { padding: 0; overflow: hidden; }
.table-wrap { overflow-x: auto; }
.pager { display: flex; justify-content: flex-end; padding: 16px 20px; }
.time { font-size: 13px; color: var(--neutral-500); }
.tag { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 500; }
.ip { color: var(--neutral-500); }
.detail-link { font-size: 13px; color: var(--brand-500); cursor: pointer; }
.expand-body { background: var(--neutral-25); padding: 16px 24px; }
.detail-json {
  margin: 0; font-family: var(--font-mono); font-size: 13px; color: var(--neutral-800);
  white-space: pre-wrap; word-break: break-all;
}
.ua { margin: 8px 0 0; font-size: 12px; color: var(--neutral-400); word-break: break-all; }
.sk { background: var(--neutral-100); border-radius: 4px; }
.skeleton { padding: 12px 20px 20px; }
.row-sk { display: flex; justify-content: space-between; height: 14px; margin: 18px 0; }
.row-sk span { background: var(--neutral-100); border-radius: 3px; height: 14px; display: block; }
</style>
