import type { FastifyInstance } from "fastify";
import { addQuantities, adjustmentReviewSchema, compareQuantities, subtractQuantities } from "@handcraft/contracts";
import { verifyPassword, type AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction, type DbClient } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import { getIdempotencyKey } from "../lib/idempotency.js";

type Query = Record<string, string | undefined>;

type LockedRequest = {
  id: string;
  batch_id: string;
  material_id: string;
  direction: "IN" | "OUT";
  quantity: string;
  stock_unit: string;
  reason: string;
  threshold: string;
  status: string;
  created_by: string;
  created_session_id: string;
  remaining_quantity: string;
  batch_status: string;
};

async function lockRequestForReview(client: DbClient, id: string): Promise<LockedRequest> {
  const result = await client.query<LockedRequest>(
    `SELECT r.id, r.batch_id, b.material_id, r.direction, r.quantity::text AS quantity, r.stock_unit,
            r.reason, r.threshold::text AS threshold, r.status, r.created_by, r.created_session_id,
            b.remaining_quantity, b.status AS batch_status
       FROM adjustment_requests r
       JOIN batches b ON b.id = r.batch_id
      WHERE r.id = $1
      FOR UPDATE OF r, b`,
    [id]
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, "NOT_FOUND", "调整复核请求不存在");
  if (row.status !== "PENDING") throw new AppError(409, "ALREADY_REVIEWED", "该调整请求已完成复核，不会重复处理");
  return row;
}

async function assertSecondPerson(
  client: DbClient,
  pending: LockedRequest,
  user: { id: string; sessionId: string },
  password: string
): Promise<void> {
  if (pending.created_session_id === user.sessionId) {
    throw new AppError(409, "SELF_REVIEW_NOT_ALLOWED", "库存调整需双人复核：请复核人退出当前会话、重新登录后再处理");
  }
  const account = await client.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [user.id]);
  const passwordHash = account.rows[0]?.password_hash;
  if (!passwordHash || !(await verifyPassword(passwordHash, password))) {
    throw new AppError(401, "INVALID_REVIEW_PASSWORD", "复核密码错误");
  }
}

export async function adjustmentRequestRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/adjustment-requests", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions = ["1 = 1"];
    if (request.query.status) {
      if (!["PENDING", "APPROVED", "REJECTED"].includes(request.query.status)) {
        throw new AppError(422, "INVALID_REVIEW_STATUS", "复核状态筛选值无效");
      }
      values.push(request.query.status);
      conditions.push(`r.status = $${values.length}::adjustment_request_status`);
    }
    if (request.query.batchId) {
      values.push(request.query.batchId);
      conditions.push(`r.batch_id = $${values.length}::uuid`);
    }
    const where = conditions.join(" AND ");
    const base = `FROM adjustment_requests r
      JOIN batches b ON b.id = r.batch_id
      JOIN materials m ON m.id = b.material_id
      JOIN users creator ON creator.id = r.created_by
      LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
      WHERE ${where}`;
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count ${base}`, values);
    values.push(user.sessionId, pageSize, offset);
    const rows = await pool.query(
      `SELECT r.id, r.batch_id AS "batchId", b.batch_code AS "batchCode", m.id AS "materialId", m.name AS "materialName",
              r.direction, r.quantity::text AS "quantity", r.stock_unit AS "stockUnit", r.reason,
              r.threshold::text AS "threshold", r.status, r.review_note AS "reviewNote",
              creator.display_name AS "createdByName", reviewer.display_name AS "reviewedByName",
              r.reviewed_at AS "reviewedAt", r.created_at AS "createdAt",
              (r.created_session_id = $${values.length - 2}) AS "createdByCurrentSession"
         ${base}
        ORDER BY CASE WHEN r.status = 'PENDING' THEN 0 ELSE 1 END, r.created_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.post<{ Params: { id: string } }>("/adjustment-requests/:id/approve", async (request) => {
    const input = parseInput(adjustmentReviewSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const idempotencyKey = getIdempotencyKey(request.headers);
    const approved = await withTransaction(async (client) => {
      const pending = await lockRequestForReview(client, request.params.id);
      await assertSecondPerson(client, pending, user, input.password);
      if (pending.batch_status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", "已归档批次不能调整");
      const material = await client.query("SELECT id FROM materials WHERE id = $1 AND archived_at IS NULL FOR SHARE", [pending.material_id]);
      if (!material.rowCount) throw new AppError(409, "MATERIAL_ARCHIVED", "材料已归档，不能调整其批次库存");
      const before = pending.remaining_quantity;
      if (pending.direction === "OUT" && compareQuantities(pending.quantity, before) > 0) {
        throw new AppError(409, "INSUFFICIENT_STOCK", "批次剩余数量不足，该调整请求仍保持待复核");
      }
      const signed = pending.direction === "IN" ? pending.quantity : `-${pending.quantity}`;
      const after = pending.direction === "IN" ? addQuantities(before, pending.quantity) : subtractQuantities(before, pending.quantity);
      const batchStatus = compareQuantities(after, "0") === 0 ? "DEPLETED" : "ACTIVE";
      await client.query("UPDATE batches SET remaining_quantity = $1, status = $2, version = version + 1 WHERE id = $3", [after, batchStatus, pending.batch_id]);
      const movement = await client.query(
        `INSERT INTO stock_movements(batch_id, type, signed_quantity, stock_unit, before_quantity, after_quantity,
           reference_type, reference_id, reason, actor_user_id, idempotency_key)
         VALUES ($1, $2, $3, $4::stock_unit, $5, $6, 'ADJUSTMENT_REQUEST', $7, $8, $9, $10)
         RETURNING id, signed_quantity::text AS "signedQuantity", before_quantity::text AS "beforeQuantity",
                   after_quantity::text AS "afterQuantity", created_at AS "createdAt"`,
        [pending.batch_id, pending.direction === "IN" ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT", signed, pending.stock_unit,
         before, after, pending.id, pending.reason, user.id, idempotencyKey ?? null]
      );
      const updated = await client.query(
        `UPDATE adjustment_requests
            SET status = 'APPROVED', reviewed_by = $1, reviewed_session_id = $2, reviewed_at = now(),
                review_note = $3, stock_movement_id = $4
          WHERE id = $5
          RETURNING id, batch_id AS "batchId", status, reviewed_at AS "reviewedAt", review_note AS "reviewNote"`,
        [user.id, user.sessionId, input.note ?? null, movement.rows[0]?.id ?? null, pending.id]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "ADJUST_APPROVE", entityType: "ADJUSTMENT_REQUEST", entityId: pending.id,
        beforeData: { status: "PENDING", remainingQuantity: before },
        afterData: { status: "APPROVED", remainingQuantity: after, movementId: movement.rows[0]?.id, note: input.note ?? null },
        requestId: request.id
      });
      return { ...updated.rows[0], movement: movement.rows[0] };
    });
    return { data: approved };
  });

  app.post<{ Params: { id: string } }>("/adjustment-requests/:id/reject", async (request) => {
    const input = parseInput(adjustmentReviewSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const rejected = await withTransaction(async (client) => {
      const pending = await lockRequestForReview(client, request.params.id);
      await assertSecondPerson(client, pending, user, input.password);
      const updated = await client.query(
        `UPDATE adjustment_requests
            SET status = 'REJECTED', reviewed_by = $1, reviewed_session_id = $2, reviewed_at = now(), review_note = $3
          WHERE id = $4
          RETURNING id, batch_id AS "batchId", status, reviewed_at AS "reviewedAt", review_note AS "reviewNote"`,
        [user.id, user.sessionId, input.note ?? null, pending.id]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "ADJUST_REJECT", entityType: "ADJUSTMENT_REQUEST", entityId: pending.id,
        beforeData: { status: "PENDING" },
        afterData: { status: "REJECTED", note: input.note ?? null },
        requestId: request.id
      });
      return updated.rows[0];
    });
    return { data: rejected };
  });
}
