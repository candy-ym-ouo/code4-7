# API 文档

## 1. 基础约定

- 基础路径：`/api/v1`
- 请求与响应：JSON，附件上传除外。
- 数量：十进制字符串，例如 `"500.000000"`。
- 时间：ISO 8601，推荐包含时区偏移。
- 会话：HttpOnly Cookie `handcraft_session`。
- 分页：`page`、`pageSize`，最大 100。
- 幂等：批次入库、库存调整和材料消耗支持 `Idempotency-Key`。
- 乐观锁：更新请求携带 `version`。
- 差异阈值：库存调整幅度 `|调整数量| / 调整前结余` 超过
  `ADJUSTMENT_REVIEW_THRESHOLD_RATIO`（默认 0.1）时不直接入账，而是生成
  `PENDING` 调整单等待第二位操作员复核；调整前结余为 0 时一律需要复核。

成功响应：

```json
{ "data": {}, "meta": {} }
```

错误响应：

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "批次剩余数量不足",
    "fieldErrors": {},
    "requestId": "..."
  }
}
```

## 2. 认证与操作员

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/setup/status` | 查询是否完成初始化 |
| POST | `/setup` | 创建首位管理员 |
| POST | `/auth/login` | 账号密码登录 |
| POST | `/auth/logout` | 退出 |
| GET | `/auth/me` | 当前操作员 |
| POST | `/auth/password` | 修改密码 |
| GET/POST | `/users` | 操作员列表 / 新增（仅管理员） |
| POST | `/users/:id/deactivate` | 停用操作员（仅管理员） |

系统支持多名操作员（`ADMIN` / `OPERATOR`）。超阈值结余调整的复核人必须
**不是**调整申请人；已停用账号的会话立即失效。

初始化请求：

```json
{
  "loginName": "admin",
  "displayName": "工作室管理员",
  "password": "至少10位密码"
}
```

登录请求：

```json
{ "loginName": "admin", "password": "操作员密码" }
```

`loginName` 须以字母开头，由 3-40 位字母、数字、下划线或连字符组成。

## 3. 来源与位置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/sources` | 查询或创建来源 |
| GET/PATCH | `/sources/:id` | 详情或更新 |
| POST | `/sources/:id/archive` | 归档 |
| POST | `/sources/:id/unarchive` | 取消归档 |
| GET/POST | `/locations` | 查询或创建位置 |
| PATCH | `/locations/:id` | 更新位置 |
| POST | `/locations/:id/archive` | 归档位置 |

## 4. 材料

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/materials` | 聚合库存查询或创建 |
| GET/PATCH | `/materials/:id` | 详情或更新 |
| GET | `/materials/:id/batches` | 材料批次 |
| POST | `/materials/:id/archive` | 归档 |

材料列表查询参数：

- `q`
- `craftType`
- `sourceId`
- `locationId`
- `batchCode`
- `color`
- `stockState=in_stock|low_stock|out_of_stock`
- `expiryBefore`
- `tag`
- `sort`

创建材料：

```json
{
  "code": "DYE-SUMU",
  "name": "苏木染材",
  "craftTypes": ["DYEING"],
  "subtype": "天然染料",
  "stockUnit": "g",
  "lowStockThreshold": "200",
  "defaultColorName": "原木棕",
  "defaultColorHex": "#8B5A2B",
  "tags": ["天然", "染布"]
}
```

## 5. 批次与库存

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/batches` | 批次查询或入库 |
| GET/PATCH | `/batches/:id` | 详情或非库存字段更新 |
| GET | `/batches/:id/movements` | 库存流水 |
| POST | `/batches/:id/adjustments` | 库存调整（阈值内直接入账，超阈值暂存待复核） |
| POST | `/batches/:id/archive` | 归档无余额批次 |
| GET | `/adjustment-requests` | 调整单列表，`status=PENDING/APPROVED/REJECTED/CANCELED/ALL` |
| GET | `/adjustment-requests/:id` | 调整单详情 |
| POST | `/adjustment-requests/:id/approve` | 复核批准并入账（非申请人） |
| POST | `/adjustment-requests/:id/reject` | 复核拒绝（非申请人） |
| POST | `/adjustment-requests/:id/cancel` | 申请人撤销待复核单 |

创建批次：

```json
{
  "materialId": "uuid",
  "batchCode": "B-20260913-01",
  "sourceId": "uuid",
  "receivedAt": "2026-09-13",
  "initialQuantity": "1",
  "entryUnit": "kg",
  "totalCost": "120.00",
  "currency": "CNY"
}
```

库存调整：

```json
{
  "direction": "OUT",
  "quantity": "30",
  "unit": "g",
  "reason": "盘点发现包装破损",
  "version": 1
}
```

同一 `Idempotency-Key` 重试不会重复调整。

**阈值内调整**：返回 `201`，响应 `meta.staged` 为 `false`，余额立即更新并写入流水。

**超阈值调整**：返回 `202`，`meta.staged` 为 `true`，余额与流水均不变，响应体是一张
`PENDING` 调整单：

```json
{
  "data": {
    "id": "uuid",
    "batchId": "uuid",
    "direction": "OUT",
    "quantity": "300.000000",
    "stockUnit": "g",
    "beforeQuantity": "1000.000000",
    "expectedAfterQuantity": "700.000000",
    "reason": "盘点发现包装破损",
    "status": "PENDING",
    "requestedByUserId": "uuid"
  },
  "meta": { "staged": true, "reviewThresholdRatio": 0.1 }
}
```

复核规则：

- 批准（`POST /adjustment-requests/:id/approve`，可带 `{ "note": "..." }`）：
  在**同一事务**内完成「状态 PENDING→APPROVED、更新批次余额、写入库存流水」。
  复核人不能是申请人；批次在提交后已变化（版本或余额不符）时拒绝批准。
- 重复批准是幂等的：已 `APPROVED` 的调整单再次批准返回 `200` 和原流水，
  **绝不会第二次增减余额**（状态机、调整单行锁、流水 `adjustment_request_id`
  唯一索引三重保证）。
- 拒绝（`POST /adjustment-requests/:id/reject`，`{ "reason": "至少3字" }`）：
  只关闭调整单，不触碰余额；复核人不能是申请人。
- 申请人可对仍待复核的单据调用 `cancel` 撤销。

## 6. 项目与需求

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/projects` | 查询或创建项目 |
| GET/PATCH | `/projects/:id` | 详情或更新 |
| POST | `/projects/:id/status` | 更新状态 |
| POST | `/projects/:id/archive` | 归档 |
| POST | `/projects/:id/requirements` | 添加材料需求 |
| PATCH | `/projects/:id/requirements/:requirementId` | 更新需求 |
| DELETE | `/projects/:id/requirements/:requirementId` | 删除未使用需求 |

材料需求：

```json
{
  "materialId": "uuid",
  "requiredQuantity": "0.5",
  "unit": "kg",
  "purpose": "染液"
}
```

## 7. 消耗与撤销

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/consumptions` | 查询或创建消耗 |
| GET | `/consumptions/:id` | 消耗详情 |
| POST | `/consumptions/:id/reverse` | 撤销 |

首次为计划中的项目创建消耗时，项目会自动转为 `IN_PROGRESS` 并记录审计日志。

创建消耗：

```json
{
  "projectId": "uuid",
  "projectRequirementId": "uuid",
  "batchId": "uuid",
  "usedQuantity": "450",
  "wasteQuantity": "50",
  "unit": "g",
  "consumedAt": "2026-09-13T10:00:00+08:00",
  "purpose": "染液"
}
```

撤销：

```json
{
  "reason": "录入批次错误"
}
```

## 8. 颜色变化

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/color-changes` | 查询或记录 |
| GET/PATCH | `/color-changes/:id` | 详情或更新备注 |
| DELETE | `/color-changes/:id` | 删除最新误录记录 |

颜色变化：

```json
{
  "batchId": "uuid",
  "projectId": "uuid",
  "changeType": "DYE_BATH",
  "afterColorName": "深红棕",
  "afterColorHex": "#6B2F1F",
  "affectedQuantity": "450",
  "unit": "g",
  "occurredAt": "2026-09-13T10:05:00+08:00",
  "phValue": 5.5
}
```

颜色变化不扣库存。

## 9. 附件和导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/attachments` | multipart 上传 |
| GET | `/attachments/:id` | 受保护下载 |
| DELETE | `/attachments/:id` | 删除 |
| GET | `/exports/materials.csv` | 材料 CSV |
| GET | `/exports/batches.csv` | 批次 CSV |
| GET | `/exports/workspace.json` | 完整 JSON |
| GET | `/audit-logs` | 审计日志 |
| GET | `/dashboard` | 仪表盘 |

附件表单字段：

- `ownerType`：`BATCH`、`COLOR_CHANGE`、`PROJECT` 或 `CONSUMPTION`
- `ownerId`
- `file`

支持 JPEG、PNG、WebP，默认最大 10 MB。
