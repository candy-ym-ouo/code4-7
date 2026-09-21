import type { FastifyInstance } from "fastify";
import { loginSchema, passwordChangeSchema, setupSchema, userCreateSchema } from "@handcraft/contracts";
import { hashPassword, verifyPassword, createSession, setSessionCookie, revokeSession, hashSessionToken, authenticate, requireAdmin, type AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { parseInput } from "../lib/validation.js";
import { config } from "../config.js";
import { writeAudit } from "../lib/audit.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/setup/status", async () => {
    const result = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM users");
    return { data: { initialized: Number(result.rows[0]?.count ?? 0) > 0 } };
  });

  app.post("/setup", async (request, reply) => {
    const input = parseInput(setupSchema, request.body);
    const passwordHash = await hashPassword(input.password);
    const user = await withTransaction(async (client) => {
      const existing = await client.query("SELECT id FROM users LIMIT 1 FOR UPDATE");
      if (existing.rowCount) {
        throw new AppError(409, "ALREADY_INITIALIZED", "应用已经完成初始化");
      }
      const created = await client.query<{ id: string; login_name: string; display_name: string }>(
        `INSERT INTO users(login_name, display_name, password_hash, role)
         VALUES ($1, $2, $3, 'ADMIN')
         RETURNING id, login_name, display_name`,
        [input.loginName, input.displayName, passwordHash]
      );
      const row = created.rows[0];
      if (!row) {
        throw new AppError(500, "USER_CREATE_FAILED", "操作员创建失败");
      }
      await writeAudit(client, {
        actorUserId: row.id,
        action: "CREATE",
        entityType: "USER",
        entityId: row.id,
        afterData: { loginName: row.login_name, displayName: row.display_name, role: "ADMIN" },
        requestId: request.id
      });
      return row;
    });

    const session = await createSession(user.id);
    setSessionCookie(reply, session.token, session.expiresAt, config.COOKIE_SECURE);
    return reply.status(201).send({ data: { id: user.id, loginName: user.login_name, displayName: user.display_name, role: "ADMIN" } });
  });

  app.post(
    "/auth/login",
    {
      config: {
        rateLimit: {
          max: 8,
          timeWindow: "15 minutes"
        }
      }
    },
    async (request, reply) => {
      const input = parseInput(loginSchema, request.body);
      const authenticated = await withTransaction(async (client) => {
        const result = await client.query<{ id: string; login_name: string; display_name: string; role: "ADMIN" | "OPERATOR"; password_hash: string; deactivated_at: Date | null }>(
          "SELECT id, login_name, display_name, role, password_hash, deactivated_at FROM users WHERE login_name = $1 FOR SHARE",
          [input.loginName]
        );
        const user = result.rows[0];
        if (!user || !(await verifyPassword(user.password_hash, input.password))) {
          throw new AppError(401, "INVALID_CREDENTIALS", "账号或密码错误");
        }
        if (user.deactivated_at) {
          throw new AppError(403, "ACCOUNT_DEACTIVATED", "该操作员账号已停用");
        }
        const session = await createSession(user.id, client);
        await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
        return { user, session };
      });

      setSessionCookie(reply, authenticated.session.token, authenticated.session.expiresAt, config.COOKIE_SECURE);
      return { data: { id: authenticated.user.id, loginName: authenticated.user.login_name, displayName: authenticated.user.display_name, role: authenticated.user.role } };
    }
  );

  app.post("/auth/logout", async (request, reply) => {
    await revokeSession(request);
    reply.clearCookie("handcraft_session", { path: "/" });
    return reply.status(204).send();
  });

  app.get("/auth/me", async (request) => {
    const token = request.cookies.handcraft_session;
    if (!token) {
      throw new AppError(401, "UNAUTHENTICATED", "请先登录");
    }
    const result = await pool.query<{ id: string; loginName: string; displayName: string; role: "ADMIN" | "OPERATOR" }>(
      `SELECT u.id, u.login_name AS "loginName", u.display_name AS "displayName", u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL AND s.expires_at > now() AND u.deactivated_at IS NULL`,
      [hashSessionToken(token)]
    );
    const user = result.rows[0];
    if (!user) {
      throw new AppError(401, "SESSION_EXPIRED", "登录已失效，请重新登录");
    }
    return { data: user };
  });

  app.post("/auth/password", { preHandler: authenticate }, async (request, reply) => {
    const user = (request as AuthenticatedRequest).authUser;
    const input = parseInput(passwordChangeSchema, request.body);
    await withTransaction(async (client) => {
      const result = await client.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id = $1 FOR UPDATE",
        [user.id]
      );
      const current = result.rows[0];
      if (!current || !(await verifyPassword(current.password_hash, input.currentPassword))) {
        throw new AppError(401, "INVALID_CURRENT_PASSWORD", "当前密码错误");
      }
      const nextHash = await hashPassword(input.newPassword);
      await client.query("UPDATE users SET password_hash = $1 WHERE id = $2", [nextHash, user.id]);
      await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
      await writeAudit(client, {
        actorUserId: user.id,
        action: "UPDATE_PASSWORD",
        entityType: "USER",
        entityId: user.id,
        requestId: request.id
      });
    });
    reply.clearCookie("handcraft_session", { path: "/" });
    return reply.status(204).send();
  });

  // 操作员管理（仅管理员）
  app.get("/users", { preHandler: authenticate }, async (request) => {
    requireAdmin(request);
    const result = await pool.query(
      `SELECT id, login_name AS "loginName", display_name AS "displayName", role,
              deactivated_at AS "deactivatedAt", last_login_at AS "lastLoginAt", created_at AS "createdAt"
         FROM users ORDER BY created_at`
    );
    return { data: result.rows };
  });

  app.post("/users", { preHandler: authenticate }, async (request, reply) => {
    const admin = requireAdmin(request);
    const input = parseInput(userCreateSchema, request.body);
    const passwordHash = await hashPassword(input.password);
    const created = await withTransaction(async (client) => {
      const duplicate = await client.query("SELECT id FROM users WHERE login_name = $1", [input.loginName]);
      if (duplicate.rowCount) {
        throw new AppError(409, "DUPLICATE_LOGIN_NAME", "登录账号已存在");
      }
      const result = await client.query<{ id: string }>(
        `INSERT INTO users(login_name, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.loginName, input.displayName, passwordHash, input.role]
      );
      const row = result.rows[0];
      if (!row) throw new AppError(500, "USER_CREATE_FAILED", "操作员创建失败");
      await writeAudit(client, {
        actorUserId: admin.id,
        action: "CREATE",
        entityType: "USER",
        entityId: row.id,
        afterData: { loginName: input.loginName, displayName: input.displayName, role: input.role },
        requestId: request.id
      });
      return row.id;
    });
    return reply.status(201).send({ data: { id: created } });
  });

  app.post<{ Params: { id: string } }>("/users/:id/deactivate", { preHandler: authenticate }, async (request, reply) => {
    const admin = requireAdmin(request);
    await withTransaction(async (client) => {
      const target = await client.query<{ deactivated_at: Date | null }>(
        "SELECT deactivated_at FROM users WHERE id = $1 FOR UPDATE",
        [request.params.id]
      );
      if (!target.rows[0]) throw new AppError(404, "NOT_FOUND", "操作员不存在");
      if (target.rows[0].deactivated_at) throw new AppError(409, "USER_DEACTIVATED", "该操作员已停用");
      if (request.params.id === admin.id) {
        throw new AppError(409, "CANNOT_DEACTIVATE_SELF", "不能停用当前登录账号");
      }
      await client.query(
        "UPDATE users SET deactivated_at = now() WHERE id = $1",
        [request.params.id]
      );
      await client.query(
        "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [request.params.id]
      );
      await writeAudit(client, {
        actorUserId: admin.id,
        action: "DEACTIVATE",
        entityType: "USER",
        entityId: request.params.id,
        requestId: request.id
      });
    });
    return reply.status(204).send();
  });
}
