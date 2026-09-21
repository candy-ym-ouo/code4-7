const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
const configuredPassword = process.env.SMOKE_PASSWORD;
if (!configuredPassword) {
  throw new Error("SMOKE_PASSWORD is required");
}
let cookie = "";

async function callWithStatus(path, options = {}) {
  const { cookie: cookieOverride, ...rest } = options;
  const headers = new Headers(rest.headers);
  const activeCookie = cookieOverride ?? cookie;
  if (activeCookie) headers.set("cookie", activeCookie);
  if (rest.body !== undefined && !(rest.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    ...rest,
    headers,
    body: rest.body instanceof FormData ? rest.body : rest.body === undefined ? undefined : JSON.stringify(rest.body)
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie && cookieOverride === undefined) cookie = setCookie.split(";")[0];
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(`${rest.method ?? "GET"} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
    error.status = response.status;
    throw error;
  }
  return { status: response.status, data: payload };
}

async function login(password) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`login -> ${response.status} ${JSON.stringify(payload)}`);
  return response.headers.get("set-cookie").split(";")[0];
}

async function call(path, options = {}) {
  return (await callWithStatus(path, options)).data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const status = await call("/setup/status");
if (!status.data.initialized) {
  await call("/setup", { method: "POST", body: { displayName: "Smoke Test Operator", password: configuredPassword } });
  console.log("Initialized a new empty workspace.");
} else {
  await call("/auth/login", { method: "POST", body: { password: configuredPassword } });
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
    adjustmentReviewThreshold: "100",
    adjustmentReviewThreshold: "100",
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

// 调整复核链：阈值内直接入账，超限暂存，双人复核后入账，重复批准不动账。
const smallAdjustment = await callWithStatus(`/batches/${batch.id}/adjustments`, {
  method: "POST",
  headers: { "idempotency-key": `smoke-adjust-small-${suffix}` },
  body: { direction: "IN", quantity: "50", unit: "g", reason: "Smoke small adjustment", version: afterReversal.data.version }
});
assert(smallAdjustment.status === 201 && smallAdjustment.data.data.kind === "POSTED", "Under-threshold adjustment should post directly");

const afterSmallAdjustment = await call(`/batches/${batch.id}`);
assert(afterSmallAdjustment.data.remainingQuantity === "1050.000000", "Small adjustment balance is incorrect");

const staged = await callWithStatus(`/batches/${batch.id}/adjustments`, {
  method: "POST",
  headers: { "idempotency-key": `smoke-adjust-large-${suffix}` },
  body: { direction: "OUT", quantity: "200", unit: "g", reason: "Smoke large adjustment", version: afterSmallAdjustment.data.version }
});
assert(staged.status === 202 && staged.data.data.kind === "PENDING_REVIEW", "Over-threshold adjustment should be staged for review");
const stagedId = staged.data.data.id;

const stagedRetry = await callWithStatus(`/batches/${batch.id}/adjustments`, {
  method: "POST",
  headers: { "idempotency-key": `smoke-adjust-large-${suffix}` },
  body: { direction: "OUT", quantity: "200", unit: "g", reason: "Smoke large adjustment", version: afterSmallAdjustment.data.version }
});
assert(stagedRetry.status === 200 && stagedRetry.data.data.id === stagedId, "Staged adjustment idempotency returned a different request");

const duringReview = await call(`/batches/${batch.id}`);
assert(duringReview.data.remainingQuantity === "1050.000000", "Staged adjustment must not change the balance");
assert(duringReview.data.pendingAdjustments.length === 1, "Pending adjustment is not listed on the batch");

const selfApprove = await callWithStatus(`/adjustment-requests/${stagedId}/approve`, {
  method: "POST",
  body: { password: configuredPassword }
}).catch((error) => error);
assert(selfApprove.status === 409, "Approving from the creator session must be rejected");

const reviewerCookie = await login(configuredPassword);
const wrongPassword = await callWithStatus(`/adjustment-requests/${stagedId}/approve`, {
  method: "POST",
  cookie: reviewerCookie,
  body: { password: "wrong-review-password" }
}).catch((error) => error);
assert(wrongPassword.status === 401, "Wrong review password must be rejected");

const approved = await callWithStatus(`/adjustment-requests/${stagedId}/approve`, {
  method: "POST",
  cookie: reviewerCookie,
  body: { password: configuredPassword, note: "Smoke review approved" }
});
assert(approved.status === 200 && approved.data.data.status === "APPROVED", "Second-person approval failed");
const afterApprove = await call(`/batches/${batch.id}`);
assert(afterApprove.data.remainingQuantity === "850.000000", "Approved adjustment balance is incorrect");

const repeatedApprove = await callWithStatus(`/adjustment-requests/${stagedId}/approve`, {
  method: "POST",
  cookie: reviewerCookie,
  body: { password: configuredPassword }
}).catch((error) => error);
assert(repeatedApprove.status === 409, "Repeated approval must be rejected");
const afterRepeatedApprove = await call(`/batches/${batch.id}`);
assert(afterRepeatedApprove.data.remainingQuantity === "850.000000", "Repeated approval must not change the balance again");

const stagedIn = await callWithStatus(`/batches/${batch.id}/adjustments`, {
  method: "POST",
  headers: { "idempotency-key": `smoke-adjust-reject-${suffix}` },
  body: { direction: "IN", quantity: "300", unit: "g", reason: "Smoke rejected adjustment", version: afterRepeatedApprove.data.version }
});
assert(stagedIn.status === 202, "Second large adjustment should be staged");
const rejected = await callWithStatus(`/adjustment-requests/${stagedIn.data.data.id}/reject`, {
  method: "POST",
  cookie: reviewerCookie,
  body: { password: configuredPassword, note: "Smoke review rejected" }
});
assert(rejected.status === 200 && rejected.data.data.status === "REJECTED", "Second-person rejection failed");

const afterReject = await call(`/batches/${batch.id}`);
assert(afterReject.data.remainingQuantity === "850.000000", "Rejected adjustment must not change the balance");
const adjustmentOuts = afterReject.data.movements.filter((movement) => movement.type === "ADJUSTMENT_OUT");
assert(adjustmentOuts.length === 1, "Expected exactly one ADJUSTMENT_OUT movement after the review chain");
assert(adjustmentOuts[0].referenceType === "ADJUSTMENT_REQUEST", "Approved adjustment movement should reference the review request");

const approvedList = await call("/adjustment-requests?status=APPROVED");
assert(approvedList.data.some((item) => item.id === stagedId), "Approved request is missing from the review list");

const search = await call(`/materials?${new URLSearchParams({ q: `Smoke Material ${suffix}`, craftType: "GENERAL", color: "Smoke Brown", stockState: "in_stock" })}`);
assert(search.meta.total >= 1, "Material search did not find the smoke-test material");

console.log(JSON.stringify({
  result: "PASS",
  sourceId: source.data.id,
  materialId: material.data.id,
  batchId: batch.id,
  projectId: project.data.id,
  consumptionId: consumption.id
}, null, 2));
