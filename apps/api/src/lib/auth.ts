import { createHmac, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hash, verify, Algorithm } from "@node-rs/argon2";
import { pool, type DbClient } from "./db.js";
import { AppError } from "./errors.js";
import { config } from "../config.js";

const SESSION_DAYS = 7;

export type AuthUser = {
  id: string;
  loginName: string;
  displayName: string;
  role: "ADMIN" | "OPERATOR";
};

export type AuthenticatedRequest = FastifyRequest & { authUser: AuthUser };

export function hashSessionToken(token: string): string {
  return createHmac("sha256", config.SESSION_SECRET).update(token).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

type QueryExecutor = Pick<DbClient, "query">;

export async function createSession(userId: string, executor: QueryExecutor = pool): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await executor.query(
    "INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, hashSessionToken(token), expiresAt]
  );
  return { token, expiresAt };
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean): void {
  reply.setCookie("handcraft_session", token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: expiresAt
  });
}

export async function authenticate(request: FastifyRequest): Promise<void> {
  const token = request.cookies.handcraft_session;
  if (!token) {
    throw new AppError(401, "UNAUTHENTICATED", "请先登录");
  }

  const result = await pool.query<{
    id: string;
    login_name: string;
    display_name: string;
    role: "ADMIN" | "OPERATOR";
    deactivated_at: Date | null;
  }>(
    `SELECT u.id, u.login_name, u.display_name, u.role, u.deactivated_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [hashSessionToken(token)]
  );

  const user = result.rows[0];
  if (!user) {
    throw new AppError(401, "SESSION_EXPIRED", "登录已失效，请重新登录");
  }
  if (user.deactivated_at) {
    throw new AppError(403, "ACCOUNT_DEACTIVATED", "该操作员账号已停用");
  }

  (request as AuthenticatedRequest).authUser = {
    id: user.id,
    loginName: user.login_name,
    displayName: user.display_name,
    role: user.role
  };
}

export function requireAdmin(request: FastifyRequest): AuthUser {
  const user = (request as AuthenticatedRequest).authUser;
  if (user.role !== "ADMIN") {
    throw new AppError(403, "ADMIN_ONLY", "该操作仅管理员可执行");
  }
  return user;
}

export async function revokeSession(request: FastifyRequest): Promise<void> {
  const token = request.cookies.handcraft_session;
  if (token) {
    await pool.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [hashSessionToken(token)]);
  }
}
