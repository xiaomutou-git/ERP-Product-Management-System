<script setup lang="ts">
/**
 * 库存管理页（组件级注释）
 * ------------------------------------------------------------------
 * 核心功能：页签一实时库存——关键词/分类/仅看低库存筛选（支持 URL 参数
 *          ?lowStock=1 直达）、低库存行琥珀高亮、调整库存弹窗（入库/出库、
 *          原因必填、出库超量行内"库存不足"）、设阈值弹窗；
 *          页签二库存流水——只读分页表（时间倒序、类型筛选、日期区间），
 *          无任何编辑删除入口。
 * 设计思路：写按钮按权限显隐（can('inventory:write')）；调整出库失败时
 *          行内错误提示由弹窗内文案与后端 400 message 组合实现。
 * 适用场景：/inventory 路由；看板低库存卡跳转依赖 URL 参数。
 * 创建时间：2026-09-21
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Search, Refresh } from '@element-plus/icons-vue';
import EmptyState from '@/components/EmptyState.vue';
import { listInventory, updateThreshold, adjustInventory, listInventoryLogs, listProducts, listCategories } from '@/api';
import { can, fmtTime, LOG_TYPE_MAP } from '@/utils/format';
import { useAuthStore } from '@/stores/auth';
import type { CategoryNode, InventoryLogRow, InventoryRow, ProductRow } from '@/types/api';

const route = useRoute();
const auth = useAuthStore();
const canWrite = computed(() => can(auth.user?.role, 'inventory:write'));

/** 当前页签 */
const activeTab = ref<'stock' | 'logs'>('stock');

/* ==================== 页签一：实时库存 ==================== */
const filters = reactive({ keyword: '', categoryId: undefined as number | undefined, lowStock: route.query.lowStock === '1' });
const rows = ref<InventoryRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const tableLoading = ref(false);
const firstLoading = ref(true);
const categories = ref<CategoryNode[]>([]);

/** 调整库存弹窗 */
const adjustVisible = ref(false);
const adjustForm = reactive({ productId: 0, sku: '', productName: '', currentQty: 0, type: 'manual_in' as 'manual_in' | 'manual_out', quantity: 1, reason: '' });
const adjustError = ref('');
const adjustSubmitting = ref(false);

/** 设阈值弹窗 */
const thresholdVisible = ref(false);
const thresholdForm = reactive({ productId: 0, sku: '', value: 10 });
const thresholdSubmitting = ref(false);

/**
 * 加载库存列表
 * @returns Promise，失败清空列表
 */
async function loadList(): Promise<void> {
  tableLoading.value = true;
  try {
    const data = await listInventory({
      page: page.value,
      pageSize: pageSize.value,
      keyword: filters.keyword || undefined,
      categoryId: filters.categoryId,
      lowStock: filters.lowStock ? 'true' : undefined,
    });
    rows.value = data.list;
    total.value = data.total;
    // 同步看板低库存角标
    if (filters.lowStock) auth.lowStockCount = data.total;
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
  filters.keyword = '';
  filters.categoryId = undefined;
  filters.lowStock = false;
  doSearch();
}

/**
 * 加载分类选项
 * @returns Promise
 */
async function loadCategories(): Promise<void> {
  try {
    categories.value = await listCategories();
  } catch {
    categories.value = [];
  }
}

/**
 * 打开调整库存弹窗
 * @param row 当前行
 * @returns void
 */
function openAdjust(row: InventoryRow): void {
  Object.assign(adjustForm, {
    productId: row.productId, sku: row.sku, productName: row.productName,
    currentQty: row.quantity, type: 'manual_in', quantity: 1, reason: '',
  });
  adjustError.value = '';
  adjustVisible.value = true;
}

/**
 * 打开设阈值弹窗
 * @param row 当前行
 * @returns void
 */
function openThreshold(row: InventoryRow): void {
  Object.assign(thresholdForm, { productId: row.productId, sku: row.sku, value: row.warnThreshold });
  thresholdVisible.value = true;
}

/**
 * 提交库存调整
 * 执行逻辑：出库时前端预检数量 <= 当前库存；事务调整由后端完成；
 *          后端 400"库存不足"时弹窗行内展示。
 * @returns Promise
 */
async function submitAdjust(): Promise<void> {
  if (!adjustForm.reason.trim()) {
    adjustError.value = '请填写调整原因';
    return;
  }
  if (adjustForm.type === 'manual_out' && adjustForm.quantity > adjustForm.currentQty) {
    adjustError.value = '库存不足';
    return;
  }
  adjustSubmitting.value = true;
  try {
    await adjustInventory(adjustForm.productId, adjustForm.type, adjustForm.quantity, adjustForm.reason.trim());
    ElMessage.success('调整成功');
    adjustVisible.value = false;
    loadList();
  } catch (err) {
    adjustError.value = err instanceof Error && err.message === '库存不足' ? '库存不足' : '';
  } finally {
    adjustSubmitting.value = false;
  }
}

/**
 * 提交阈值修改
 * @returns Promise
 */
async function submitThreshold(): Promise<void> {
  thresholdSubmitting.value = true;
  try {
    await updateThreshold(thresholdForm.productId, thresholdForm.value);
    ElMessage.success('预警阈值已更新');
    thresholdVisible.value = false;
    loadList();
  } catch {
    // 错误由拦截器提示
  } finally {
    thresholdSubmitting.value = false;
  }
}

/* ==================== 页签二：库存流水 ==================== */
const logFilters = reactive({ productId: undefined as number | undefined, type: undefined as InventoryLogRow['type'] | undefined, startDate: '', endDate: '' });
const logRows = ref<InventoryLogRow[]>([]);
const logTotal = ref(0);
const logPage = ref(1);
const logPageSize = ref(20);
const logLoading = ref(false);
/** 流水商品搜索选项 */
const productOpts = ref<ProductRow[]>([]);

/**
 * 加载流水列表
 * @returns Promise
 */
async function loadLogs(): Promise<void> {
  logLoading.value = true;
  try {
    const data = await listInventoryLogs({
      page: logPage.value,
      pageSize: logPageSize.value,
      productId: logFilters.productId,
      type: logFilters.type,
      startDate: logFilters.startDate || undefined,
      endDate: logFilters.endDate || undefined,
    });
    logRows.value = data.list;
    logTotal.value = data.total;
  } catch {
    logRows.value = [];
  } finally {
    logLoading.value = false;
  }
}

/** 流水搜索 */
function doLogSearch(): void {
  logPage.value = 1;
  loadLogs();
}

/** 流水重置 */
function doLogReset(): void {
  logFilters.productId = undefined;
  logFilters.type = undefined;
  logFilters.startDate = '';
  logFilters.endDate = '';
  doLogSearch();
}

/**
 * 流水商品远程搜索
 * @param query 关键词
 * @returns Promise
 */
async function searchLogProducts(query: string): Promise<void> {
  try {
    const data = await listProducts({ page: 1, pageSize: 20, keyword: query || undefined });
    productOpts.value = data.list;
  } catch {
    productOpts.value = [];
  }
}

/**
 * 低库存行样式类（表格 row-class-name）
 * @param param 含 row 的参数对象
 * @returns 低库存行返回 row-low 类名
 */
function lowRowClass(param: { row: InventoryRow }): string {
  return param.row.quantity <= param.row.warnThreshold ? 'row-low' : '';
}

onMounted(() => {
  loadCategories();
  loadList();
  searchLogProducts('');
});
</script>

<template>
  <div class="inv-page">
    <div class="page-head">
      <h2 class="page-title">库存管理</h2>
    </div>
    <div class="tabs">
      <div class="tab-item" :class="{ active: activeTab === 'stock' }" @click="activeTab = 'stock'">实时库存</div>
      <div class="tab-item" :class="{ active: activeTab === 'logs' }" @click="activeTab = 'logs'">库存流水</div>
    </div>

    <!-- ============ 页签一：实时库存 ============ -->
    <template v-if="activeTab === 'stock'">
      <div class="card filter-card">
        <div class="filter-row">
          <el-input v-model="filters.keyword" class="w-240" placeholder="商品名称 / SKU" clearable :prefix-icon="Search" @keyup.enter="doSearch" @clear="doSearch" />
          <el-select v-model="filters.categoryId" class="w-200" placeholder="全部分类" clearable>
            <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
            <template v-for="c in categories" :key="'g' + c.id">
              <el-option v-for="ch in c.children" :key="ch.id" :label="`　${c.name} / ${ch.name}`" :value="ch.id" />
            </template>
          </el-select>
          <div class="low-switch">
            <el-switch v-model="filters.lowStock" active-color="#F59E0B" @change="doSearch" />
            <span>仅看低库存</span>
          </div>
          <el-button type="primary" :icon="Search" @click="doSearch">搜索</el-button>
          <el-button :icon="Refresh" @click="doReset">重置</el-button>
        </div>
      </div>

      <div class="card table-card">
        <div v-if="firstLoading" class="skeleton">
          <div v-for="i in 5" :key="i" class="sk row-sk"><span style="width: 60%"></span><span style="width: 30%"></span></div>
        </div>
        <template v-else-if="rows.length === 0">
          <EmptyState main="暂无库存数据" sub="试试更换关键词或关闭低库存筛选" dot-color="#F59E0B" />
        </template>
        <template v-else>
          <div class="table-wrap">
            <el-table
              :data="rows" v-loading="tableLoading" stripe
              :row-class-name="lowRowClass"
              :header-cell-style="{ background: '#F8FAFC' }"
            >
              <el-table-column prop="sku" label="SKU" width="150">
                <template #default="{ row }"><span class="mono">{{ row.sku }}</span></template>
              </el-table-column>
              <el-table-column prop="productName" label="名称" min-width="200" show-overflow-tooltip />
              <el-table-column label="分类" width="140">
                <template #default="{ row }">{{ row.parentCategoryName ? `${row.parentCategoryName} / ${row.categoryName}` : row.categoryName }}</template>
              </el-table-column>
              <el-table-column label="当前数量" width="150" align="right">
                <template #default="{ row }">
                  <span v-if="row.quantity <= row.warnThreshold" class="low-num">
                    <span class="dot"></span>{{ row.quantity }}
                    <span class="mini-tag">低</span>
                  </span>
                  <span v-else class="num">{{ row.quantity }}</span>
                </template>
              </el-table-column>
              <el-table-column label="预警阈值" width="110" align="right">
                <template #default="{ row }"><span class="num threshold">{{ row.warnThreshold }}</span></template>
              </el-table-column>
              <el-table-column label="最近变动时间" width="160">
                <template #default="{ row }"><span class="time">{{ fmtTime(row.updatedAt) }}</span></template>
              </el-table-column>
              <el-table-column v-if="canWrite" label="操作" width="160" fixed="right">
                <template #default="{ row }">
                  <el-button text type="primary" size="small" @click="openAdjust(row)">调整库存</el-button>
                  <el-button text type="primary" size="small" @click="openThreshold(row)">设阈值</el-button>
                </template>
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
    </template>

    <!-- ============ 页签二：库存流水（只读） ============ -->
    <template v-else>
      <div class="card filter-card">
        <div class="filter-row">
          <el-select v-model="logFilters.productId" class="w-200" filterable remote clearable :remote-method="searchLogProducts" placeholder="商品（名称 / SKU）">
            <el-option v-for="p in productOpts" :key="p.id" :label="`${p.sku} · ${p.name}`" :value="p.id" />
          </el-select>
          <el-select v-model="logFilters.type" class="w-140" placeholder="全部类型" clearable>
            <el-option v-for="(v, k) in LOG_TYPE_MAP" :key="k" :label="v.label" :value="k" />
          </el-select>
          <div class="date-pair">
            <el-date-picker v-model="logFilters.startDate" type="date" placeholder="开始日期" value-format="YYYY-MM-DD" class="w-140" />
            <span class="sep">至</span>
            <el-date-picker v-model="logFilters.endDate" type="date" placeholder="结束日期" value-format="YYYY-MM-DD" class="w-140" />
          </div>
          <el-button type="primary" :icon="Search" @click="doLogSearch">搜索</el-button>
          <el-button :icon="Refresh" @click="doLogReset">重置</el-button>
        </div>
      </div>

      <div class="card table-card">
        <div v-if="logRows.length === 0 && !logLoading">
          <EmptyState main="暂无流水记录" sub="库存变动（采购入库 / 手动调整）将自动生成流水" />
        </div>
        <template v-else>
          <div class="table-wrap">
            <el-table :data="logRows" v-loading="logLoading" stripe :header-cell-style="{ background: '#F8FAFC' }">
              <el-table-column label="时间" width="160">
                <template #default="{ row }"><span class="time">{{ fmtTime(row.createdAt, true) }}</span></template>
              </el-table-column>
              <el-table-column label="商品" min-width="180" show-overflow-tooltip>
                <template #default="{ row }"><span class="mono">{{ row.sku }}</span> {{ row.productName }}</template>
              </el-table-column>
              <el-table-column label="类型" width="110">
                <template #default="{ row }">
                  <span class="tag" :style="{ color: LOG_TYPE_MAP[row.type]?.color, background: LOG_TYPE_MAP[row.type]?.bg }">
                    {{ LOG_TYPE_MAP[row.type]?.label }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="变动" width="90" align="right">
                <template #default="{ row }">
                  <span :class="row.direction === 1 ? 'in-num' : 'out-num'">{{ row.direction === 1 ? '+' : '-' }}{{ row.quantity }}</span>
                </template>
              </el-table-column>
              <el-table-column label="变动前 → 后" width="140" align="right">
                <template #default="{ row }"><span class="num">{{ row.beforeQuantity }} → {{ row.afterQuantity }}</span></template>
              </el-table-column>
              <el-table-column label="关联单号" width="160">
                <template #default="{ row }"><span class="mono">{{ row.refNo || '—' }}</span></template>
              </el-table-column>
              <el-table-column prop="operatorName" label="操作人" width="100" />
              <el-table-column label="原因" min-width="160" show-overflow-tooltip>
                <template #default="{ row }">{{ row.reason || '—' }}</template>
              </el-table-column>
            </el-table>
          </div>
          <div class="pager">
            <el-pagination
              v-model:current-page="logPage" v-model:page-size="logPageSize" :total="logTotal"
              :page-sizes="[10, 20, 50, 100]" layout="total, prev, pager, next, sizes" background
              @current-change="loadLogs" @size-change="doLogSearch"
            />
          </div>
        </template>
      </div>
    </template>

    <!-- ============ 调整库存弹窗 ============ -->
    <el-dialog v-model="adjustVisible" title="调整库存" width="480px" :close-on-click-modal="false">
      <div class="adj-product">
        <span class="mono">{{ adjustForm.sku }}</span>
        <span>{{ adjustForm.productName }}</span>
        <span class="adj-qty">当前库存：<b class="num">{{ adjustForm.currentQty }}</b></span>
      </div>
      <el-form label-width="96px" label-position="left" style="margin-top: 16px">
        <el-form-item label="调整类型" required>
          <el-radio-group v-model="adjustForm.type">
            <el-radio value="manual_in">手动入库</el-radio>
            <el-radio value="manual_out">手动出库</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="数量" required>
          <el-input-number v-model="adjustForm.quantity" :min="1" :max="999999" :step="1" controls-position="right" style="width: 120px" />
        </el-form-item>
        <el-form-item label="调整原因" required :error="adjustError">
          <el-input v-model="adjustForm.reason" type="textarea" :rows="3" maxlength="200" show-word-limit placeholder="如：盘点补录 / 报损出库" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustVisible = false">取消</el-button>
        <el-button type="primary" :loading="adjustSubmitting" @click="submitAdjust">确认调整</el-button>
      </template>
    </el-dialog>

    <!-- ============ 设阈值弹窗 ============ -->
    <el-dialog v-model="thresholdVisible" title="设置预警阈值" width="420px" :close-on-click-modal="false">
      <div class="adj-product">
        <span class="mono">{{ thresholdForm.sku }}</span>
      </div>
      <el-form label-width="96px" label-position="left" style="margin-top: 16px">
        <el-form-item label="预警阈值" required>
          <el-input-number v-model="thresholdForm.value" :min="0" :max="999999" :step="1" controls-position="right" style="width: 140px" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="thresholdVisible = false">取消</el-button>
        <el-button type="primary" :loading="thresholdSubmitting" @click="submitThreshold">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-head { margin-bottom: 12px; }
.page-title { margin: 0; font-size: 20px; font-weight: 600; color: var(--neutral-800); }

.tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--neutral-100); }
.tab-item {
  height: 40px; display: flex; align-items: center; padding: 0 16px; cursor: pointer;
  font-size: 14px; color: var(--neutral-600); position: relative;
}
.tab-item.active { color: var(--brand-700); font-weight: 500; }
.tab-item.active::after {
  content: ''; position: absolute; left: 16px; right: 16px; bottom: -1px; height: 2px; background: var(--brand-500);
}

.filter-card { padding: 16px 20px; margin-bottom: 16px; }
.filter-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.w-240 { width: 240px; }
.w-200 { width: 200px; }
.w-140 { width: 140px; }
.date-pair { display: flex; align-items: center; gap: 8px; }
.sep { color: var(--neutral-400); font-size: 13px; }
.low-switch { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--neutral-600); }

.table-card { padding: 0; overflow: hidden; }
.table-wrap { overflow-x: auto; }
.pager { display: flex; justify-content: flex-end; padding: 16px 20px; }
.time { font-size: 13px; color: var(--neutral-500); }
.threshold { color: var(--neutral-500); }
.low-num { color: var(--warning-text); font-weight: 700; font-variant-numeric: tabular-nums; display: inline-flex; align-items: center; gap: 6px; }
.dot { width: 8px; height: 8px; border-radius: 999px; background: var(--warning-500); display: inline-block; }
.mini-tag { font-size: 12px; font-weight: 500; color: var(--warning-text); background: var(--warning-bg); border-radius: 6px; padding: 0 8px; line-height: 20px; }
.in-num { color: var(--success-text); font-weight: 500; font-variant-numeric: tabular-nums; }
.out-num { color: var(--danger-text); font-weight: 500; font-variant-numeric: tabular-nums; }
.tag { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 500; }
.sk { background: var(--neutral-100); border-radius: 4px; }
.skeleton { padding: 12px 20px 20px; }
.row-sk { display: flex; justify-content: space-between; height: 14px; margin: 18px 0; }
.row-sk span { background: var(--neutral-100); border-radius: 3px; height: 14px; display: block; }

/* 低库存行 hover 琥珀底 */
:deep(.row-low:hover) td { background-color: #FFFBEB !important; }

.adj-product { display: flex; align-items: center; gap: 12px; padding: 12px; background: var(--neutral-25); border-radius: 8px; font-size: 14px; }
.adj-qty { margin-left: auto; color: var(--neutral-500); }
.adj-qty b { color: var(--neutral-800); }
</style>
