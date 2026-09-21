<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { adjustmentRequestStatusLabels, type AdjustmentRequest, type ApiMeta } from "@/types";

const loading = ref(false);
const reviewing = ref(false);
const rows = ref<AdjustmentRequest[]>([]);
const meta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const filters = reactive({ status: "PENDING" });
const dialogVisible = ref(false);
const dialogAction = ref<"approve" | "reject">("approve");
const current = ref<AdjustmentRequest | null>(null);
const reviewForm = reactive({ password: "", note: "" });

async function load(page = 1) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (filters.status) params.set("status", filters.status);
    const response = await request<{ data: AdjustmentRequest[]; meta: ApiMeta }>(`/adjustment-requests?${params}`);
    rows.value = response.data;
    Object.assign(meta, response.meta);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "调整复核列表加载失败");
  } finally {
    loading.value = false;
  }
}

function openReview(row: AdjustmentRequest, action: "approve" | "reject") {
  current.value = row;
  dialogAction.value = action;
  Object.assign(reviewForm, { password: "", note: "" });
  dialogVisible.value = true;
}

async function submitReview() {
  if (!current.value) return;
  if (!reviewForm.password) {
    ElMessage.error("请输入复核人密码");
    return;
  }
  reviewing.value = true;
  try {
    await request(`/adjustment-requests/${current.value.id}/${dialogAction.value}`, {
      method: "POST",
      body: { password: reviewForm.password, note: reviewForm.note || null }
    });
    ElMessage.success(dialogAction.value === "approve" ? "调整已批准并入账" : "调整已拒绝，库存未变动");
    dialogVisible.value = false;
    await load(meta.page);
  } catch (error) {
    if (error instanceof ApiError && error.code === "ALREADY_REVIEWED") {
      ElMessage.warning(error.message);
      dialogVisible.value = false;
      await load(meta.page);
    } else {
      ElMessage.error(error instanceof ApiError ? error.message : "复核操作失败");
    }
  } finally {
    reviewing.value = false;
  }
}

onMounted(() => load());
</script>

<template>
  <div>
    <header class="page-header">
      <div><h1>调整复核</h1><p>超过复核阈值的库存调整在此暂存，由第二人复核批准后才写入库存流水。</p></div>
    </header>
    <section class="toolbar">
      <el-form :inline="true" @submit.prevent="load(1)">
        <el-form-item label="状态">
          <el-select v-model="filters.status" style="width: 160px" @change="load(1)">
            <el-option value="PENDING" label="待复核" />
            <el-option value="APPROVED" label="已批准" />
            <el-option value="REJECTED" label="已拒绝" />
          </el-select>
        </el-form-item>
        <el-form-item><el-button type="primary" @click="load(1)">刷新</el-button></el-form-item>
      </el-form>
    </section>
    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="提交时间" width="170"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template></el-table-column>
        <el-table-column label="材料 / 批次" min-width="170">
          <template #default="{ row }">
            <router-link :to="`/batches/${row.batchId}`">{{ row.materialName }}</router-link>
            <div class="muted">{{ row.batchCode || "无批次号" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="调整" width="150">
          <template #default="{ row }"><span class="amount">{{ row.direction === "IN" ? "盘增" : "盘减" }} {{ row.quantity }} {{ row.stockUnit }}</span></template>
        </el-table-column>
        <el-table-column label="阈值" width="110"><template #default="{ row }">{{ row.threshold }} {{ row.stockUnit }}</template></el-table-column>
        <el-table-column label="原因" prop="reason" min-width="160" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'PENDING' ? 'warning' : row.status === 'APPROVED' ? 'success' : 'info'" size="small">
              {{ adjustmentRequestStatusLabels[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="复核信息" min-width="150">
          <template #default="{ row }">
            <template v-if="row.reviewedAt">{{ row.reviewedByName || "复核人" }} · {{ new Date(row.reviewedAt).toLocaleString() }}<div v-if="row.reviewNote" class="muted">{{ row.reviewNote }}</div></template>
            <span v-else class="muted">待第二人复核</span>
          </template>
        </el-table-column>
        <el-table-column v-if="filters.status === 'PENDING'" label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <template v-if="row.createdByCurrentSession">
              <el-tooltip content="本调整由当前会话提交，需第二人重新登录后复核" placement="top">
                <span><el-button size="small" disabled>批准</el-button> <el-button size="small" disabled>拒绝</el-button></span>
              </el-tooltip>
            </template>
            <template v-else>
              <el-button size="small" type="primary" @click="openReview(row, 'approve')">批准</el-button>
              <el-button size="small" type="danger" plain @click="openReview(row, 'reject')">拒绝</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length === 0" description="没有待复核的库存调整" />
      <el-pagination v-if="meta.total > 0" style="margin-top:16px;justify-content:flex-end" layout="total, prev, pager, next" :total="meta.total" :page-size="meta.pageSize" :current-page="meta.page" @current-change="load" />
    </section>

    <el-dialog v-model="dialogVisible" :title="dialogAction === 'approve' ? '批准调整' : '拒绝调整'" width="480px">
      <el-alert
        v-if="current"
        :title="`${current.materialName}（${current.batchCode || '无批次号'}）：${current.direction === 'IN' ? '盘增' : '盘减'} ${current.quantity} ${current.stockUnit}`"
        :description="`原因：${current.reason}`"
        :type="dialogAction === 'approve' ? 'warning' : 'info'"
        show-icon
        :closable="false"
        style="margin-bottom:16px"
      />
      <el-alert v-if="dialogAction === 'approve'" title="批准后库存流水与余额将立即更新，且不可重复入账。" type="warning" show-icon :closable="false" style="margin-bottom:16px" />
      <el-form label-position="top" @submit.prevent="submitReview">
        <el-form-item label="复核人密码" required>
          <el-input v-model="reviewForm.password" type="password" show-password placeholder="第二人在场输入操作员密码" @keyup.enter="submitReview" />
        </el-form-item>
        <el-form-item label="复核意见（可选）"><el-input v-model="reviewForm.note" type="textarea" :rows="2" maxlength="1000" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button :type="dialogAction === 'approve' ? 'primary' : 'danger'" :loading="reviewing" @click="submitReview">
          {{ dialogAction === "approve" ? "确认批准" : "确认拒绝" }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
