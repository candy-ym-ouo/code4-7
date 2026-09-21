<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Box, Collection, DataAnalysis, Document, FolderOpened, Location, Setting, Tickets, User, Bell } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { request } from "@/lib/api";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const isPublic = computed(() => Boolean(route.meta.public));
const pendingAdjustments = ref(0);
let pendingTimer: ReturnType<typeof setInterval> | undefined;

async function refreshPendingCount() {
  if (!auth.user) return;
  try {
    const response = await request<{ meta: { total: number } }>("/adjustment-requests?status=PENDING&page=1&pageSize=1");
    pendingAdjustments.value = response.meta.total;
  } catch {
    // 静默处理：角标刷新失败不影响使用
  }
}

onMounted(() => {
  window.addEventListener("handcraft:unauthorized", handleUnauthorized);
  window.addEventListener("handcraft:pending-adjustments-changed", refreshPendingCount);
  void refreshPendingCount();
  pendingTimer = setInterval(refreshPendingCount, 30_000);
});
onUnmounted(() => {
  window.removeEventListener("handcraft:unauthorized", handleUnauthorized);
  window.removeEventListener("handcraft:pending-adjustments-changed", refreshPendingCount);
  if (pendingTimer) clearInterval(pendingTimer);
});

const activeMenu = computed(() => {
  if (route.path.startsWith("/materials")) return "/materials";
  if (route.path.startsWith("/batches")) return "/batches";
  if (route.path.startsWith("/projects")) return "/projects";
  if (route.path.startsWith("/consumptions")) return "/consumptions";
  if (route.path.startsWith("/adjustments")) return "/adjustments";
  if (route.path.startsWith("/operators")) return "/operators";
  if (route.path.startsWith("/sources")) return "/sources";
  if (route.path.startsWith("/locations")) return "/locations";
  if (route.path.startsWith("/settings")) return "/settings";
  if (route.path.startsWith("/audit")) return "/audit";
  return "/";
});

function handleUnauthorized() {
  auth.user = null;
  if (!isPublic.value) void router.push("/login");
}

async function logout() {
  try {
    await auth.logout();
    ElMessage.success("已退出登录");
  } catch {
    auth.user = null;
    ElMessage.warning("本地会话已退出，服务器未响应");
  } finally {
    await router.push("/login");
  }
}
</script>

<template>
  <router-view v-if="isPublic || !auth.user" />
  <el-container v-else class="app-shell">
    <el-aside width="232px" class="sidebar">
      <div class="brand">
        <div class="brand-mark">材</div>
        <div>
          <strong>材料追踪器</strong>
          <span>Handcraft Inventory</span>
        </div>
      </div>
      <el-menu :default-active="activeMenu" router class="side-menu">
        <el-menu-item index="/"><el-icon><DataAnalysis /></el-icon><span>仪表盘</span></el-menu-item>
        <el-menu-item index="/materials"><el-icon><Box /></el-icon><span>材料档案</span></el-menu-item>
        <el-menu-item index="/batches"><el-icon><Collection /></el-icon><span>批次库存</span></el-menu-item>
        <el-menu-item index="/projects"><el-icon><FolderOpened /></el-icon><span>项目</span></el-menu-item>
        <el-menu-item index="/consumptions"><el-icon><Document /></el-icon><span>消耗记录</span></el-menu-item>
        <el-menu-item index="/adjustments">
          <el-icon><Bell /></el-icon><span>调整复核</span>
          <el-badge v-if="pendingAdjustments > 0" :value="pendingAdjustments" :max="99" class="menu-badge" />
        </el-menu-item>
        <el-menu-item index="/sources"><el-icon><Tickets /></el-icon><span>来源</span></el-menu-item>
        <el-menu-item index="/locations"><el-icon><Location /></el-icon><span>存放位置</span></el-menu-item>
        <el-menu-item v-if="auth.isAdmin" index="/operators"><el-icon><User /></el-icon><span>操作员管理</span></el-menu-item>
        <el-menu-item index="/audit"><el-icon><Document /></el-icon><span>审计日志</span></el-menu-item>
        <el-menu-item index="/settings"><el-icon><Setting /></el-icon><span>设置</span></el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="topbar">
        <div>
          <span class="topbar-kicker">{{ auth.user.loginName }} · {{ auth.user.role === "ADMIN" ? "管理员" : "操作员" }}</span>
          <strong>{{ auth.user.displayName }}</strong>
        </div>
        <el-button text @click="logout">退出登录</el-button>
      </el-header>
      <el-main class="main-content">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

