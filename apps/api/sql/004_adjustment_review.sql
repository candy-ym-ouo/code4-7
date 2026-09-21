ALTER TABLE materials
  ADD COLUMN adjustment_review_threshold numeric(18,6)
    CHECK (adjustment_review_threshold IS NULL OR adjustment_review_threshold >= 0);

CREATE TYPE adjustment_request_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE adjustment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  direction varchar(3) NOT NULL CHECK (direction IN ('IN', 'OUT')),
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  stock_unit stock_unit NOT NULL,
  reason text NOT NULL,
  threshold numeric(18,6) NOT NULL CHECK (threshold >= 0),
  status adjustment_request_status NOT NULL DEFAULT 'PENDING',
  created_by uuid NOT NULL REFERENCES users(id),
  created_session_id uuid NOT NULL REFERENCES sessions(id),
  reviewed_by uuid REFERENCES users(id),
  reviewed_session_id uuid REFERENCES sessions(id),
  reviewed_at timestamptz,
  review_note text,
  stock_movement_id uuid REFERENCES stock_movements(id),
  idempotency_key varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'PENDING' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (status <> 'APPROVED' OR stock_movement_id IS NOT NULL),
  CHECK (reviewed_session_id IS NULL OR reviewed_session_id <> created_session_id)
);
CREATE UNIQUE INDEX adjustment_requests_idempotency_uq ON adjustment_requests(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX adjustment_requests_batch_idx ON adjustment_requests(batch_id, created_at DESC);
CREATE INDEX adjustment_requests_status_idx ON adjustment_requests(status, created_at DESC);

-- 一条调整复核请求最多产生一条库存流水，从数据库层面杜绝重复入账。
CREATE UNIQUE INDEX movements_adjustment_request_uq ON stock_movements(reference_id) WHERE reference_type = 'ADJUSTMENT_REQUEST';

CREATE TRIGGER adjustment_requests_updated_at BEFORE UPDATE ON adjustment_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
