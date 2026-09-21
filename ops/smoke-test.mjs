const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
const configuredPassword = process.env.SMOKE_PASSWORD;
if (!configuredPassword) {
  throw new Error("SMOKE_PASSWORD is required");
}
let cookie = "";

async function callWithStatus(path, options = {}) {
  const headers = new Headers(options.headers);
  const activeCookie = options.cookie !== undefined ? options.cookie : cookie;
  if (activeCookie) headers.set("cookie", activeCookie);
  if (options.body !== undefined && !(options.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    ...options,
    headers,
    body: options.body instanceof FormData ? options.body : options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  let nextCookie = null;
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    nextCookie = setCookie.split(";")[0];
    if (options.captureCookie) options.captureCookie.value = nextCookie;
  }
  if (options.cookie === undefined && nextCookie) cookie = nextCookie;
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return { status: response.status, data: payload };
}

async function call(path, options = {}) {
  return (await callWithStatus(path, options)).data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const smokeLoginName = process.env.SMOKE_LOGIN_NAME || "admin";
const status = await call("/setup/status");
if (!status.data.initialized) {
  await call("/setup", {
    method: "POST",
    body: { loginName: smokeLoginName, displayName: "Smoke Test Operator", password: configuredPassword }
  });
  console.log("Initialized a new empty workspace.");
} else {
  await call("/auth/login", { method: "POST", body: { loginName: smokeLoginName, password: configuredPassword } });
}

const suffix = Date.now().toString(36);
const source = await call("/sources", { method: "POST", body: { name: `Smoke Source ${suffix}`, type: "PURCHASED" } });
const material = await call("/materials", {
  method: "POST",
  body: {
    code: `SMOKE-${suffix}`,
    name: `Smoke Material ${suffix}`,
    craftTypes: ["GENERAL"],
    stockUnit: "g",
    lowStockThreshold: "100",
    defaultColorName: "Original",
    defaultColorHex: "#8B5A2B",
    tags: ["smoke"]
  }
});
const batchPayload = {
  materialId: material.data.id,
  batchCode: `B-${suffix}`,
  sourceId: source.data.id,
  receivedAt: new Date().toISOString().slice(0, 10),
  initialQuantity: "1",
  entryUnit: "kg"
};
const [batchResult, repeatedBatchResult] = await Promise.all([
  callWithStatus("/batches", {
    method: "POST",
    headers: { "idempotency-key": `smoke-batch-${suffix}` },
    body: batchPayload
  }),
  callWithStatus("/batches", {
    method: "POST",
    headers: { "idempotency-key": `smoke-batch-${suffix}` },
    body: batchPayload
  })
]);
assert([200, 201].includes(batchResult.status) && [200, 201].includes(repeatedBatchResult.status), "Concurrent batch idempotency returned an unexpected status");
const batch = batchResult.status === 201 ? batchResult.data.data : repeatedBatchResult.data.data;
const repeatedBatch = batchResult.status === 201 ? repeatedBatchResult.data.data : batchResult.data.data;
assert(repeatedBatch.id === batch.id, "Batch idempotency returned a different batch");
const project = await call("/projects", {
  method: "POST",
  body: { name: `Smoke Project ${suffix}`, craftType: "GENERAL", status: "PLANNED" }
});
const requirement = await call(`/projects/${project.data.id}/requirements`, {
  method: "POST",
  body: { materialId: material.data.id, requiredQuantity: "500", unit: "g", purpose: "Smoke verification" }
});
const consumptionPayload = {
  projectId: project.data.id,
  projectRequirementId: requirement.data.id,
  batchId: batch.id,
  usedQuantity: "450",
  wasteQuantity: "50",
  unit: "g",
  purpose: "Smoke verification"
};
const [consumptionResult, repeatedConsumptionResult] = await Promise.all([
  callWithStatus("/consumptions", {
    method: "POST",
    headers: { "idempotency-key": `smoke-consumption-${suffix}` },
    body: consumptionPayload
  }),
  callWithStatus("/consumptions", {
    method: "POST",
    headers: { "idempotency-key": `smoke-consumption-${suffix}` },
    body: consumptionPayload
  })
]);
assert([200, 201].includes(consumptionResult.status) && [200, 201].includes(repeatedConsumptionResult.status), "Concurrent consumption idempotency returned an unexpected status");
const consumption = consumptionResult.status === 201 ? consumptionResult.data.data : repeatedConsumptionResult.data.data;
const repeatedConsumption = consumptionResult.status === 201 ? repeatedConsumptionResult.data.data : consumptionResult.data.data;
assert(repeatedConsumption.id === consumption.id, "Consumption idempotency returned a different row");
assert(consumption.totalQuantity === "500.000000", "Consumption total is incorrect");

const latestOccurredAt = new Date();
await call("/color-changes", {
  method: "POST",
  body: {
    batchId: batch.id,
    projectId: project.data.id,
    changeType: "OTHER",
    afterColorName: "Smoke Brown",
    afterColorHex: "#6B2F1F",
    affectedQuantity: "450",
    unit: "g",
    occurredAt: latestOccurredAt.toISOString()
  }
});
const backdatedColor = await call("/color-changes", {
  method: "POST",
  body: {
    batchId: batch.id,
    projectId: project.data.id,
    changeType: "OTHER",
    afterColorName: "Backdated Blue",
    afterColorHex: "#0000FF",
    occurredAt: new Date(latestOccurredAt.getTime() - 60_000).toISOString()
  }
});
assert(backdatedColor.data.isCurrent === false, "Backdated color was treated as current");

const afterConsumption = await call(`/batches/${batch.id}`);
assert(afterConsumption.data.remainingQuantity === "500.000000", "Batch balance after consumption is incorrect");
assert(afterConsumption.data.currentColorName === "Smoke Brown", "Current color was not updated");
const projectAfterConsumption = await call(`/projects/${project.data.id}`);
assert(projectAfterConsumption.data.requirements[0].actualQuantity === "500.000000", "Project actual quantity is incorrect");
assert(projectAfterConsumption.data.status === "IN_PROGRESS", "First consumption did not start the planned project");

await call(`/consumptions/${consumption.id}/reverse`, { method: "POST", body: { reason: "Automated smoke test reversal" } });
const afterReversal = await call(`/batches/${batch.id}`);
assert(afterReversal.data.remainingQuantity === "1000.000000", "Batch balance after reversal is incorrect");
assert(afterReversal.data.movements[0].type === "REVERSAL", "Reversal movement was not created");

const search = await call(`/materials?${new URLSearchParams({ q: `Smoke Material ${suffix}`, craftType: "GENERAL", color: "Smoke Brown", stockState: "in_stock" })}`);
assert(search.meta.total >= 1, "Material search did not find the smoke-test material");

// 双人复核：超阈值调整暂存 → 另一位操作员批准，与流水写入同事务；重复批准不重复增减余额
const reviewerPassword = process.env.SMOKE_REVIEW_PASSWORD;
if (reviewerPassword) {
  const reviewerLogin = `reviewer_${suffix}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  await call("/users", {
    method: "POST",
    body: { loginName: reviewerLogin, displayName: "Smoke Reviewer", password: reviewerPassword, role: "OPERATOR" }
  });
  const reviewerCookie = { value: "" };
  await call("/auth/login", { method: "POST", cookie: "", captureCookie: reviewerCookie, body: { loginName: reviewerLogin, password: reviewerPassword } });

  const balanceBeforeReview = (await call(`/batches/${batch.id}`)).data.remainingQuantity;
  const staged = await call(`/batches/${batch.id}/adjustments`, {
    method: "POST",
    headers: { "idempotency-key": `smoke-adjust-staged-${suffix}` },
    body: { direction: "OUT", quantity: "500", unit: "g", reason: "Smoke staged over-threshold adjustment", version: afterReversal.data.version }
  });
  assert(staged.meta?.staged === true, "Over-threshold adjustment was not staged for review");
  assert(staged.data.status === "PENDING", "Staged adjustment is not PENDING");
  const requestId = staged.data.id;
  const whilePending = await call(`/batches/${batch.id}`);
  assert(whilePending.data.remainingQuantity === balanceBeforeReview, "Staged adjustment must not change balance");

  // 申请人不能批准本人的调整单
  let selfApproveBlocked = false;
  try {
    await call(`/adjustment-requests/${requestId}/approve`, { method: "POST", body: {} });
  } catch {
    selfApproveBlocked = true;
  }
  assert(selfApproveBlocked, "Requester was allowed to approve their own adjustment");

  // 复核人拒绝该调整单：仅状态变更，余额不变
  await call(`/adjustment-requests/${requestId}/reject`, {
    method: "POST",
    cookie: reviewerCookie.value,
    body: { reason: "Smoke reviewer rejection" }
  });
  const afterReject = await call(`/batches/${batch.id}`);
  assert(afterReject.data.remainingQuantity === balanceBeforeReview, "Rejecting a staged adjustment must not change balance");

  // 再提交一笔真实可执行的大额盘减（超过 10% 阈值）验证批准落账
  const stagedTwo = await call(`/batches/${batch.id}/adjustments`, {
    method: "POST",
    headers: { "idempotency-key": `smoke-adjust-approved-${suffix}` },
    body: { direction: "OUT", quantity: "200", unit: "g", reason: "Smoke approvable over-threshold adjustment", version: afterReject.data.version }
  });
  assert(stagedTwo.meta?.staged === true && stagedTwo.data.status === "PENDING", "Second adjustment was not staged");
  const approveOne = await callWithStatus(`/adjustment-requests/${stagedTwo.data.id}/approve`, {
    method: "POST",
    cookie: reviewerCookie.value,
    body: { note: "Smoke reviewer approval" }
  });
  assert(approveOne.status === 201, "Approval did not settle the adjustment");
  // 重复批准：必须幂等返回 200，且余额不再变化
  const approveTwo = await callWithStatus(`/adjustment-requests/${stagedTwo.data.id}/approve`, {
    method: "POST",
    cookie: reviewerCookie.value,
    body: {}
  });
  assert(approveTwo.status === 200, "Duplicate approval was not idempotent");
  const balanceAfterReview = (await call(`/batches/${batch.id}`)).data;
  assert(balanceAfterReview.remainingQuantity === "800.000000", `Balance after review is ${balanceAfterReview.remainingQuantity}, expected 800.000000`);
  const adjustMovements = balanceAfterReview.movements.filter((m) => m.type === "ADJUSTMENT_OUT");
  assert(adjustMovements.length === 1, `Expected exactly one ADJUSTMENT_OUT movement, got ${adjustMovements.length}`);
}

console.log(JSON.stringify({
  result: "PASS",
  sourceId: source.data.id,
  materialId: material.data.id,
  batchId: batch.id,
  projectId: project.data.id,
  consumptionId: consumption.id
}, null, 2));
