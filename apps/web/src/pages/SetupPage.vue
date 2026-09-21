<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { ApiError } from "@/lib/api";

const router = useRouter();
const auth = useAuthStore();
const loading = ref(false);
const form = reactive({ loginName: "admin", displayName: "", password: "", confirmPassword: "" });

async function submit() {
  if (form.password !== form.confirmPassword) {
    ElMessage.error("两次输入的密码不一致");
    return;
  }
  loading.value = true;
  try {
    await auth.setup(form.loginName.trim(), form.displayName, form.password);
    ElMessage.success("工作区初始化完成");
    await router.push("/");
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "初始化失败");
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-card">
      <div class="brand-mark" style="margin-bottom: 18px">材</div>
      <h1>建立你的材料工作区</h1>
      <p>首次初始化会创建管理员账号。超阈值的结余调整将暂存，等待第二位操作员复核后入账。所有业务内容都由你从真实记录开始建立。</p>
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="登录账号">
          <el-input v-model="form.loginName" maxlength="40" placeholder="字母开头，3-40 位字母、数字、_ 或 -" />
        </el-form-item>
        <el-form-item label="显示名称">
          <el-input v-model="form.displayName" maxlength="80" placeholder="例如：小林的工作室" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" show-password placeholder="至少 10 位" />
        </el-form-item>
        <el-form-item label="确认密码">
          <el-input v-model="form.confirmPassword" type="password" show-password @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" size="large" style="width: 100%" :loading="loading" @click="submit">初始化并进入</el-button>
      </el-form>
    </section>
  </main>
</template>
