<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { adjustmentStatusLabels, type AdjustmentRequest, type ApiMeta } from "@/types";

const auth = useAuthStore();
const loading = ref(true);
const items = ref<AdjustmentRequest[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const statusFilter = ref<"PENDING" | "APPROVED" | "REJECTED" | "CANCELED" | "ALL">("PENDING");

const statusTagType: Record<string, "warning" | "success" | "info" | "danger"> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  CANCELED: "info"
};

const canReview = computed(() => Boolean(auth.user));

async function load() {
  loading.value = true;
  try {
    const response = await request<{ data: AdjustmentRequest[]; meta: ApiMeta }>(
      `/adjustment-requests?status=${statusFilter.value}&page=${page.value}&pageSize=${pageSize}`
    );
    items.value = response.data;
    total.value = response.meta.total;
    window.dispatchEvent(new CustomEvent("handcraft:pending-adjustments-changed"));
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "调整单加载失败");
  } finally {
    loading.value = false;
  }
}

function canAct(row: AdjustmentRequest): boolean {
  return row.status === "PENDING" && row.requestedByUserId !== auth.user?.id;
}

async function approve(row: AdjustmentRequest) {
  try {
    const { value: note } = await ElMessageBox.prompt(
      `批准后将立即按 ${row.beforeQuantity} → ${row.expectedAfterQuantity} ${row.stockUnit} 更新批次结余并写入库存流水，且不可重复入账。可填写复核备注。`,
      `双人复核 · ${row.materialName}（${row.direction === "IN" ? "盘增" : "盘减"} ${row.quantity} ${row.stockUnit}）`,
      {
        confirmButtonText: "确认批准并入账",
        cancelButtonText: "取消",
        inputPlaceholder: "复核备注（可选）",
        inputValue: "",
        type: "warning"
      }
    );
    await request(`/adjustment-requests/${row.id}/approve`, {
      method: "POST",
      body: note && note.trim() ? { note: note.trim() } : {}
    });
    ElMessage.success("已批准，结余与流水已在同一事务写入");
    await load();
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof ApiError ? error.message : "批准失败");
  }
}

async function reject(row: AdjustmentRequest) {
  try {
    const { value: reason } = await ElMessageBox.prompt(
      "拒绝后该调整单关闭，不会改变批次结余。请填写拒绝原因。",
      "拒绝调整单",
      {
        confirmButtonText: "确认拒绝",
        cancelButtonText: "取消",
        inputPlaceholder: "至少 3 个字的拒绝原因",
        inputValue: "",
        inputValidator: (v: string) => (v && v.trim().length >= 3) || "请填写至少 3 个字的原因"
      }
    );
    await request(`/adjustment-requests/${row.id}/reject`, {
      method: "POST",
      body: { reason: reason.trim() }
    });
    ElMessage.success("已拒绝，批次结余未改变");
    await load();
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof ApiError ? error.message : "拒绝失败");
  }
}

async function cancel(row: AdjustmentRequest) {
  try {
    await ElMessageBox.confirm("撤销后该调整单关闭，需要调整时请重新发起。", "撤销本人调整单", { type: "warning" });
    await request(`/adjustment-requests/${row.id}/cancel`, { method: "POST" });
    ElMessage.success("已撤销");
    await load();
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof ApiError ? error.message : "撤销失败");
  }
}

function changeFilter() {
  page.value = 1;
  void load();
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <header class="page-header">
      <div>
        <h1>结余调整复核</h1>
        <p>超过差异阈值的调整会暂存于此。必须由<strong>非申请人</strong>的另一位操作员批准；批准、余额更新与流水写入在同一事务完成。</p>
      </div>
      <el-radio-group v-model="statusFilter" @change="changeFilter">
        <el-radio-button value="PENDING">待复核</el-radio-button>
        <el-radio-button value="APPROVED">已批准</el-radio-button>
        <el-radio-button value="REJECTED">已拒绝</el-radio-button>
        <el-radio-button value="CANCELED">已撤销</el-radio-button>
        <el-radio-button value="ALL">全部</el-radio-button>
      </el-radio-group>
    </header>

    <section class="panel">
      <el-table :data="items" size="small">
        <el-table-column label="状态" width="92">
          <template #default="{ row }">
            <el-tag :type="statusTagType[row.status]" size="small">{{ adjustmentStatusLabels[row.status] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="材料 / 批次" min-width="160">
          <template #default="{ row }">
            <router-link :to="`/batches/${row.batchId}`">{{ row.materialName }}</router-link>
            <div class="muted">{{ row.batchCode || "无批次号" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="方向 / 数量" width="130">
          <template #default="{ row }">
            <span :class="row.direction === 'IN' ? 'amount' : ''">{{ row.direction === "IN" ? "盘增" : "盘减" }} {{ row.quantity }} {{ row.stockUnit }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结余变化" width="150">
          <template #default="{ row }">{{ row.beforeQuantity }} → {{ row.expectedAfterQuantity }}</template>
        </el-table-column>
        <el-table-column label="原因" prop="reason" min-width="140" show-overflow-tooltip />
        <el-table-column label="申请人" width="110">
          <template #default="{ row }">
            {{ row.requestedByName || row.requestedByUserId.slice(0, 8) }}
            <div v-if="row.requestedByUserId === auth.user?.id" class="muted">（本人）</div>
          </template>
        </el-table-column>
        <el-table-column label="复核人 / 备注" min-width="150">
          <template #default="{ row }">
            <template v-if="row.status === 'PENDING'"><span class="muted">待复核</span></template>
            <template v-else>
              {{ row.reviewedByName || (row.status === "CANCELED" ? "申请人撤销" : "—") }}
              <div v-if="row.reviewNote" class="muted">{{ row.reviewNote }}</div>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="166">
          <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 'PENDING'">
              <el-button v-if="canReview && canAct(row)" type="primary" size="small" @click="approve(row)">批准入账</el-button>
              <el-button v-if="canReview && canAct(row)" type="danger" plain size="small" @click="reject(row)">拒绝</el-button>
              <el-button v-if="row.requestedByUserId === auth.user?.id" size="small" @click="cancel(row)">撤销</el-button>
              <span v-if="!canAct(row) && row.requestedByUserId === auth.user?.id" class="muted">等待他人复核</span>
            </template>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-if="total > pageSize"
        style="margin-top:16px;justify-content:flex-end"
        layout="prev, pager, next"
        :page-size="pageSize"
        :total="total"
        :current-page="page"
        @current-change="(p: number) => { page = p; void load(); }"
      />
    </section>
  </div>
</template>
