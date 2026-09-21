<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Plus } from "@element-plus/icons-vue";
import { request, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import type { Operator } from "@/types";

const auth = useAuthStore();
const loading = ref(true);
const operators = ref<Operator[]>([]);
const dialogVisible = ref(false);
const saving = ref(false);
const form = reactive({ loginName: "", displayName: "", password: "", role: "OPERATOR" as "ADMIN" | "OPERATOR" });

async function load() {
  loading.value = true;
  try {
    const response = await request<{ data: Operator[] }>("/users");
    operators.value = response.data;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "操作员列表加载失败");
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  Object.assign(form, { loginName: "", displayName: "", password: "", role: "OPERATOR" });
  dialogVisible.value = true;
}

async function submit() {
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,39}$/.test(form.loginName.trim())) {
    ElMessage.error("登录账号须以字母开头，3-40 位字母、数字、下划线或连字符");
    return;
  }
  if (form.password.length < 10) {
    ElMessage.error("密码至少 10 位");
    return;
  }
  saving.value = true;
  try {
    await request("/users", {
      method: "POST",
      body: {
        loginName: form.loginName.trim(),
        displayName: form.displayName.trim(),
        password: form.password,
        role: form.role
      }
    });
    ElMessage.success("操作员已创建");
    dialogVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "操作员创建失败");
  } finally {
    saving.value = false;
  }
}

async function deactivate(operator: Operator) {
  if (operator.id === auth.user?.id) {
    ElMessage.warning("不能停用当前登录账号");
    return;
  }
  try {
    const { ElMessageBox } = await import("element-plus");
    await ElMessageBox.confirm(
      `停用后 ${operator.displayName}（${operator.loginName}）将立即登出且无法再登录。已有的调整记录与审计日志保留。`,
      "停用操作员",
      { type: "warning", confirmButtonText: "确认停用", cancelButtonText: "取消" }
    );
    await request(`/users/${operator.id}/deactivate`, { method: "POST" });
    ElMessage.success("操作员已停用");
    await load();
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof ApiError ? error.message : "停用失败");
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <header class="page-header">
      <div>
        <h1>操作员管理</h1>
        <p>结余调整的双人复核需要至少两名启用的操作员。第二位操作员可复核或拒绝他人发起的超阈值调整。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新增操作员</el-button>
    </header>

    <section class="panel">
      <el-table :data="operators" size="small">
        <el-table-column label="登录账号" prop="loginName" width="180" />
        <el-table-column label="显示名称" prop="displayName" min-width="140" />
        <el-table-column label="角色" width="110">
          <template #default="{ row }">
            <el-tag :type="row.role === 'ADMIN' ? 'primary' : 'info'" size="small">
              {{ row.role === "ADMIN" ? "管理员" : "操作员" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.deactivatedAt ? 'danger' : 'success'" size="small">
              {{ row.deactivatedAt ? "已停用" : "启用中" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近登录" width="170">
          <template #default="{ row }">{{ row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : "从未登录" }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button
              v-if="!row.deactivatedAt && row.id !== auth.user?.id"
              type="danger" plain size="small"
              @click="deactivate(row)"
            >停用</el-button>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog v-model="dialogVisible" title="新增操作员" width="480px">
      <el-form label-position="top">
        <el-form-item label="登录账号" required>
          <el-input v-model="form.loginName" maxlength="40" placeholder="字母开头，3-40 位字母、数字、_ 或 -" />
        </el-form-item>
        <el-form-item label="显示名称" required>
          <el-input v-model="form.displayName" maxlength="80" placeholder="例如：染坊复核员" />
        </el-form-item>
        <el-form-item label="初始密码" required>
          <el-input v-model="form.password" type="password" show-password placeholder="至少 10 位" />
        </el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="form.role">
            <el-radio value="OPERATOR">操作员（可发起、可复核）</el-radio>
            <el-radio value="ADMIN">管理员（额外可管理账号）</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>
