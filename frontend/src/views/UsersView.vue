<script setup lang="ts">
/**
 * 用户与角色管理页（组件级注释）
 * ------------------------------------------------------------------
 * 核心功能：仅管理员可见——关键词/角色/状态筛选、分页列表、新增用户
 *          （随机密码生成 + 强度提示）、编辑（自己不可停用）、重置密码、
 *          解锁登录锁定、删除（危险二次确认）。
 * 设计思路：角色 Tag 与权限摘要 Tooltip 对应 UI-DESIGN 5.7；重置密码后
 *          目标用户标记"待改密"；所有危险操作走红色确认弹窗。
 * 适用场景：/users 路由（路由守卫已限 admin）。
 * 创建时间：2026-09-21
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search, Refresh, QuestionFilled } from '@element-plus/icons-vue';
import EmptyState from '@/components/EmptyState.vue';
import { listUsers, createUser, updateUser, resetUserPassword, unlockUser, deleteUser } from '@/api';
import { fmtTime, ROLE_MAP } from '@/utils/format';
import { useAuthStore } from '@/stores/auth';
import type { UserRow } from '@/types/api';

const auth = useAuthStore();
/** 当前登录用户 id（保护"不能操作自己"） */
const selfId = computed(() => auth.user?.id ?? 0);

/** 筛选 */
const filters = reactive({ keyword: '', roleCode: undefined as string | undefined, status: undefined as 0 | 1 | undefined });
const rows = ref<UserRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const tableLoading = ref(false);
const firstLoading = ref(true);

/** 新增弹窗 */
const createVisible = ref(false);
const createForm = reactive({ username: '', password: '', realName: '', roleCode: '' });
const createSubmitting = ref(false);

/** 编辑弹窗 */
const editVisible = ref(false);
const editForm = reactive({ id: 0, username: '', realName: '', roleCode: '', status: 1 as 0 | 1 });
const editSubmitting = ref(false);

/** 重置密码弹窗 */
const resetVisible = ref(false);
const resetForm = reactive({ id: 0, username: '', newPassword: '' });
const resetSubmitting = ref(false);

/**
 * 生成 16 位强密码（大小写字母 + 数字 + 符号）
 * @returns 密码字符串
 */
function genPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  let out = '';
  for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)];
  // 保证包含字母与数字
  if (!/[A-Za-z]/.test(out)) out = 'a' + out.slice(1);
  if (!/\d/.test(out)) out = out.slice(0, 4) + '7' + out.slice(5);
  return out;
}

/**
 * 密码强度评估
 * @param pwd 密码字符串
 * @returns 'weak' | 'medium' | 'strong'
 */
function pwdStrength(pwd: string): 'weak' | 'medium' | 'strong' {
  if (!pwd) return 'weak';
  let score = 0;
  if (pwd.length >= 8) score++;
  if (pwd.length >= 12) score++;
  if (/[A-Za-z]/.test(pwd) && /\d/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;
  if (score <= 1) return 'weak';
  if (score <= 2) return 'medium';
  return 'strong';
}

/** 强度展示映射 */
const STRENGTH_TEXT = { weak: '弱', medium: '中', strong: '强' } as const;
const STRENGTH_COLOR = { weak: '#EF4444', medium: '#F59E0B', strong: '#10B981' } as const;

/**
 * 加载用户列表
 * @returns Promise，失败清空
 */
async function loadList(): Promise<void> {
  tableLoading.value = true;
  try {
    const data = await listUsers({
      page: page.value,
      pageSize: pageSize.value,
      keyword: filters.keyword || undefined,
      roleCode: filters.roleCode,
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

/** 搜索 */
function doSearch(): void {
  page.value = 1;
  loadList();
}

/** 重置 */
function doReset(): void {
  filters.keyword = '';
  filters.roleCode = undefined;
  filters.status = undefined;
  doSearch();
}

/** 打开新增弹窗（默认生成随机密码） */
function openCreate(): void {
  Object.assign(createForm, { username: '', password: genPassword(), realName: '', roleCode: '' });
  createVisible.value = true;
}

/**
 * 提交新增用户
 * @returns Promise
 */
async function submitCreate(): Promise<void> {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(createForm.username)) {
    ElMessage.warning('用户名须为 3~20 位字母/数字/下划线');
    return;
  }
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,32}$/.test(createForm.password)) {
    ElMessage.warning('初始密码须 8~32 位且同时包含字母和数字');
    return;
  }
  if (!createForm.realName.trim()) {
    ElMessage.warning('请输入姓名');
    return;
  }
  if (!createForm.roleCode) {
    ElMessage.warning('请选择角色');
    return;
  }
  createSubmitting.value = true;
  try {
    await createUser({ ...createForm, realName: createForm.realName.trim() });
    ElMessage.success('创建成功，该用户首次登录需修改密码');
    createVisible.value = false;
    loadList();
  } catch {
    // 用户名重复 409 等由拦截器提示
  } finally {
    createSubmitting.value = false;
  }
}

/**
 * 打开编辑弹窗
 * @param row 当前行
 * @returns void
 */
function openEdit(row: UserRow): void {
  Object.assign(editForm, { id: row.id, username: row.username, realName: row.realName, roleCode: row.roleCode, status: row.status as 0 | 1 });
  editVisible.value = true;
}

/**
 * 提交编辑
 * @returns Promise
 */
async function submitEdit(): Promise<void> {
  editSubmitting.value = true;
  try {
    await updateUser(editForm.id, { realName: editForm.realName.trim(), roleCode: editForm.roleCode, status: editForm.status });
    ElMessage.success('用户已更新');
    editVisible.value = false;
    loadList();
  } catch {
    // "不能停用自己"/"至少保留一个启用管理员"由拦截器提示
  } finally {
    editSubmitting.value = false;
  }
}

/**
 * 打开重置密码弹窗
 * @param row 当前行
 * @returns void
 */
function openReset(row: UserRow): void {
  Object.assign(resetForm, { id: row.id, username: row.username, newPassword: genPassword() });
  resetVisible.value = true;
}

/**
 * 提交重置密码
 * @returns Promise
 */
async function submitReset(): Promise<void> {
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,32}$/.test(resetForm.newPassword)) {
    ElMessage.warning('新密码须 8~32 位且同时包含字母和数字');
    return;
  }
  resetSubmitting.value = true;
  try {
    await resetUserPassword(resetForm.id, resetForm.newPassword);
    ElMessage.success('密码已重置，该用户下次登录将被要求修改密码');
    resetVisible.value = false;
    loadList();
  } catch {
    // 错误由拦截器提示
  } finally {
    resetSubmitting.value = false;
  }
}

/**
 * 解除登录锁定（常规确认）
 * @param row 当前行
 * @returns Promise
 */
async function doUnlock(row: UserRow): Promise<void> {
  try {
    await ElMessageBox.confirm('确认解除该账号的登录锁定？', '解锁账号', {
      type: 'info', confirmButtonText: '确认解锁', cancelButtonText: '取消',
    });
  } catch { return; }
  try {
    await unlockUser(row.id);
    ElMessage.success('已解除登录锁定');
    loadList();
  } catch {
    // 错误由拦截器提示
  }
}

/**
 * 删除用户（危险二次确认，软删除）
 * @param row 当前行
 * @returns Promise
 */
async function doDelete(row: UserRow): Promise<void> {
  try {
    await ElMessageBox.confirm('删除后该用户不可再登录（软删除），确认删除？', '删除用户', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
    });
  } catch { return; }
  try {
    await deleteUser(row.id);
    ElMessage.success('删除成功');
    loadList();
  } catch {
    // "不能删除自己"/最后管理员保护由拦截器提示
  }
}

onMounted(loadList);
</script>

<template>
  <div class="users-page">
    <div class="page-head">
      <h2 class="page-title">用户与角色管理</h2>
    </div>

    <!-- 筛选区 -->
    <div class="card filter-card">
      <div class="filter-row">
        <el-input v-model="filters.keyword" class="w-240" placeholder="用户名 / 姓名" clearable :prefix-icon="Search" @keyup.enter="doSearch" @clear="doSearch" />
        <el-select v-model="filters.roleCode" class="w-160" placeholder="全部角色" clearable>
          <el-option v-for="(v, k) in ROLE_MAP" :key="k" :label="v.label" :value="k" />
        </el-select>
        <el-select v-model="filters.status" class="w-140" placeholder="全部状态" clearable>
          <el-option label="启用" :value="1" />
          <el-option label="停用" :value="0" />
        </el-select>
        <el-button type="primary" :icon="Search" @click="doSearch">搜索</el-button>
        <el-button :icon="Refresh" @click="doReset">重置</el-button>
        <el-button type="primary" class="push-right" @click="openCreate">新增用户</el-button>
      </div>
    </div>

    <!-- 表格 -->
    <div class="card table-card">
      <div v-if="firstLoading" class="skeleton">
        <div v-for="i in 5" :key="i" class="sk row-sk"><span style="width: 60%"></span><span style="width: 30%"></span></div>
      </div>
      <template v-else-if="rows.length === 0">
        <EmptyState main="暂无用户数据" sub="试试更换关键词或清空筛选" />
      </template>
      <template v-else>
        <div class="table-wrap">
          <el-table :data="rows" v-loading="tableLoading" stripe :header-cell-style="{ background: '#F8FAFC' }">
            <el-table-column label="用户名" width="150">
              <template #default="{ row }"><span class="mono">{{ row.username }}</span></template>
            </el-table-column>
            <el-table-column prop="realName" label="姓名" width="110" />
            <el-table-column label="角色" width="170">
              <template #default="{ row }">
                <span class="tag" :style="{ color: ROLE_MAP[row.roleCode]?.color, background: ROLE_MAP[row.roleCode]?.bg }">
                  {{ ROLE_MAP[row.roleCode]?.label }}
                </span>
                <el-tooltip :content="ROLE_MAP[row.roleCode]?.desc" placement="top">
                  <el-icon :size="14" style="margin-left: 6px; color: var(--neutral-400); vertical-align: middle"><QuestionFilled /></el-icon>
                </el-tooltip>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="140">
              <template #default="{ row }">
                <span class="tag" :style="row.status === 1 ? { color: '#047857', background: '#D1FAE5' } : { color: '#64748B', background: '#F1F5F9' }">
                  {{ row.status === 1 ? '启用' : '停用' }}
                </span>
                <span v-if="row.locked" class="lock-text">已锁定</span>
                <span v-if="row.mustChangePassword === 1" class="lock-text">待改密</span>
              </template>
            </el-table-column>
            <el-table-column label="最近登录" width="160">
              <template #default="{ row }"><span class="time">{{ fmtTime(row.lastLoginAt) }}</span></template>
            </el-table-column>
            <el-table-column label="操作" width="250" fixed="right">
              <template #default="{ row }">
                <el-button text type="primary" size="small" @click="openEdit(row)">编辑</el-button>
                <el-button text type="primary" size="small" @click="openReset(row)">重置密码</el-button>
                <el-button v-if="row.locked" text type="primary" size="small" @click="doUnlock(row)">解锁</el-button>
                <el-button v-if="row.id !== selfId" text type="danger" size="small" @click="doDelete(row)">删除</el-button>
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

    <!-- ============ 新增用户弹窗 ============ -->
    <el-dialog v-model="createVisible" title="新增用户" width="640px" :close-on-click-modal="false">
      <el-form label-width="96px" label-position="left">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="用户名" required>
              <el-input v-model="createForm.username" maxlength="20" placeholder="3~20 位字母/数字/下划线" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="姓名" required>
              <el-input v-model="createForm.realName" maxlength="20" placeholder="1~20 字" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="初始密码" required>
              <el-input v-model="createForm.password" maxlength="32" placeholder="8~32 位，含字母和数字">
                <template #append>
                  <el-button @click="createForm.password = genPassword()">随机生成</el-button>
                </template>
              </el-input>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="角色" required>
              <el-select v-model="createForm.roleCode" placeholder="请选择角色" style="width: 100%">
                <el-option v-for="(v, k) in ROLE_MAP" :key="k" :label="v.label" :value="k" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <p class="strength" :style="{ color: STRENGTH_COLOR[pwdStrength(createForm.password)] }">
          密码强度：{{ STRENGTH_TEXT[pwdStrength(createForm.password)] }}
        </p>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="createSubmitting" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- ============ 编辑用户弹窗 ============ -->
    <el-dialog v-model="editVisible" :title="`编辑用户：${editForm.username}`" width="480px" :close-on-click-modal="false">
      <el-form label-width="96px" label-position="left">
        <el-form-item label="姓名" required>
          <el-input v-model="editForm.realName" maxlength="20" />
        </el-form-item>
        <el-form-item label="角色" required>
          <el-select v-model="editForm.roleCode" style="width: 100%">
            <el-option v-for="(v, k) in ROLE_MAP" :key="k" :label="v.label" :value="k" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="editForm.status" :active-value="1" :inactive-value="0" :disabled="editForm.id === selfId" active-text="启用" inactive-text="停用" />
          <el-tooltip v-if="editForm.id === selfId" content="不能停用自己" placement="top">
            <el-icon :size="14" style="margin-left: 8px; color: var(--neutral-400)"><QuestionFilled /></el-icon>
          </el-tooltip>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="editSubmitting" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- ============ 重置密码弹窗 ============ -->
    <el-dialog v-model="resetVisible" :title="`重置密码：${resetForm.username}`" width="480px" :close-on-click-modal="false">
      <el-form label-width="96px" label-position="left">
        <el-form-item label="新密码" required>
          <el-input v-model="resetForm.newPassword" maxlength="32" placeholder="8~32 位，含字母和数字">
            <template #append>
              <el-button @click="resetForm.newPassword = genPassword()">随机生成</el-button>
            </template>
          </el-input>
        </el-form-item>
      </el-form>
      <p class="confirm-text">重置后该用户下次登录将被要求修改密码。</p>
      <template #footer>
        <el-button @click="resetVisible = false">取消</el-button>
        <el-button type="danger" :loading="resetSubmitting" @click="submitReset">确认重置</el-button>
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
.w-140 { width: 140px; }
.push-right { margin-left: auto; }
.table-card { padding: 0; overflow: hidden; }
.table-wrap { overflow-x: auto; }
.pager { display: flex; justify-content: flex-end; padding: 16px 20px; }
.time { font-size: 13px; color: var(--neutral-500); }
.tag { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 500; }
.lock-text { margin-left: 8px; font-size: 12px; color: var(--warning-text); }
.strength { margin: 0 0 0 96px; font-size: 12px; }
.confirm-text { margin: 0 0 0 96px; font-size: 13px; color: var(--neutral-500); }
.sk { background: var(--neutral-100); border-radius: 4px; }
.skeleton { padding: 12px 20px 20px; }
.row-sk { display: flex; justify-content: space-between; height: 14px; margin: 18px 0; }
.row-sk span { background: var(--neutral-100); border-radius: 3px; height: 14px; display: block; }
</style>
