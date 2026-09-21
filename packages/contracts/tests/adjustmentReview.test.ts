import { describe, expect, it } from "vitest";
import { exceedsAdjustmentThreshold, loginSchema, setupSchema, userCreateSchema, adjustmentRejectSchema } from "../src/index.js";

describe("adjustment review threshold", () => {
  it("requires review for any adjustment when balance is zero", () => {
    expect(exceedsAdjustmentThreshold("IN", "1", "0", 0.1)).toBe(true);
    expect(exceedsAdjustmentThreshold("IN", "0.000001", "0", 10)).toBe(true);
  });

  it("compares adjustment size against balance ratio", () => {
    // 默认 10%：100g 余额
    expect(exceedsAdjustmentThreshold("OUT", "10", "100", 0.1)).toBe(false);
    expect(exceedsAdjustmentThreshold("OUT", "10.000001", "100", 0.1)).toBe(true);
    expect(exceedsAdjustmentThreshold("IN", "50", "100", 0.5)).toBe(false);
    expect(exceedsAdjustmentThreshold("IN", "50.000001", "100", 0.5)).toBe(true);
  });

  it("uses exact boundary without floating point error", () => {
    // 30 / 300 = 0.1 恰好等于阈值，不超限
    expect(exceedsAdjustmentThreshold("OUT", "30", "300", 0.1)).toBe(false);
    // 1/3 类型比例
    expect(exceedsAdjustmentThreshold("OUT", "1", "3", 0.333333)).toBe(true);
  });

  it("ratio 0 forces every adjustment into review", () => {
    expect(exceedsAdjustmentThreshold("OUT", "0.000001", "1000000", 0)).toBe(true);
    expect(exceedsAdjustmentThreshold("IN", "0.000001", "1000000", 0)).toBe(true);
  });
});

describe("multi-operator auth schemas", () => {
  it("accepts a well-formed login name and rejects bad ones", () => {
    expect(setupSchema.safeParse({ loginName: "admin", displayName: "管理员", password: "0123456789" }).success).toBe(true);
    expect(loginSchema.safeParse({ loginName: "lin_yi", password: "secret12345" }).success).toBe(true);
    for (const bad of ["1admin", "-ab", "ab", "a".repeat(41), "has space", "用户admin"]) {
      expect(setupSchema.safeParse({ loginName: bad, displayName: "x", password: "0123456789" }).success).toBe(false);
    }
  });

  it("defaults new users to OPERATOR role", () => {
    const parsed = userCreateSchema.parse({ loginName: "reviewer1", displayName: "复核员", password: "0123456789" });
    expect(parsed.role).toBe("OPERATOR");
  });

  it("requires a reject reason of at least 3 characters", () => {
    expect(adjustmentRejectSchema.safeParse({ reason: "ok" }).success).toBe(false);
    expect(adjustmentRejectSchema.safeParse({ reason: "批次信息不符" }).success).toBe(true);
  });
});
