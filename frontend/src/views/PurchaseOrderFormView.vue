<script setup lang="ts">
/**
 * 采购单新建/编辑页（组件级注释）
 * ------------------------------------------------------------------
 * 核心功能：单据信息卡（供应商远程搜索下拉——仅合作中；备注）+ 明细卡
 *          （商品远程搜索选择器、数量/进价输入、实时小计与合计）+
 *          底部操作条（保存草稿 / 直接提交）。
 * 设计思路：编辑模式仅草稿可进入（非草稿后端 400 由拦截器提示并回退列表）；
 *          编辑草稿时原供应商即使已停用也保留显示并标注"已停用"；
 *          进价输入单位为元，提交时转分；明细实时重算合计（tabular-nums）；
 *          商品选择器远程搜索（排除已删除与已在单内商品）。
 * 适用场景：/purchase-orders/create 与 /purchase-orders/edit/:id 路由。
 * 创建时间：2026-09-21
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete, Plus as PlusIcon } from '@element-plus/icons-vue';
import {
  listSuppliers, listProducts, getPurchaseOrder, createPurchaseOrder, updatePurchaseOrder, submitPurchaseOrder,
} from '@/api';
import { can, fen2yuan, yuan2fen } from '@/utils/format';
import { useAuthStore } from '@/stores/auth';
import type { PurchaseItemForm, ProductRow, PurchaseOrderDetail, SupplierRow } from '@/types/api';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
/** 是否拥有采购写权限（无权限时页面初始化即重定向回采购列表，形成真门禁） */
const canWrite = computed(() => can(auth.user?.role, 'purchase:write'));

/** 编辑模式：路由含 :id 参数 */
const editId = ref<number | null>(route.params.id ? Number(route.params.id) : null);
const isEdit = computed(() => editId.value !== null);

/** 供应商选项（远程搜索结果） */
const suppliers = ref<SupplierRow[]>([]);
/** 已选供应商 id */
const supplierId = ref<number | null>(null);
/** 原供应商信息（编辑草稿时保留显示，即使已停用） */
const originalSupplier = ref<SupplierRow | null>(null);
/** 备注 */
const remark = ref('');
/** 明细行 */
const items = reactive<PurchaseItemForm[]>([]);
/** 商品搜索选项 */
const productOptions = ref<{ value: number; label: string; product: ProductRow }[]>([]);
/** 商品搜索中 */
const productSearching = ref(false);
/** 页面加载中 */
const pageLoading = ref(false);
/** 保存草稿中 */
const savingDraft = ref(false);
/** 提交中 */
const submitting = ref(false);

/** 当前选中的供应商对象（计算属性） */
const selectedSupplier = computed(
  () => originalSupplier.value ?? suppliers.value.find((s) => s.id === supplierId.value) ?? null
);

/** 实时合计（分） */
const totalFen = computed(() =>
  items.reduce((s, it) => s + Math.round(it.quantity * (it.unitPriceYuan || 0) * 100), 0)
);

/**
 * 加载供应商选项（仅合作中）
 * @param keyword 供应商名称关键词，默认空取前 20
 * @returns Promise，失败静默
 */
async function loadSuppliers(keyword = ''): Promise<void> {
  try {
    const data = await listSuppliers({ page: 1, pageSize: 20, keyword: keyword || undefined, status: 1 });
    suppliers.value = data.list;
  } catch {
    suppliers.value = [];
  }
}

/**
 * 供应商远程搜索（el-select remote-method 回调）
 * @param query 关键词
 * @returns void
 */
function remoteSuppliers(query: string): void {
  loadSuppliers(query);
}

/**
 * 商品远程搜索（el-select remote-method 回调）
 * @param query 关键词
 * @returns Promise
 */
async function remoteProducts(query: string): Promise<void> {
  productSearching.value = true;
  try {
    const data = await listProducts({ page: 1, pageSize: 20, keyword: query || undefined });
    const inOrder = new Set(items.map((it) => it.productId));
    productOptions.value = data.list
      .filter((p) => !inOrder.has(p.id))
      .map((p) => ({ value: p.id, label: `${p.sku} · ${p.name}`, product: p }));
  } catch {
    productOptions.value = [];
  } finally {
    productSearching.value = false;
  }
}

/**
 * 商品选中：追加明细行并清空选择器
 * @param pid 选中商品 id
 * @returns void
 */
function onProductPicked(pid: number | null): void {
  if (!pid) return;
  const opt = productOptions.value.find((o) => o.value === pid);
  if (!opt) return;
  items.push({
    productId: opt.product.id,
    productName: opt.product.name,
    sku: opt.product.sku,
    unit: opt.product.unit,
    quantity: 1,
    unitPriceYuan: opt.product.salePrice ? opt.product.salePrice / 100 : 0,
  });
  productOptions.value = productOptions.value.filter((o) => o.value !== pid);
}

/**
 * 删除明细行
 * @param index 行下标
 * @returns void
 */
function removeItem(index: number): void {
  items.splice(index, 1);
}

/**
 * 表单整体校验
 * @returns true 通过；false 失败（已提示具体原因）
 */
function validateForm(): boolean {
  if (supplierId.value === null) {
    ElMessage.warning('请选择供应商');
    return false;
  }
  if (items.length === 0) {
    ElMessage.warning('请至少添加一条采购明细');
    return false;
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.quantity || it.quantity < 1) {
      ElMessage.warning(`第 ${i + 1} 行数量至少为 1`);
      return false;
    }
    const fen = yuan2fen(it.unitPriceYuan);
    if (fen === null || fen <= 0) {
      ElMessage.warning(`第 ${i + 1} 行进价必须大于 0`);
      return false;
    }
  }
  return true;
}

/**
 * 组装提交负载
 * @returns 提交数据（unitPrice 为分）
 */
function buildPayload() {
  return {
    supplierId: supplierId.value!,
    remark: remark.value || null,
    items: items.map((it) => ({ productId: it.productId!, quantity: it.quantity, unitPrice: yuan2fen(it.unitPriceYuan)! })),
  };
}

/**
 * 保存草稿（新建或编辑），可选提交
 * @param andSubmit 保存后是否直接提交
 * @returns Promise，成功后返回列表页；失败由拦截器提示
 */
async function saveDraft(andSubmit: boolean): Promise<void> {
  if (!validateForm()) return;
  const flag = andSubmit ? submitting : savingDraft;
  flag.value = true;
  try {
    const payload = buildPayload();
    if (isEdit.value) {
      await updatePurchaseOrder(editId.value!, payload);
      if (andSubmit) await submitPurchaseOrder(editId.value!);
    } else {
      const created = await createPurchaseOrder(payload);
      if (andSubmit) await submitPurchaseOrder(created.id);
    }
    ElMessage.success(andSubmit ? '采购单已提交' : '草稿已保存');
    router.push('/purchase-orders');
  } catch {
    // 错误由拦截器提示
  } finally {
    flag.value = false;
  }
}

/**
 * 提交前确认弹窗
 * @returns Promise
 */
async function confirmSubmit(): Promise<void> {
  try {
    await ElMessageBox.confirm('提交后明细将锁定，不可修改，确认提交？', '提交采购单', {
      type: 'info', confirmButtonText: '确认提交', cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  saveDraft(true);
}

/** 初始化：真权限门禁 → 加载供应商；编辑模式回填草稿数据 */
onMounted(async () => {
  // 真权限拦截：无采购写权限直接重定向回列表（与路由守卫双保险）
  if (!canWrite.value) {
    ElMessage.warning('您没有创建/编辑采购单的权限');
    router.replace('/purchase-orders');
    return;
  }
  pageLoading.value = true;
  try {
    await loadSuppliers('');
    if (isEdit.value) {
      const detail: PurchaseOrderDetail = await getPurchaseOrder(editId.value!);
      if (detail.status !== 'draft') {
        ElMessage.warning('已提交的采购单不可编辑');
        router.replace('/purchase-orders');
        return;
      }
      supplierId.value = detail.supplierId;
      originalSupplier.value = {
        id: detail.supplierId, name: detail.supplierName, contactPerson: null, phone: null,
        email: null, address: null, status: detail.supplierStatus, remark: null, createdAt: detail.createdAt,
      };
      remark.value = detail.remark ?? '';
      items.splice(
        0,
        items.length,
        ...detail.items.map((it) => ({
          productId: it.productId, productName: it.productName, sku: it.sku, unit: it.unit,
          quantity: it.quantity, unitPriceYuan: it.unitPrice / 100,
        }))
      );
    }
  } catch {
    // 错误由拦截器提示
  } finally {
    pageLoading.value = false;
  }
});
</script>

<template>
  <div class="po-form">
    <div class="page-head">
      <div class="head-left">
        <el-button text @click="router.push('/purchase-orders')">返回</el-button>
        <h2 class="page-title">{{ isEdit ? '编辑采购单' : '新建采购单' }}</h2>
      </div>
    </div>

    <div v-loading="pageLoading">
      <!-- 单据信息卡 -->
      <div class="card block">
        <p class="block-title">单据信息</p>
        <div class="form-grid">
          <div class="field">
            <span class="f-label req">供应商</span>
            <div class="f-body">
              <!-- 原供应商已停用时保留展示并标注 -->
              <template v-if="selectedSupplier && selectedSupplier.status !== 1">
                <span class="f-text">{{ selectedSupplier.name }}</span>
                <span class="tag disabled-tag">已停用</span>
              </template>
              <el-select
                v-else
                v-model="supplierId"
                filterable remote clearable
                :remote-method="remoteSuppliers"
                placeholder="输入名称搜索（仅合作中供应商）"
                class="w-320"
              >
                <el-option v-for="s in suppliers" :key="s.id" :label="s.name" :value="s.id" />
              </el-select>
            </div>
          </div>
          <div class="field">
            <span class="f-label">备注</span>
            <el-input v-model="remark" type="textarea" :rows="2" maxlength="200" show-word-limit class="w-480" placeholder="选填" />
          </div>
        </div>
      </div>

      <!-- 明细卡 -->
      <div class="card block">
        <p class="block-title">采购明细</p>
        <el-select
          filterable remote clearable
          :remote-method="remoteProducts"
          :loading="productSearching"
          :model-value="null as unknown as number | null"
          placeholder="搜索商品（名称 / SKU）后自动添加"
          class="w-360"
          @change="onProductPicked"
        >
          <el-option v-for="opt in productOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>

        <table class="items-table">
          <thead>
            <tr>
              <th style="width: 170px">SKU</th>
              <th>商品</th>
              <th style="width: 150px">数量</th>
              <th style="width: 170px">进价(元)</th>
              <th style="width: 120px" class="r">小计(元)</th>
              <th style="width: 64px"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, idx) in items" :key="`${it.productId}-${idx}`">
              <td class="mono">{{ it.sku }}</td>
              <td>{{ it.productName }}</td>
              <td>
                <el-input-number v-model="it.quantity" :min="1" :max="999999" :step="1" controls-position="right" class="w-120" />
              </td>
              <td>
                <el-input-number v-model="it.unitPriceYuan" :min="0" :precision="2" :step="1" controls-position="right" class="w-140" />
              </td>
              <td class="r num">{{ (it.quantity * (it.unitPriceYuan || 0)).toFixed(2) }}</td>
              <td class="r">
                <el-button text type="danger" :icon="Delete" aria-label="删除该行明细" @click="removeItem(idx)" />
              </td>
            </tr>
            <tr v-if="items.length === 0">
              <td colspan="6">
                <div class="add-row" @click="ElMessage.warning('请使用上方商品选择器搜索并添加商品')">
                  <el-icon><PlusIcon /></el-icon><span>添加商品</span>
                </div>
              </td>
            </tr>
          </tbody>
          <tfoot v-if="items.length > 0">
            <tr>
              <td colspan="4" class="r total-label">合计</td>
              <td class="r total num">¥{{ fen2yuan(totalFen) }}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <!-- 底部操作条（无采购写权限不渲染） -->
      <div v-if="canWrite" class="card actions">
        <el-button @click="router.push('/purchase-orders')">取消</el-button>
        <el-button :loading="savingDraft" @click="saveDraft(false)">保存草稿</el-button>
        <el-button type="primary" :loading="submitting" @click="confirmSubmit">提交采购单</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-head { margin-bottom: 16px; }
.head-left { display: flex; align-items: center; gap: 8px; }
.page-title { margin: 0; font-size: 20px; font-weight: 600; color: var(--neutral-800); }

.block { margin-bottom: 16px; }
.block-title { margin: 0 0 16px; font-size: 16px; font-weight: 600; color: var(--neutral-800); }
.form-grid { display: flex; flex-direction: column; gap: 16px; }
.field { display: flex; align-items: flex-start; }
.f-label { width: 96px; text-align: right; padding-right: 12px; font-size: 14px; color: var(--neutral-600); line-height: 32px; flex-shrink: 0; }
.f-label.req::before { content: '*'; color: var(--danger-500); margin-right: 2px; }
.f-body { display: flex; align-items: center; gap: 8px; }
.f-text { font-size: 14px; color: var(--neutral-800); }
.w-320 { width: 320px; max-width: 100%; }
.w-480 { width: 480px; max-width: 100%; }
.w-360 { width: 360px; max-width: 100%; margin-bottom: 16px; }
.w-120 { width: 120px; }
.w-140 { width: 140px; }
.disabled-tag { color: #64748B; background: #F1F5F9; }
.tag { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 500; }

.items-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.items-table th { background: var(--neutral-25); color: var(--neutral-600); font-size: 13px; font-weight: 500; text-align: left; padding: 10px 12px; }
.items-table td { border-top: 1px solid var(--neutral-100); padding: 8px 12px; color: var(--neutral-800); }
.items-table .r { text-align: right; }
.total-label { color: var(--neutral-600); font-weight: 500; }
.total { color: var(--brand-700); font-weight: 600; font-size: 16px; }

.add-row {
  border: 1px dashed var(--neutral-300); border-radius: 8px; height: 40px;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  color: var(--neutral-500); cursor: pointer; font-size: 14px; margin: 8px 0;
}
.add-row:hover { color: var(--brand-600); border-color: var(--brand-500); }

.actions { display: flex; justify-content: flex-end; }
</style>
