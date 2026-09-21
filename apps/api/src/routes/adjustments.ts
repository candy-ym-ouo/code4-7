import type { FastifyInstance } from "fastify";
import { adjustmentRejectSchema, adjustmentReviewSchema, compareQuantities } from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import { applyAdjustment } from "./batches.js";

type Query = Record<string, string | undefined>;

type PendingRequestRow = {
  id: string;
  batch_id: string;
  direction: "IN" | "OUT";
  quantity: string;
  stock_unit: string;
  before_quantity: string;
  expected_after_quantity: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELED";
  batch_version: number;
  requested_by_user_id: string;
  idempotency_key: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  movement_id: string | null;
  created_at: Date;
};

const SELECT_COLUMNS = `
  ar.id, ar.batch_id AS "batchId", b.batch_code AS "batchCode",
  m.name AS "materialName", m.code AS "materialCode",
  ar.direction, ar.quantity::text AS quantity, ar.stock_unit AS "stockUnit",
  ar.before_quantity::text AS "beforeQuantity", ar.expected_after_quantity::text AS "expectedAfterQuantity",
  ar.reason, ar.status, ar.batch_version AS "batchVersion",
  ar.requested_by_user_id AS "requestedByUserId", requester.display_name AS "requestedByName",
  ar.reviewed_by_user_id AS "reviewedByUserId", reviewer.display_name AS "reviewedByName",
  ar.reviewed_at AS "reviewedAt", ar.review_note AS "reviewNote",
  ar.movement_id AS "movementId", ar.created_at AS "createdAt"`;

const SELECT_FROM = `
  FROM adjustment_requests ar
  JOIN batches b ON b.id = ar.batch_id
  JOIN materials m ON m.id = b.material_id
  LEFT JOIN users requester ON requester.id = ar.requested_by_user_id
  LEFT JOIN users reviewer ON reviewer.id = ar.reviewed_by_user_id`;

export async function adjustmentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/adjustment-requests", async (request) => {
    const status = request.query.status ?? "PENDING";
    if (!["PENDING", "APPROVED", "REJECTED", "CANCELED", "ALL"].includes(status)) {
      throw new AppError(422, "INVALID_STATUS", "调整单状态筛选值无效");
    }
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    let where = "";
    if (status !== "ALL") {
      values.push(status);
      where = `WHERE ar.status = $${values.length}::adjustment_request_status`;
    }
    const totalResult = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count ${SELECT_FROM} ${where}`,
      values
    );
    values.push(pageSize, offset);
    const rows = await pool.query(
      `${SELECT_COLUMNS} ${SELECT_FROM} ${where} ORDER BY ar.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(totalResult.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/adjustment-requests/:id", async (request) => {
    const result = await pool.query(`${SELECT_COLUMNS} ${SELECT_FROM} WHERE ar.id = $1`, [request.params.id]);
    if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "调整单不存在");
    return { data: result.rows[0] };
  });

  // 批准：状态推进（PENDING→APPROVED）、余额更新、流水写入在同一事务完成。
  // 重复批准命中 APPROVED 分支直接返回已写入的流水，绝不会第二次增减余额。
  app.post<{ Params: { id: string } }>("/adjustment-requests/:id/approve", async (request, reply) => {
    const reviewer = (request as AuthenticatedRequest).authUser;
    const input = parseInput(adjustmentReviewSchema, request.body ?? {});
    const approved = await withTransaction(async (client) => {
      // 锁定调整单行，串行化同一张单的并发批准
      const requestResult = await client.query<PendingRequestRow>(
        "SELECT * FROM adjustment_requests WHERE id = $1 FOR UPDATE",
        [request.params.id]
      );
      const adjustment = requestResult.rows[0];
      if (!adjustment) throw new AppError(404, "NOT_FOUND", "调整单不存在");

      if (adjustment.status === "APPROVED") {
        // 幂等：重复批准返回原流水，不重复增减余额
        const existing = await client.query(
          `SELECT id, batch_id AS "batchId", signed_quantity::text AS "signedQuantity",
                  before_quantity::text AS "beforeQuantity", after_quantity::text AS "afterQuantity",
                  adjustment_request_id AS "adjustmentRequestId", created_at AS "createdAt"
             FROM stock_movements WHERE id = $1`,
          [adjustment.movement_id]
        );
        return { idempotent: true, payload: existing.rows[0], statusCode: 200 as const };
      }
      if (adjustment.status !== "PENDING") {
        throw new AppError(409, "ADJUSTMENT_NOT_PENDING", "该调整单已被拒绝或撤销，不能批准");
      }
      if (adjustment.requested_by_user_id === reviewer.id) {
        throw new AppError(403, "REVIEWER_MUST_DIFFER", "复核人不能与申请人为同一操作员");
      }

      // 锁定批次并复核当前余额与版本
      const batchResult = await client.query<{
        id: string; version: number; status: string; remaining_quantity: string; stock_unit: string; material_id: string;
      }>("SELECT * FROM batches WHERE id = $1 FOR UPDATE", [adjustment.batch_id]);
      const batch = batchResult.rows[0];
      if (!batch) throw new AppError(404, "NOT_FOUND", "批次不存在");
      if (batch.status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", "批次已归档，不能调整");
      if (batch.version !== adjustment.batch_version) {
        throw new AppError(409, "VERSION_CONFLICT", "批次在调整单提交后已被其他操作修改，请拒绝后由申请人重新发起");
      }
      if (compareQuantities(batch.remaining_quantity, adjustment.before_quantity) !== 0) {
        throw new AppError(409, "BALANCE_CHANGED", "批次结余已变化，请拒绝后由申请人按当前结余重新发起");
      }

      // 同一事务内落账：更新余额 + 写流水（与阈值内直接调整共用逻辑）
      const movement = await applyAdjustment(client, {
        batch: { id: batch.id, stock_unit: batch.stock_unit, remaining_quantity: batch.remaining_quantity },
        direction: adjustment.direction,
        quantity: adjustment.quantity,
        reason: adjustment.reason,
        actorUserId: reviewer.id,
        requestId: request.id,
        adjustmentRequestId: adjustment.id,
        idempotencyKey: adjustment.idempotency_key
      });

      // 状态推进与回链；movement_id 非空即“已入账”凭证
      const update = await client.query(
        `UPDATE adjustment_requests
            SET status = 'APPROVED', reviewed_by_user_id = $2, reviewed_at = now(),
                review_note = $3, movement_id = $4
          WHERE id = $1 AND status = 'PENDING'
          RETURNING id, status, reviewed_at AS "reviewedAt"`,
        [adjustment.id, reviewer.id, input.note ?? null, movement.id as string]
      );
      if (!update.rows[0]) {
        // 竞态兜底：并发事务已改变状态，抛出错误让事务回滚，余额与流水一并撤销
        throw new AppError(409, "ADJUSTMENT_NOT_PENDING", "该调整单状态已变化，请刷新后重试");
      }

      await writeAudit(client, {
        actorUserId: reviewer.id,
        action: "ADJUSTMENT_APPROVE",
        entityType: "BATCH",
        entityId: batch.id,
        beforeData: {
          adjustmentRequestId: adjustment.id,
          beforeQuantity: adjustment.before_quantity,
          expectedAfterQuantity: adjustment.expected_after_quantity
        },
        afterData: {
          adjustmentRequestId: adjustment.id,
          movementId: movement.id,
          note: input.note ?? null
        },
        requestId: request.id
      });
      return { idempotent: false, payload: { ...movement, adjustmentRequestId: adjustment.id }, statusCode: 201 as const };
    });
    return reply.status(approved.statusCode).send({ data: approved.payload });
  });

  // 拒绝：仅推进状态，绝不触碰余额
  app.post<{ Params: { id: string } }>("/adjustment-requests/:id/reject", async (request, reply) => {
    const reviewer = (request as AuthenticatedRequest).authUser;
    const input = parseInput(adjustmentRejectSchema, request.body);
    await withTransaction(async (client) => {
      const requestResult = await client.query<PendingRequestRow>(
        "SELECT * FROM adjustment_requests WHERE id = $1 FOR UPDATE",
        [request.params.id]
      );
      const adjustment = requestResult.rows[0];
      if (!adjustment) throw new AppError(404, "NOT_FOUND", "调整单不存在");
      if (adjustment.status !== "PENDING") {
        throw new AppError(409, "ADJUSTMENT_NOT_PENDING", "只能拒绝待复核的调整单");
      }
      if (adjustment.requested_by_user_id === reviewer.id) {
        throw new AppError(403, "REVIEWER_MUST_DIFFER", "复核人不能与申请人为同一操作员");
      }
      await client.query(
        `UPDATE adjustment_requests
            SET status = 'REJECTED', reviewed_by_user_id = $2, reviewed_at = now(), review_note = $3
          WHERE id = $1 AND status = 'PENDING'`,
        [adjustment.id, reviewer.id, input.reason]
      );
      await writeAudit(client, {
        actorUserId: reviewer.id,
        action: "ADJUSTMENT_REJECT",
        entityType: "BATCH",
        entityId: adjustment.batch_id,
        afterData: { adjustmentRequestId: adjustment.id, reason: input.reason },
        requestId: request.id
      });
    });
    return reply.status(204).send();
  });

  // 申请人撤销自己尚未复核的调整单
  app.post<{ Params: { id: string } }>("/adjustment-requests/:id/cancel", async (request, reply) => {
    const actor = (request as AuthenticatedRequest).authUser;
    await withTransaction(async (client) => {
      const requestResult = await client.query<PendingRequestRow>(
        "SELECT * FROM adjustment_requests WHERE id = $1 FOR UPDATE",
        [request.params.id]
      );
      const adjustment = requestResult.rows[0];
      if (!adjustment) throw new AppError(404, "NOT_FOUND", "调整单不存在");
      if (adjustment.status !== "PENDING") {
        throw new AppError(409, "ADJUSTMENT_NOT_PENDING", "只能撤销待复核的调整单");
      }
      if (adjustment.requested_by_user_id !== actor.id) {
        throw new AppError(403, "NOT_REQUESTER", "只能撤销本人提交的调整单");
      }
      await client.query(
        `UPDATE adjustment_requests
            SET status = 'CANCELED', reviewed_at = now(), review_note = '申请人撤销'
          WHERE id = $1 AND status = 'PENDING'`,
        [adjustment.id]
      );
      await writeAudit(client, {
        actorUserId: actor.id,
        action: "ADJUSTMENT_CANCEL",
        entityType: "BATCH",
        entityId: adjustment.batch_id,
        afterData: { adjustmentRequestId: adjustment.id },
        requestId: request.id
      });
    });
    return reply.status(204).send();
  });
}
