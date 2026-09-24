<script setup lang="ts">
/**
 * 商品管理页（组件级注释）
 * ------------------------------------------------------------------
 * 核心功能：页签一商品列表——关键词/分类筛选、分页表格、新增/编辑弹窗
 *          （SKU 失焦预检 + 后端 409 兜底）、删除二次确认；
 *          页签二分类管理——左树右详情、分类增删改（含商品数徽标与删除约束提示）。
 * 设计思路：写操作按钮按权限显隐（can('product:write') / can('category:write')）；
 *          售价输入为元、提交转分；低库存行琥珀高亮；分类删除前前端预检商品数。
 * 适用场景：/products 路由（全部角色可看，按钮按权限渲染）。
 * 创建时间：2026-09-21
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Edit, Delete, Search, Refresh } from '@element-plus/icons-vue';
import EmptyState from '@/components/EmptyState.vue';
import {
  listProducts, createProduct, updateProduct, deleteProduct,
  listCategories, createCategory, updateCategory, deleteCategory,
} from '@/api';
import { can, fen2yuan, fmtTime, yuan2fen } from '@/utils/format';
import { useAuthStore } from '@/stores/auth';
import type { CategoryNode, ProductForm, ProductRow } from '@/types/api';

const auth = useAuthStore();

/** 当前页签 */
const activeTab = ref<'list' | 'category'>('list');
/** 是否有商品写权限 */
const canWrite = computed(() => can(auth.user?.role, 'product:write'));
/** 是否有分类写权限 */
const canCategoryWrite = computed(() => can(auth.user?.role, 'category:write'));

/* ==================== 页签一：商品列表 ==================== */
/** 筛选条件 */
const filters = reactive({ keyword: '', categoryId: undefined as number | undefined });
/** 表格数据 */
const rows = ref<ProductRow[]>([]);
/** 总数 */
const total = ref(0);
/** 分页 */
const page = ref(1);
const pageSize = ref(20);
/** 表格加载中 */
const tableLoading = ref(false);
/** 首次加载（骨架） */
const firstLoading = ref(true);
/** 分类树选项 */
const categories = ref<CategoryNode[]>([]);

/** 编辑弹窗可见性 */
const dialogVisible = ref(false);
/** 弹窗标题 */
const dialogTitle = ref('新增商品');
/** 正在编辑的商品 id（null 为新增） */
const editingId = ref<number | null>(null);
/** 弹窗表单 */
const form = reactive<ProductForm>({
  name: '', sku: '', categoryId: null, unit: '', barcode: '', spec: '',
  salePriceYuan: null, remark: '', warnThreshold: 10,
});
/** SKU 重复预检错误 */
const skuError = ref('');
/** 弹窗提交中 */
const submitLoading = ref(false);
/** SKU 预检防抖计时器 */
let skuCheckTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 加载分类树选项
 * @returns Promise，失败经拦截器提示
 */
async function loadCategories(): Promise<void> {
  try {
    categories.value = await listCategories();
  } catch {
    // 提示已由拦截器统一处理
  }
}

/**
 * 加载商品列表
 * @returns Promise，失败时清空列表（错误提示由拦截器处理）
 */
async function loadList(): Promise<void> {
  tableLoading.value = true;
  try {
    const data = await listProducts({
      page: page.value,
      pageSize: pageSize.value,
      keyword: filters.keyword || undefined,
      categoryId: filters.categoryId,
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

/**
 * 搜索（重置到第 1 页）
 * @returns void
 */
function doSearch(): void {
  page.value = 1;
  loadList();
}

/**
 * 重置筛选
 * @returns void
 */
function doReset(): void {
  filters.keyword = '';
  filters.categoryId = undefined;
  doSearch();
}

/**
 * 打开新增弹窗
 * @returns void
 */
function openCreate(): void {
  editingId.value = null;
  dialogTitle.value = '新增商品';
  Object.assign(form, { name: '', sku: '', categoryId: null, unit: '', barcode: '', spec: '', salePriceYuan: null, remark: '', warnThreshold: 10 });
  skuError.value = '';
  dialogVisible.value = true;
}

/**
 * 打开编辑弹窗
 * @param row 当前行数据
 * @returns void
 */
function openEdit(row: ProductRow): void {
  editingId.value = row.id;
  dialogTitle.value = '编辑商品';
  Object.assign(form, {
    name: row.name,
    sku: row.sku,
    categoryId: row.categoryId,
    unit: row.unit,
    barcode: row.barcode ?? '',
    spec: row.spec ?? '',
    salePriceYuan: row.salePrice !== null ? row.salePrice / 100 : null,
    remark: row.remark ?? '',
    warnThreshold: row.warnThreshold,
  });
  skuError.value = '';
  dialogVisible.value = true;
}

/**
 * SKU 失焦预检：调用列表接口按 SKU 精确匹配（排除自身）
 * @returns Promise，重复时行内报"SKU 已存在"
 */
function checkSku(): Promise<void> {
  return (async () => {
    skuError.value = '';
    if (!form.sku) return;
    try {
      const data = await listProducts({ page: 1, pageSize: 1, keyword: form.sku });
      const hit = data.list.find((p) => p.sku.toUpperCase() === form.sku.toUpperCase() && p.id !== editingId.value);
      if (hit) skuError.value = 'SKU 已存在';
    } catch {
      // 预检失败不阻断（后端 409 兜底）
    }
  })();
}

/**
 * SKU 输入防抖预检
 * @returns void
 */
function onSkuInput(): void {
  if (skuCheckTimer) clearTimeout(skuCheckTimer);
  skuCheckTimer = setTimeout(() => checkSku(), 500);
}

/**
 * 提交商品表单
 * @returns Promise，成功后刷新列表并关弹窗；409 等（错误 toast）由拦截器处理
 */
async function submitProduct(): Promise<void> {
  if (!form.name || !form.sku || form.categoryId === null || !form.unit) {
    ElMessage.warning('请填写完整必填项（名称/SKU/分类/单位）');
    return;
  }
  if (skuError.value) {
    ElMessage.error(skuError.value);
    return;
  }
  submitLoading.value = true;
  try {
    const payload = {
      name: form.name,
      sku: form.sku,
      categoryId: form.categoryId,
      unit: form.unit,
      barcode: form.barcode || null,
      spec: form.spec || null,
      salePrice: yuan2fen(form.salePriceYuan),
      remark: form.remark || null,
      warnThreshold: form.warnThreshold,
    };
    if (editingId.value === null) {
      await createProduct(payload);
      ElMessage.success('商品创建成功');
    } else {
      await updateProduct(editingId.value, payload);
      ElMessage.success('商品已更新');
    }
    dialogVisible.value = false;
    loadList();
  } catch {
    // 错误提示由拦截器统一处理（如"SKU 已存在"409）
  } finally {
    submitLoading.value = false;
  }
}

/**
 * 删除商品（二次确认；有库存时后端 400）
 * @param row 当前行
 * @returns Promise
 */
async function removeProduct(row: ProductRow): Promise<void> {
  try {
    await ElMessageBox.confirm('删除后商品将不可见，且 SKU 不可再被复用，确认删除？', '删除商品', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
    });
  } catch {
    return; // 用户取消
  }
  try {
    await deleteProduct(row.id);
    ElMessage.success('删除成功');
    loadList();
  } catch {
    // 后端 400"该商品存在库存，无法删除"由拦截器提示
  }
}

/* ==================== 页签二：分类管理 ==================== */
/** 选中的分类 id */
const selectedCatId = ref<number | null>(null);
/** 选中分类下的商品 */
const catProducts = ref<ProductRow[]>([]);
/** 分类商品加载中 */
const catLoading = ref(false);
/** 分类编辑弹窗 */
const catDialogVisible = ref(false);
const catDialogTitle = ref('新增分类');
const catEditingId = ref<number | null>(null);
const catForm = reactive({ name: '', parentId: null as number | null, parentName: '' });

/** 树节点结构（展示用） */
interface TreeDisplayNode {
  id: number;
  name: string;
  parentId: number | null;
  productCount: number;
  children: TreeDisplayNode[];
}

/** 展示树（含"全部"汇总节点） */
const displayTree = computed<TreeDisplayNode[]>(() => {
  const total0 = categories.value.reduce((s, c) => s + c.productCount, 0);
  return [{ id: 0, name: '全部分类', parentId: null, productCount: total0, children: categories.value as TreeDisplayNode[] }];
});

/**
 * 加载选中分类下的商品
 * @param catId 分类 id（0 或 null 表示全部）
 * @returns Promise
 */
async function loadCatProducts(catId: number | null): Promise<void> {
  catLoading.value = true;
  try {
    const data = await listProducts({
      page: 1,
      pageSize: 100,
      categoryId: catId && catId > 0 ? catId : undefined,
    });
    catProducts.value = data.list;
  } catch {
    catProducts.value = [];
  } finally {
    catLoading.value = false;
  }
}

/**
 * 树节点点击
 * @param node 节点数据
 * @returns void
 */
function onNodeClick(node: TreeDisplayNode): void {
  selectedCatId.value = node.id;
  loadCatProducts(node.id);
}

/**
 * 打开分类新增弹窗
 * @param parentId 上级分类 id（null 为一级）
 * @param parentName 上级分类名称（展示）
 * @returns void
 */
function openCatCreate(parentId: number | null, parentName = ''): void {
  catEditingId.value = null;
  catDialogTitle.value = parentId === null ? '新增一级分类' : '新增子分类';
  Object.assign(catForm, { name: '', parentId, parentName });
  catDialogVisible.value = true;
}

/**
 * 打开分类编辑弹窗
 * @param node 节点
 * @returns void
 */
function openCatEdit(node: TreeDisplayNode): void {
  catEditingId.value = node.id;
  catDialogTitle.value = '编辑分类';
  const parent = node.parentId ? categories.value.find((c) => c.id === node.parentId) : null;
  Object.assign(catForm, { name: node.name, parentId: node.parentId, parentName: parent?.name || '（一级分类）' });
  catDialogVisible.value = true;
}

/**
 * 提交分类表单
 * @returns Promise，重名 409 由拦截器 toast"同级下已存在同名分类"
 */
async function submitCategory(): Promise<void> {
  if (!catForm.name.trim()) {
    ElMessage.warning('请输入分类名称');
    return;
  }
  try {
    if (catEditingId.value === null) {
      await createCategory(catForm.name.trim(), catForm.parentId);
      ElMessage.success('分类创建成功');
    } else {
      await updateCategory(catEditingId.value, catForm.name.trim());
      ElMessage.success('分类已更新');
    }
    catDialogVisible.value = false;
    await loadCategories();
  } catch {
    // 错误提示由拦截器处理
  }
}

/**
 * 删除分类（含商品/子分类时后端 400）
 * @param node 节点
 * @returns Promise
 */
async function removeCategory(node: TreeDisplayNode): Promise<void> {
  if (node.id === 0) return; // "全部"节点不可删
  if (node.productCount > 0) {
    ElMessageBox.alert(`该分类下存在 ${node.productCount} 个商品，请先移除或转移商品后再删除`, '无法删除', { type: 'warning' });
    return;
  }
  try {
    await ElMessageBox.confirm('确认删除该分类？', '删除分类', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
    });
  } catch {
    return;
  }
  try {
    await deleteCategory(node.id);
    ElMessage.success('删除成功');
    if (selectedCatId.value === node.id) selectedCatId.value = null;
    await loadCategories();
  } catch {
    // 子分类约束等错误由拦截器提示
  }
}

/** 生命周期：初始化数据 */
onMounted(() => {
  loadCategories();
  loadList();
});
</script>

<template>
  <div class="products-page">
    <!-- 页头 + 页签 -->
    <div class="page-head">
      <h2 class="page-title">商品管理</h2>
    </div>
    <div class="tabs">
      <div class="tab-item" :class="{ active: activeTab === 'list' }" @click="activeTab = 'list'">商品列表</div>
      <div class="tab-item" :class="{ active: activeTab === 'category' }" @click="activeTab = 'category'">分类管理</div>
    </div>

    <!-- ============ 页签一：商品列表 ============ -->
    <template v-if="activeTab === 'list'">
      <!-- 筛选区 -->
      <div class="card filter-card">
        <div class="filter-row">
          <el-input v-model="filters.keyword" class="w-240" placeholder="名称 / SKU" clearable :prefix-icon="Search" @keyup.enter="doSearch" @clear="doSearch" />
          <el-select v-model="filters.categoryId" class="w-200" placeholder="全部分类" clearable>
            <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
            <template v-for="c in categories" :key="'g' + c.id">
              <el-option v-for="ch in c.children" :key="ch.id" :label="`　${c.name} / ${ch.name}`" :value="ch.id" />
            </template>
          </el-select>
          <el-button type="primary" :icon="Search" @click="doSearch">搜索</el-button>
          <el-button :icon="Refresh" @click="doReset">重置</el-button>
          <el-button v-if="canWrite" type="primary" class="push-right" @click="openCreate">新增商品</el-button>
        </div>
      </div>

      <!-- 表格 -->
      <div class="card table-card">
        <div v-if="firstLoading" class="skeleton">
          <div class="sk head-sk"></div>
          <div v-for="i in 5" :key="i" class="sk row-sk"><span style="width: 60%"></span><span style="width: 30%"></span></div>
        </div>
        <template v-else-if="rows.length === 0">
          <EmptyState main="暂无商品数据" sub="试试更换关键词或清空筛选，或点击右上角新增商品" :action-text="canWrite ? '新增商品' : ''" @action="openCreate" />
        </template>
        <template v-else>
          <div class="table-wrap">
            <el-table :data="rows" v-loading="tableLoading" stripe :header-cell-style="{ background: '#F8FAFC' }">
              <el-table-column prop="sku" label="SKU" width="150" fixed="left">
                <template #default="{ row }"><span class="mono">{{ row.sku }}</span></template>
              </el-table-column>
              <el-table-column prop="name" label="名称" min-width="200" show-overflow-tooltip />
              <el-table-column label="分类" width="140">
                <template #default="{ row }">{{ row.parentCategoryName ? `${row.parentCategoryName} / ${row.categoryName}` : row.categoryName }}</template>
              </el-table-column>
              <el-table-column prop="unit" label="单位" width="70" />
              <el-table-column label="规格" width="120" show-overflow-tooltip>
                <template #default="{ row }">{{ row.spec || '—' }}</template>
              </el-table-column>
              <el-table-column label="售价(元)" width="110" align="right">
                <template #default="{ row }"><span class="num">{{ fen2yuan(row.salePrice) }}</span></template>
              </el-table-column>
              <el-table-column label="库存" width="110" align="right">
                <template #default="{ row }">
                  <span v-if="row.quantity <= row.warnThreshold" class="low-num"><span class="dot"></span>{{ row.quantity }}</span>
                  <span v-else class="num">{{ row.quantity }}</span>
                </template>
              </el-table-column>
              <el-table-column label="预警阈值" width="100" align="right">
                <template #default="{ row }"><span class="num threshold">{{ row.warnThreshold }}</span></template>
              </el-table-column>
              <el-table-column label="创建时间" width="160">
                <template #default="{ row }"><span class="time">{{ fmtTime(row.createdAt) }}</span></template>
              </el-table-column>
              <el-table-column v-if="canWrite" label="操作" width="130" fixed="right">
                <template #default="{ row }">
                  <el-button text type="primary" size="small" @click="openEdit(row)">编辑</el-button>
                  <el-button text type="danger" size="small" @click="removeProduct(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <div class="pager">
            <el-pagination
              v-model:current-page="page"
              v-model:page-size="pageSize"
              :total="total"
              :page-sizes="[10, 20, 50, 100]"
              layout="total, prev, pager, next, sizes"
              background
              @current-change="loadList"
              @size-change="doSearch"
            />
          </div>
        </template>
      </div>
    </template>

    <!-- ============ 页签二：分类管理 ============ -->
    <template v-else>
      <div class="cat-layout">
        <!-- 左树 -->
        <div class="card tree-card">
          <div class="tree-head">
            <span class="tree-title">分类</span>
            <el-button v-if="canCategoryWrite" text type="primary" size="small" :icon="Plus" @click="openCatCreate(null)">新增一级分类</el-button>
          </div>
          <div class="tree-node root" :class="{ active: selectedCatId === 0 }" @click="onNodeClick(displayTree[0])">
            <span>全部分类</span>
            <span class="badge">{{ displayTree[0]?.productCount ?? 0 }}</span>
          </div>
          <div v-for="c in categories" :key="c.id" class="tree-group">
            <div class="tree-node" :class="{ active: selectedCatId === c.id }" @click="onNodeClick(c as TreeDisplayNode)">
              <span>{{ c.name }}</span>
              <span class="ops">
                <span class="badge">{{ c.productCount }}</span>
                <template v-if="canCategoryWrite">
                  <el-icon :size="16" title="新增子分类" @click.stop="openCatCreate(c.id, c.name)"><Plus /></el-icon>
                  <el-icon :size="16" title="编辑" @click.stop="openCatEdit(c as TreeDisplayNode)"><Edit /></el-icon>
                  <el-icon :size="16" title="删除" class="op-del" @click.stop="removeCategory(c as TreeDisplayNode)"><Delete /></el-icon>
                </template>
              </span>
            </div>
            <div v-for="ch in c.children" :key="ch.id" class="tree-node child" :class="{ active: selectedCatId === ch.id }" @click="onNodeClick(ch as TreeDisplayNode)">
              <span>{{ ch.name }}</span>
              <span class="ops">
                <span class="badge">{{ ch.productCount }}</span>
                <template v-if="canCategoryWrite">
                  <el-icon :size="16" title="编辑" @click.stop="openCatEdit(ch as TreeDisplayNode)"><Edit /></el-icon>
                  <el-icon :size="16" title="删除" class="op-del" @click.stop="removeCategory(ch as TreeDisplayNode)"><Delete /></el-icon>
                </template>
              </span>
            </div>
          </div>
        </div>

        <!-- 右侧商品表 -->
        <div class="card table-card cat-products">
          <template v-if="selectedCatId === null">
            <EmptyState main="请选择左侧分类查看商品" sub="点击任意分类节点查看该分类下的商品列表" dot-color="#F59E0B" />
          </template>
          <template v-else>
            <div class="table-wrap">
              <el-table :data="catProducts" v-loading="catLoading" stripe :header-cell-style="{ background: '#F8FAFC' }">
                <el-table-column prop="sku" label="SKU" width="150">
                  <template #default="{ row }"><span class="mono">{{ row.sku }}</span></template>
                </el-table-column>
                <el-table-column prop="name" label="名称" min-width="200" show-overflow-tooltip />
                <el-table-column prop="unit" label="单位" width="70" />
                <el-table-column label="售价(元)" width="110" align="right">
                  <template #default="{ row }"><span class="num">{{ fen2yuan(row.salePrice) }}</span></template>
                </el-table-column>
                <el-table-column label="库存" width="110" align="right">
                  <template #default="{ row }">
                    <span v-if="row.quantity <= row.warnThreshold" class="low-num"><span class="dot"></span>{{ row.quantity }}</span>
                    <span v-else class="num">{{ row.quantity }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="创建时间" width="160">
                  <template #default="{ row }"><span class="time">{{ fmtTime(row.createdAt) }}</span></template>
                </el-table-column>
              </el-table>
            </div>
          </template>
        </div>
      </div>
    </template>

    <!-- ============ 商品新增/编辑弹窗 ============ -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="640px" :close-on-click-modal="false">
      <el-form label-width="96px" label-position="left">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="商品名称" required>
              <el-input v-model="form.name" maxlength="100" show-word-limit placeholder="1~100 字" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="SKU 编码" required :error="skuError">
              <el-input v-model="form.sku" maxlength="50" placeholder="1~50 字符，全局唯一" @input="onSkuInput" @blur="checkSku" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="分类" required>
              <el-select v-model="form.categoryId" placeholder="请选择分类" style="width: 100%">
                <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
                <template v-for="c in categories" :key="'e' + c.id">
                  <el-option v-for="ch in c.children" :key="ch.id" :label="`${c.name} / ${ch.name}`" :value="ch.id" />
                </template>
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="单位" required>
              <el-input v-model="form.unit" maxlength="10" placeholder="如：个 / 箱 / 千克" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="条形码">
              <el-input v-model="form.barcode" maxlength="64" placeholder="选填" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="规格">
              <el-input v-model="form.spec" maxlength="100" placeholder="选填" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="售价(元)">
              <el-input-number v-model="form.salePriceYuan" :min="0" :precision="2" :step="1" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="预警阈值">
              <el-input-number v-model="form.warnThreshold" :min="0" :max="999999" :step="1" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="3" maxlength="200" show-word-limit placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitLoading" @click="submitProduct">保存</el-button>
      </template>
    </el-dialog>

    <!-- ============ 分类新增/编辑弹窗 ============ -->
    <el-dialog v-model="catDialogVisible" :title="catDialogTitle" width="420px" :close-on-click-modal="false">
      <el-form label-width="96px" label-position="left">
        <el-form-item label="分类名称" required>
          <el-input v-model="catForm.name" maxlength="50" placeholder="1~50 字，同级唯一" />
        </el-form-item>
        <el-form-item label="上级分类">
          <el-input :model-value="catForm.parentId === null ? '（无 · 一级分类）' : catForm.parentName" disabled />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="catDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitCategory">保存</el-button>
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
  content: ''; position: absolute; left: 16px; right: 16px; bottom: -1px;
  height: 2px; background: var(--brand-500);
}

.filter-card { padding: 16px 20px; margin-bottom: 16px; }
.filter-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.w-240 { width: 240px; }
.w-200 { width: 200px; }
.push-right { margin-left: auto; }

.table-card { padding: 0; overflow: hidden; }
.table-card :deep(.el-table) { --el-table-header-bg-color: #F8FAFC; }
.table-wrap { overflow-x: auto; }
.pager { display: flex; justify-content: flex-end; padding: 16px 20px; }
.time { font-size: 13px; color: var(--neutral-500); }
.threshold { color: var(--neutral-500); }
.low-num { color: var(--warning-text); font-weight: 700; font-variant-numeric: tabular-nums; display: inline-flex; align-items: center; gap: 6px; }
.dot { width: 8px; height: 8px; border-radius: 999px; background: var(--warning-500); display: inline-block; }
:deep(.el-table__row:hover) td { background-color: var(--brand-50) !important; }

/* 骨架 */
.skeleton { padding: 12px 20px 20px; }
.sk { background: var(--neutral-100); border-radius: 4px; }
.head-sk { height: 44px; margin: 12px -20px 8px; background: var(--neutral-25); }
.row-sk { display: flex; justify-content: space-between; height: 14px; margin: 18px 0; }
.row-sk span { background: var(--neutral-100); border-radius: 3px; height: 14px; display: block; }

/* 分类布局 */
.cat-layout { display: flex; gap: 16px; align-items: flex-start; }
.tree-card { width: 280px; flex-shrink: 0; padding: 16px; }
.cat-products { flex: 1; min-width: 0; }
@media (max-width: 1023px) { .cat-layout { flex-direction: column; } .tree-card { width: 100%; } }

.tree-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.tree-title { font-size: 14px; font-weight: 600; color: var(--neutral-800); }
.tree-node {
  height: 36px; border-radius: 6px; display: flex; align-items: center; justify-content: space-between;
  padding: 0 8px; cursor: pointer; font-size: 14px; color: var(--neutral-600);
}
.tree-node:hover { background: var(--neutral-25); }
.tree-node.active { background: var(--brand-50); color: var(--brand-700); font-weight: 500; }
.tree-node.child { padding-left: 28px; }
.tree-group { margin-bottom: 4px; }
.ops { display: flex; align-items: center; gap: 4px; }
.ops .el-icon { color: var(--neutral-400); }
.ops .el-icon:hover { color: var(--brand-600); }
.ops .el-icon.op-del:hover { color: var(--danger-500); }
.badge {
  min-width: 20px; height: 18px; padding: 0 6px; border-radius: 999px; background: var(--neutral-50);
  color: var(--neutral-500); font-size: 12px; display: inline-flex; align-items: center; justify-content: center;
}
</style>
