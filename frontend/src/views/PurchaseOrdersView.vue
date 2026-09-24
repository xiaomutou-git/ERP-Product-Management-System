<script setup lang="ts">
/**
 * 采购管理列表页（组件级注释）
 * ------------------------------------------------------------------
 * 核心功能：筛选（关键词/状态/日期区间）、分页列表、详情抽屉（步骤条 +
 *          单据信息 + 明细表 + 按状态与角色渲染的操作按钮：提交/入库确认/
 *          取消/编辑/删除）；取消需填写原因；抽屉宽度响应式（≥768px 720px、
 *          小屏 100% 且步骤条/字段折叠）。
 * 设计思路：状态 Tag 颜色全站唯一映射（UI-DESIGN 4.5）；入库确认走
 *          Primary 确认弹窗；draft 才显示编辑/删除；received/cancelled
 *          显示终态说明；重复入库等业务错误由拦截器提示后端文案。
 * 适用场景：/purchase-orders 路由。
 * 创建时间：2026-09-21
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search, Refresh, Plus, Loading } from '@element-plus/icons-vue';
import EmptyState from '@/components/EmptyState.vue';
import { listPurchaseOrders, getPurchaseOrder, submitPurchaseOrder, receivePurchaseOrder, cancelPurchaseOrder, deletePurchaseOrder } from '@/api';
import { can, fen2yuan, fmtTime, ORDER_STATUS_MAP } from '@/utils/format';
import { useAuthStore } from '@/stores/auth';
import type { PurchaseOrderDetail, PurchaseOrderRow } from '@/types/api';

const router = useRouter();
const auth = useAuthStore();
const canPurchaseWrite = computed(() => can(auth.user?.role, 'purchase:write'));
const canReceive = computed(() => can(auth.user?.role, 'purchase:receive'));

/** 筛选 */
const filters = reactive({ keyword: '', status: undefined as PurchaseOrderRow['status'] | undefined, startDate: '', endDate: '' });
/** 列表数据 */
const rows = ref<PurchaseOrderRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const tableLoading = ref(false);
const firstLoading = ref(true);

/** 详情抽屉 */
const drawerVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<PurchaseOrderDetail | null>(null);
/** 取消原因弹窗 */
const cancelDialogVisible = ref(false);
const cancelReason = ref('');
const cancelSubmitting = ref(false);

/** 当前窗口宽度（px），用于抽屉响应式尺寸 */
const winWidth = ref(window.innerWidth);

/**
 * 窗口尺寸变化：同步宽度驱动抽屉响应式
 * @returns void
 * @throws 无（DOM/窗口读取异常时静默忽略，避免页面崩溃）
 */
function onWinResize(): void {
  try {
    winWidth.value = window.innerWidth;
  } catch {
    // 窗口对象异常时保持旧值
  }
}

/** 抽屉尺寸：≥768px 用 720px；小屏（含 375px 手机）用 100% 宽，避免横向截断 */
const drawerSize = computed(() => (winWidth.value >= 768 ? '720px' : '100%'));

/**
 * 加载采购单列表
 * @returns Promise，失败清空列表
 */
async function loadList(): Promise<void> {
  tableLoading.value = true;
  try {
    const data = await listPurchaseOrders({
      page: page.value,
      pageSize: pageSize.value,
      keyword: filters.keyword || undefined,
      status: filters.status,
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
  filters.keyword = '';
  filters.status = undefined;
  filters.startDate = '';
  filters.endDate = '';
  doSearch();
}

/**
 * 打开详情抽屉并加载数据
 * @param id 采购单 id
 * @returns Promise
 */
async function openDetail(id: number): Promise<void> {
  drawerVisible.value = true;
  detailLoading.value = true;
  try {
    detail.value = await getPurchaseOrder(id);
  } catch {
    detail.value = null;
  } finally {
    detailLoading.value = false;
  }
}

/**
 * 提交采购单（draft → submitted）
 * @returns Promise，成功后刷新列表与详情
 */
async function doSubmit(): Promise<void> {
  if (!detail.value) return;
  try {
    await ElMessageBox.confirm('提交后明细将锁定，不可修改，确认提交？', '提交采购单', {
      type: 'info', confirmButtonText: '确认提交', cancelButtonText: '取消',
    });
  } catch { return; }
  try {
    await submitPurchaseOrder(detail.value.id);
    ElMessage.success('提交成功');
    await openDetail(detail.value.id);
    loadList();
  } catch {
    // 错误由拦截器提示
  }
}

/**
 * 入库确认（submitted → received，事务内加库存）
 * @returns Promise
 */
async function doReceive(): Promise<void> {
  if (!detail.value) return;
  try {
    await ElMessageBox.confirm('入库将按明细增加库存并生成流水，且不可回退，确认入库？', '入库确认', {
      type: 'info', confirmButtonText: '确认入库', cancelButtonText: '取消',
    });
  } catch { return; }
  try {
    await receivePurchaseOrder(detail.value.id);
    ElMessage.success('入库成功，库存已更新');
    await openDetail(detail.value.id);
    loadList();
  } catch {
    // 重复入库 400"单据状态已变更"由拦截器提示
  }
}

/**
 * 打开取消原因弹窗
 * @returns void
 */
function openCancel(): void {
  cancelReason.value = '';
  cancelDialogVisible.value = true;
}

/**
 * 确认取消采购单
 * @returns Promise
 */
async function doCancel(): Promise<void> {
  if (!detail.value) return;
  if (!cancelReason.value.trim()) {
    ElMessage.warning('请填写取消原因');
    return;
  }
  cancelSubmitting.value = true;
  try {
    await cancelPurchaseOrder(detail.value.id, cancelReason.value.trim());
    ElMessage.success('已取消');
    cancelDialogVisible.value = false;
    await openDetail(detail.value.id);
    loadList();
  } catch {
    // 错误由拦截器提示
  } finally {
    cancelSubmitting.value = false;
  }
}

/**
 * 删除草稿采购单
 * @returns Promise
 */
async function doDelete(): Promise<void> {
  if (!detail.value) return;
  try {
    await ElMessageBox.confirm('确认删除该草稿采购单？删除后不可恢复。', '删除采购单', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
    });
  } catch { return; }
  try {
    await deletePurchaseOrder(detail.value.id);
    ElMessage.success('删除成功');
    drawerVisible.value = false;
    loadList();
  } catch {
    // 错误由拦截器提示
  }
}

/**
 * 详情内编辑入口
 * @returns void
 */
function goEdit(): void {
  if (!detail.value) return;
  drawerVisible.value = false;
  router.push(`/purchase-orders/edit/${detail.value.id}`);
}

/** 步骤条当前步（0 草稿/1 已提交/2 已入库；取消为 -1 置灰） */
const stepIndex = computed(() => {
  if (!detail.value) return 0;
  if (detail.value.status === 'received') return 2;
  if (detail.value.status === 'submitted') return 1;
  if (detail.value.status === 'draft') return 0;
  return -1;
});

onMounted(() => {
  // 监听窗口变化实现抽屉响应式（异常静默，避免阻断列表加载）
  try {
    window.addEventListener('resize', onWinResize);
  } catch {
    // 环境不支持时退化为初始宽度判断
  }
  loadList();
});
onBeforeUnmount(() => {
  try {
    window.removeEventListener('resize', onWinResize);
  } catch {
    // 忽略注销异常
  }
});
</script>

<template>
  <div class="po-page">
    <div class="page-head">
      <h2 class="page-title">采购管理</h2>
    </div>

    <!-- 筛选区 -->
    <div class="card filter-card">
      <div class="filter-row">
        <el-input v-model="filters.keyword" class="w-240" placeholder="单号 / 供应商名称" clearable :prefix-icon="Search" @keyup.enter="doSearch" @clear="doSearch" />
        <el-select v-model="filters.status" class="w-140" placeholder="全部状态" clearable>
          <el-option v-for="(v, k) in ORDER_STATUS_MAP" :key="k" :label="v.label" :value="k" />
        </el-select>
        <div class="date-pair">
          <el-date-picker v-model="filters.startDate" type="date" placeholder="开始日期" value-format="YYYY-MM-DD" class="w-140" />
          <span class="sep">至</span>
          <el-date-picker v-model="filters.endDate" type="date" placeholder="结束日期" value-format="YYYY-MM-DD" class="w-140" />
        </div>
        <el-button type="primary" :icon="Search" @click="doSearch">搜索</el-button>
        <el-button :icon="Refresh" @click="doReset">重置</el-button>
        <el-button v-if="canPurchaseWrite" type="primary" class="push-right" :icon="Plus" @click="router.push('/purchase-orders/create')">新建采购单</el-button>
      </div>
    </div>

    <!-- 列表 -->
    <div class="card table-card">
      <div v-if="firstLoading" class="skeleton">
        <div v-for="i in 5" :key="i" class="sk row-sk"><span style="width: 60%"></span><span style="width: 30%"></span></div>
      </div>
      <template v-else-if="rows.length === 0">
        <EmptyState main="暂无采购单" sub="试试更换关键词或清空筛选，或新建一张采购单" />
      </template>
      <template v-else>
        <div class="table-wrap">
          <el-table :data="rows" v-loading="tableLoading" stripe :header-cell-style="{ background: '#F8FAFC' }">
            <el-table-column label="单号" width="170" fixed="left">
              <template #default="{ row }">
                <el-button text type="primary" size="small" class="mono" @click="openDetail(row.id)">{{ row.orderNo }}</el-button>
              </template>
            </el-table-column>
            <el-table-column prop="supplierName" label="供应商" min-width="180" show-overflow-tooltip />
            <el-table-column label="总金额(元)" width="130" align="right">
              <template #default="{ row }"><span class="num strong">{{ fen2yuan(row.totalAmount) }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <span class="tag" :style="{ color: ORDER_STATUS_MAP[row.status]?.color, background: ORDER_STATUS_MAP[row.status]?.bg }">
                  {{ ORDER_STATUS_MAP[row.status]?.label }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="createdByName" label="创建人" width="110" />
            <el-table-column label="创建时间" width="160">
              <template #default="{ row }"><span class="time">{{ fmtTime(row.createdAt) }}</span></template>
            </el-table-column>
            <el-table-column label="操作" width="160" fixed="right">
              <template #default="{ row }">
                <el-button text type="primary" size="small" @click="openDetail(row.id)">详情</el-button>
                <template v-if="row.status === 'draft' && canPurchaseWrite">
                  <el-button text type="primary" size="small" @click="router.push(`/purchase-orders/edit/${row.id}`)">编辑</el-button>
                </template>
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

    <!-- ============ 详情抽屉（响应式：≥768px 720px，小屏 100%） ============ -->
    <el-drawer v-model="drawerVisible" :size="drawerSize" :with-header="false">
      <div v-if="detailLoading" class="drawer-loading"><el-icon class="spin" :size="32"><Loading /></el-icon><span>加载中…</span></div>
      <template v-else-if="detail">
        <div class="d-head">
          <span class="d-no mono">{{ detail.orderNo }}</span>
          <span class="tag" :style="{ color: ORDER_STATUS_MAP[detail.status]?.color, background: ORDER_STATUS_MAP[detail.status]?.bg }">
            {{ ORDER_STATUS_MAP[detail.status]?.label }}
          </span>
        </div>

        <!-- 步骤条 -->
        <div class="steps">
          <div class="step" :class="{ done: stepIndex >= 0, current: stepIndex === 0, gray: stepIndex === -1 }">
            <span class="s-dot"></span><span class="s-label">草稿</span>
          </div>
          <div class="s-line" :class="{ filled: stepIndex >= 1 && stepIndex !== -1, gray: stepIndex === -1 }"></div>
          <div class="step" :class="{ done: stepIndex >= 1, current: stepIndex === 1, gray: stepIndex === -1 }">
            <span class="s-dot"></span><span class="s-label">已提交</span>
            <span class="s-time">{{ fmtTime(detail.submittedAt) }}</span>
          </div>
          <div class="s-line" :class="{ filled: stepIndex === 2, gray: stepIndex === -1 }"></div>
          <div class="step" :class="{ done: stepIndex === 2, current: stepIndex === 2, gray: stepIndex === -1 }">
            <span class="s-dot"></span><span class="s-label">已入库</span>
            <span class="s-time">{{ fmtTime(detail.receivedAt) }}</span>
          </div>
        </div>
        <p v-if="detail.status === 'cancelled'" class="cancel-info">该采购单已取消{{ detail.cancelReason ? `，原因：${detail.cancelReason}` : '' }}</p>

        <!-- 单据信息 -->
        <div class="d-info">
          <div class="info-item"><span class="k">供应商</span><span class="v">{{ detail.supplierName }}</span></div>
          <div class="info-item"><span class="k">创建人</span><span class="v">{{ detail.createdByName }}</span></div>
          <div class="info-item"><span class="k">创建时间</span><span class="v">{{ fmtTime(detail.createdAt, true) }}</span></div>
          <div class="info-item"><span class="k">入库人</span><span class="v">{{ detail.receivedByName || '—' }}</span></div>
          <div class="info-item full"><span class="k">备注</span><span class="v">{{ detail.remark || '—' }}</span></div>
        </div>

        <!-- 明细表 -->
        <table class="items-table">
          <thead>
            <tr><th>SKU</th><th>商品</th><th class="r">数量</th><th class="r">进价(元)</th><th class="r">小计(元)</th></tr>
          </thead>
          <tbody>
            <tr v-for="it in detail.items" :key="it.id">
              <td class="mono">{{ it.sku }}</td>
              <td>{{ it.productName }}</td>
              <td class="r num">{{ it.quantity }}</td>
              <td class="r num">{{ fen2yuan(it.unitPrice) }}</td>
              <td class="r num">{{ fen2yuan(it.subtotal) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr><td colspan="4" class="r total-label">合计</td><td class="r total num">¥{{ fen2yuan(detail.totalAmount) }}</td></tr>
          </tfoot>
        </table>

        <!-- 操作区（sticky 底部） -->
        <div class="d-actions">
          <template v-if="detail.status === 'draft' && canPurchaseWrite">
            <el-button @click="goEdit">编辑</el-button>
            <el-button type="danger" plain @click="doDelete">删除</el-button>
            <el-button @click="openCancel">取消</el-button>
            <el-button type="primary" @click="doSubmit">提交</el-button>
          </template>
          <template v-else-if="detail.status === 'submitted'">
            <el-button v-if="canPurchaseWrite" @click="openCancel">取消</el-button>
            <el-button v-if="canReceive" type="primary" @click="doReceive">入库确认</el-button>
          </template>
          <span v-else class="terminal-tip">该单据已处于终态，不可变更</span>
        </div>
      </template>
    </el-drawer>

    <!-- 取消原因弹窗 -->
    <el-dialog v-model="cancelDialogVisible" title="取消采购单" width="480px" :close-on-click-modal="false">
      <el-input v-model="cancelReason" type="textarea" :rows="3" maxlength="200" show-word-limit placeholder="请填写取消原因（必填，1~200 字）" />
      <template #footer>
        <el-button @click="cancelDialogVisible = false">取消</el-button>
        <el-button type="danger" :loading="cancelSubmitting" @click="doCancel">确认取消</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-head { margin-bottom: 16px; }
.page-title { margin: 0; font-size: 20px; font-weight: 600; color: var(--neutral-800); }
.filter-card { padding: 16px 20px; margin-bottom: 16px; }
.filter-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.w-240 { width: 240px; }
.w-140 { width: 140px; }
.date-pair { display: flex; align-items: center; gap: 8px; }
.sep { color: var(--neutral-400); font-size: 13px; }
.push-right { margin-left: auto; }
.table-card { padding: 0; overflow: hidden; }
.table-wrap { overflow-x: auto; }
.pager { display: flex; justify-content: flex-end; padding: 16px 20px; }
.time { font-size: 13px; color: var(--neutral-500); }
.strong { font-weight: 500; }
.tag { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 500; }
.sk { background: var(--neutral-100); border-radius: 4px; }
.skeleton { padding: 12px 20px 20px; }
.row-sk { display: flex; justify-content: space-between; height: 14px; margin: 18px 0; }
.row-sk span { background: var(--neutral-100); border-radius: 3px; height: 14px; display: block; }

/* 抽屉 */
.drawer-loading { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 120px 0; color: var(--neutral-500); font-size: 13px; }
.spin { animation: rot 1s linear infinite; color: var(--brand-500); }
@keyframes rot { to { transform: rotate(360deg); } }

.d-head { display: flex; align-items: center; gap: 12px; padding-bottom: 16px; border-bottom: 1px solid var(--neutral-100); }
.d-no { font-size: 16px; font-weight: 600; color: var(--neutral-800); }

.steps { display: flex; align-items: flex-start; padding: 20px 8px 8px; }
.step { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 64px; }
.s-dot { width: 10px; height: 10px; border-radius: 999px; background: var(--neutral-300); }
.step.done .s-dot { background: var(--brand-500); }
.step.current .s-dot { width: 12px; height: 12px; box-shadow: 0 0 0 4px rgba(6, 182, 212, 0.2); }
.steps.gray .s-dot { background: var(--neutral-300) !important; }
.s-label { font-size: 13px; color: var(--neutral-600); }
.step.done .s-label { color: var(--brand-700); font-weight: 500; }
.s-time { font-size: 12px; color: var(--neutral-400); }
.s-line { flex: 1; height: 2px; background: var(--neutral-100); margin-top: 5px; }
.s-line.filled { background: var(--brand-500); }

.cancel-info { margin: 8px 0 0; font-size: 13px; color: var(--danger-text); }

.d-info { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; padding: 16px 0; }
.info-item { display: flex; gap: 12px; }
.info-item.full { grid-column: 1 / -1; }
.info-item .k { font-size: 13px; color: var(--neutral-500); flex-shrink: 0; width: 60px; }
.info-item .v { font-size: 14px; color: var(--neutral-800); }

.items-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.items-table th { background: var(--neutral-25); color: var(--neutral-600); font-size: 13px; font-weight: 500; text-align: left; padding: 10px 12px; }
.items-table td { border-top: 1px solid var(--neutral-100); padding: 12px; color: var(--neutral-800); }
.items-table .r { text-align: right; }
.total-label { color: var(--neutral-600); font-weight: 500; }
.total { color: var(--brand-700); font-weight: 600; font-size: 16px; }

.d-actions {
  position: sticky; bottom: 0; background: #fff; border-top: 1px solid var(--neutral-100);
  padding: 12px 0 4px; margin-top: 16px; display: flex; justify-content: flex-end; gap: 4px;
}
.terminal-tip { font-size: 13px; color: var(--neutral-400); align-self: center; }

/* 窄屏（<768px，含 375px 手机）：抽屉 100% 宽下的折叠布局 */
@media (max-width: 767px) {
  .d-head { flex-wrap: wrap; row-gap: 8px; }
  .d-no { font-size: 15px; word-break: break-all; }
  .steps { padding: 16px 0 4px; }
  .step { min-width: 44px; }
  .s-label { font-size: 12px; }
  .s-time { display: none; } /* 折叠步骤时间戳，避免挤压换行 */
  .d-info { grid-template-columns: 1fr; gap: 10px; } /* 字段单列排布 */
  .items-table th:nth-child(2), .items-table td:nth-child(2) { display: none; } /* 收起商品名列，仅留 SKU */
  .d-actions { flex-wrap: wrap; gap: 8px; }
  .d-actions .el-button { flex: 1 1 40%; margin-left: 0; } /* 按钮两列铺满，便于点按 */
  .terminal-tip { align-self: auto; }
}
</style>
