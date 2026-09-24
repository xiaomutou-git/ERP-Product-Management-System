<script setup lang="ts">
/**
 * 供应商管理页（组件级注释）
 * ------------------------------------------------------------------
 * 核心功能：关键词/状态筛选、分页表格、新增/编辑弹窗（电话/邮箱行内校验）、
 *          启停切换（停用二次确认）、删除二次确认（被采购单引用时后端 400）。
 * 设计思路：写按钮按权限显隐（can('supplier:write') → 采购员/管理员）；
 *          停用确认文案提示对新建采购单的影响（UI-DESIGN 5.4）。
 * 适用场景：/suppliers 路由。
 * 创建时间：2026-09-21
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search, Refresh } from '@element-plus/icons-vue';
import EmptyState from '@/components/EmptyState.vue';
import { listSuppliers, createSupplier, updateSupplier, toggleSupplierStatus, deleteSupplier } from '@/api';
import { can, fmtTime } from '@/utils/format';
import { useAuthStore } from '@/stores/auth';
import type { SupplierRow } from '@/types/api';

const auth = useAuthStore();
const canWrite = computed(() => can(auth.user?.role, 'supplier:write'));

/** 筛选 */
const filters = reactive({ keyword: '', status: undefined as 0 | 1 | undefined });
/** 数据 */
const rows = ref<SupplierRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const tableLoading = ref(false);
const firstLoading = ref(true);

/** 弹窗 */
const dialogVisible = ref(false);
const dialogTitle = ref('新增供应商');
const editingId = ref<number | null>(null);
const form = reactive({ name: '', contactPerson: '', phone: '', email: '', address: '', remark: '' });
const phoneError = ref('');
const emailError = ref('');
const submitLoading = ref(false);

/** 电话正则（11 位手机号或带区号座机） */
const PHONE_RE = /^(1[3-9]\d{9}|0\d{2,3}-?\d{7,8})$/;
/** 邮箱正则 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 加载供应商列表
 * @returns Promise，失败清空列表
 */
async function loadList(): Promise<void> {
  tableLoading.value = true;
  try {
    const data = await listSuppliers({
      page: page.value,
      pageSize: pageSize.value,
      keyword: filters.keyword || undefined,
      status: filters.status,
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

/** 搜索（回到第 1 页） */
function doSearch(): void {
  page.value = 1;
  loadList();
}

/** 重置筛选 */
function doReset(): void {
  filters.keyword = '';
  filters.status = undefined;
  doSearch();
}

/** 打开新增弹窗 */
function openCreate(): void {
  editingId.value = null;
  dialogTitle.value = '新增供应商';
  Object.assign(form, { name: '', contactPerson: '', phone: '', email: '', address: '', remark: '' });
  phoneError.value = '';
  emailError.value = '';
  dialogVisible.value = true;
}

/**
 * 打开编辑弹窗
 * @param row 当前行
 */
function openEdit(row: SupplierRow): void {
  editingId.value = row.id;
  dialogTitle.value = '编辑供应商';
  Object.assign(form, {
    name: row.name,
    contactPerson: row.contactPerson ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    address: row.address ?? '',
    remark: row.remark ?? '',
  });
  phoneError.value = '';
  emailError.value = '';
  dialogVisible.value = true;
}

/**
 * 电话失焦校验
 * @returns void
 */
function blurPhone(): void {
  phoneError.value = form.phone && !PHONE_RE.test(form.phone) ? '电话格式不正确' : '';
}

/**
 * 邮箱失焦校验
 * @returns void
 */
function blurEmail(): void {
  emailError.value = form.email && !EMAIL_RE.test(form.email) ? '邮箱格式不正确' : '';
}

/**
 * 提交供应商表单
 * @returns Promise，重名 409 由拦截器提示
 */
async function submitSupplier(): Promise<void> {
  blurPhone();
  blurEmail();
  if (!form.name.trim()) {
    ElMessage.warning('请输入供应商名称');
    return;
  }
  if (phoneError.value || emailError.value) return;
  submitLoading.value = true;
  try {
    const payload = {
      name: form.name.trim(),
      contactPerson: form.contactPerson || null,
      phone: form.phone || null,
      email: form.email || null,
      address: form.address || null,
      remark: form.remark || null,
    };
    if (editingId.value === null) {
      await createSupplier(payload);
      ElMessage.success('供应商创建成功');
    } else {
      await updateSupplier(editingId.value, payload);
      ElMessage.success('供应商已更新');
    }
    dialogVisible.value = false;
    loadList();
  } catch {
    // 错误由拦截器提示
  } finally {
    submitLoading.value = false;
  }
}

/**
 * 启停切换（停用需二次确认）
 * @param row 当前行
 * @returns Promise
 */
async function toggleStatus(row: SupplierRow): Promise<void> {
  const target: 0 | 1 = row.status === 1 ? 0 : 1;
  if (target === 0) {
    try {
      await ElMessageBox.confirm('停用后该供应商不可被新采购单选择，历史采购单不受影响', '停用供应商', {
        type: 'warning',
        confirmButtonText: '停用',
        cancelButtonText: '取消',
      });
    } catch {
      return;
    }
  }
  try {
    await toggleSupplierStatus(row.id, target);
    ElMessage.success(target === 1 ? '已启用' : '已停用');
    loadList();
  } catch {
    // 错误由拦截器提示
  }
}

/**
 * 删除供应商（二次确认）
 * @param row 当前行
 * @returns Promise
 */
async function removeSupplier(row: SupplierRow): Promise<void> {
  try {
    await ElMessageBox.confirm('已被采购单引用的供应商无法删除，确认删除该供应商？', '删除供应商', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
    });
  } catch {
    return;
  }
  try {
    await deleteSupplier(row.id);
    ElMessage.success('删除成功');
    loadList();
  } catch {
    // 被引用时后端 400 由拦截器提示
  }
}

onMounted(loadList);
</script>

<template>
  <div class="suppliers-page">
    <div class="page-head">
      <h2 class="page-title">供应商管理</h2>
    </div>

    <!-- 筛选区 -->
    <div class="card filter-card">
      <div class="filter-row">
        <el-input v-model="filters.keyword" class="w-240" placeholder="供应商名称" clearable :prefix-icon="Search" @keyup.enter="doSearch" @clear="doSearch" />
        <el-select v-model="filters.status" class="w-160" placeholder="全部状态" clearable>
          <el-option label="合作中" :value="1" />
          <el-option label="已停用" :value="0" />
        </el-select>
        <el-button type="primary" :icon="Search" @click="doSearch">搜索</el-button>
        <el-button :icon="Refresh" @click="doReset">重置</el-button>
        <el-button v-if="canWrite" type="primary" class="push-right" @click="openCreate">新增供应商</el-button>
      </div>
    </div>

    <!-- 表格 -->
    <div class="card table-card">
      <div v-if="firstLoading" class="skeleton">
        <div v-for="i in 5" :key="i" class="sk row-sk"><span style="width: 60%"></span><span style="width: 30%"></span></div>
      </div>
      <template v-else-if="rows.length === 0">
        <EmptyState main="暂无供应商数据" sub="试试更换关键词或清空筛选" />
      </template>
      <template v-else>
        <div class="table-wrap">
          <el-table :data="rows" v-loading="tableLoading" stripe :header-cell-style="{ background: '#F8FAFC' }">
            <el-table-column prop="name" label="名称" min-width="180" show-overflow-tooltip>
              <template #default="{ row }"><span style="font-weight: 500">{{ row.name }}</span></template>
            </el-table-column>
            <el-table-column label="联系人" width="110">
              <template #default="{ row }">{{ row.contactPerson || '—' }}</template>
            </el-table-column>
            <el-table-column label="电话" width="140">
              <template #default="{ row }"><span class="mono">{{ row.phone || '—' }}</span></template>
            </el-table-column>
            <el-table-column label="邮箱" width="180" show-overflow-tooltip>
              <template #default="{ row }">{{ row.email || '—' }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <span class="tag" :style="row.status === 1 ? { color: '#047857', background: '#D1FAE5' } : { color: '#64748B', background: '#F1F5F9' }">
                  {{ row.status === 1 ? '合作中' : '已停用' }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="创建时间" width="160">
              <template #default="{ row }"><span class="time">{{ fmtTime(row.createdAt) }}</span></template>
            </el-table-column>
            <el-table-column v-if="canWrite" label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <el-button text type="primary" size="small" @click="openEdit(row)">编辑</el-button>
                <el-button text type="primary" size="small" @click="toggleStatus(row)">{{ row.status === 1 ? '停用' : '启用' }}</el-button>
                <el-button text type="danger" size="small" @click="removeSupplier(row)">删除</el-button>
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

    <!-- 新增/编辑弹窗 -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="800px" :close-on-click-modal="false">
      <el-form label-width="96px" label-position="left">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="名称" required>
              <el-input v-model="form.name" maxlength="100" placeholder="1~100 字，全局唯一" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="联系人">
              <el-input v-model="form.contactPerson" maxlength="20" placeholder="选填" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="电话" :error="phoneError">
              <el-input v-model="form.phone" maxlength="20" placeholder="11 位手机号或座机" @blur="blurPhone" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="邮箱" :error="emailError">
              <el-input v-model="form.email" maxlength="100" placeholder="选填" @blur="blurEmail" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="地址">
          <el-input v-model="form.address" maxlength="200" placeholder="选填，最多 200 字" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="3" maxlength="200" show-word-limit placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitLoading" @click="submitSupplier">保存</el-button>
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
.w-160 { width: 160px; }
.push-right { margin-left: auto; }
.table-card { padding: 0; overflow: hidden; }
.table-wrap { overflow-x: auto; }
.pager { display: flex; justify-content: flex-end; padding: 16px 20px; }
.time { font-size: 13px; color: var(--neutral-500); }
.tag { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 500; }
.sk { background: var(--neutral-100); border-radius: 4px; }
.skeleton { padding: 12px 20px 20px; }
.row-sk { display: flex; justify-content: space-between; height: 14px; margin: 18px 0; }
.row-sk span { background: var(--neutral-100); border-radius: 3px; height: 14px; display: block; }
</style>
