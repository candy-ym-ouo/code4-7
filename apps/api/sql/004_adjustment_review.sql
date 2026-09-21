-- 多操作员与结余调整双人复核
-- 1. 用户从“单操作员”升级为多操作员：可登录账号名、角色、停用状态。
-- 2. 结余调整超差异阈值时进入暂存单，待第二位操作员复核后才在同一事务写入流水与余额。

CREATE TYPE user_role AS ENUM ('ADMIN', 'OPERATOR');
CREATE TYPE adjustment_request_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELED');
CREATE TYPE adjustment_direction AS ENUM ('IN', 'OUT');

-- 用户表：删除单操作员唯一索引，新增登录账号与角色
DROP INDEX IF EXISTS users_singleton_uq;
ALTER TABLE users
  ADD COLUMN login_name citext,
  ADD COLUMN role user_role NOT NULL DEFAULT 'OPERATOR',
  ADD COLUMN deactivated_at timestamptz;

-- 历史唯一用户回填为管理员 admin
UPDATE users SET login_name = 'admin', role = 'ADMIN' WHERE login_name IS NULL;

ALTER TABLE users
  ALTER COLUMN login_name SET NOT NULL;

CREATE UNIQUE INDEX users_login_name_uq ON users(login_name);

-- 结余调整暂存单
CREATE TABLE adjustment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  direction adjustment_direction NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  stock_unit stock_unit NOT NULL,
  before_quantity numeric(18,6) NOT NULL CHECK (before_quantity >= 0),
  expected_after_quantity numeric(18,6) NOT NULL CHECK (expected_after_quantity >= 0),
  reason text NOT NULL,
  batch_version integer NOT NULL,
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(100),
  status adjustment_request_status NOT NULL DEFAULT 'PENDING',
  reviewed_by_user_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text,
  movement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adjustment_requests_batch_stock_unit_fk
    FOREIGN KEY (batch_id, stock_unit) REFERENCES batches(id, stock_unit),
  -- 双人复核：需要第二位操作员处理的状态（批准/拒绝），处理人必须不同于申请人；
  -- PENDING 无人处理、CANCELED 由申请人本人撤销，reviewed_by_user_id 均允许为空或为本人
  CONSTRAINT adjustment_requests_review_actor_chk CHECK (
    status NOT IN ('APPROVED', 'REJECTED')
    OR (reviewed_by_user_id IS NOT NULL AND requested_by_user_id <> reviewed_by_user_id)
  ),
  CONSTRAINT adjustment_requests_pending_chk CHECK (
    status <> 'PENDING' OR (
      reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_note IS NULL AND movement_id IS NULL
    )
  ),
  CONSTRAINT adjustment_requests_terminal_review_chk CHECK (
    status NOT IN ('REJECTED', 'CANCELED') OR (reviewed_at IS NOT NULL AND movement_id IS NULL)
  ),
  CONSTRAINT adjustment_requests_approved_chk CHECK (
    status <> 'APPROVED' OR (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL AND movement_id IS NOT NULL)
  ),
  CONSTRAINT adjustment_requests_quantity_chk CHECK (
    (direction = 'IN' AND round(expected_after_quantity, 6) = round(before_quantity + quantity, 6))
    OR
    (direction = 'OUT' AND round(expected_after_quantity, 6) = round(before_quantity - quantity, 6))
  )
);
CREATE UNIQUE INDEX adjustment_requests_idempotency_uq
  ON adjustment_requests(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX adjustment_requests_status_created_idx
  ON adjustment_requests(status, created_at DESC);
CREATE INDEX adjustment_requests_batch_idx
  ON adjustment_requests(batch_id, created_at DESC);

-- 流水回链暂存单（同一事务写入，批准后永不改变，用于溯源与防重复）
ALTER TABLE stock_movements
  ADD COLUMN adjustment_request_id uuid REFERENCES adjustment_requests(id);
CREATE UNIQUE INDEX stock_movements_adjustment_request_uq
  ON stock_movements(adjustment_request_id)
  WHERE adjustment_request_id IS NOT NULL;
