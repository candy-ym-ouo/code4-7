import { describe, expect, it } from "vitest";
import { adjustmentReviewSchema, batchCreateSchema, colorChangeInputSchema, consumptionInputSchema, convertQuantity, materialInputSchema } from "@handcraft/contracts";

describe("API business validation contracts", () => {
  it("normalizes a valid batch payload", () => {
    const result = batchCreateSchema.parse({
      materialId: "00000000-0000-0000-0000-000000000001",
      receivedAt: "2026-09-13",
      initialQuantity: "1.5",
      entryUnit: "kg"
    });
    expect(result.entryUnit).toBe("kg");
  });

  it("requires at least one consumption quantity", () => {
    const base = {
      projectId: "00000000-0000-0000-0000-000000000001",
      batchId: "00000000-0000-0000-0000-000000000002",
      usedQuantity: "0",
      wasteQuantity: "0",
      unit: "g"
    };
    expect(consumptionInputSchema.safeParse(base).success).toBe(false);
    expect(consumptionInputSchema.safeParse({ ...base, wasteQuantity: "10" }).success).toBe(true);
  });

  it("rejects zero affected quantity for color changes", () => {
    const result = colorChangeInputSchema.safeParse({
      batchId: "00000000-0000-0000-0000-000000000002",
      changeType: "OTHER",
      afterColorName: "Test",
      affectedQuantity: "0",
      unit: "g",
      occurredAt: "2026-09-13T10:00:00+08:00"
    });
    expect(result.success).toBe(false);
  });

  it("keeps inventory units in compatible families", () => {
    expect(convertQuantity("2.5", "l", "ml")).toBe("2500.000000");
    expect(() => convertQuantity("2.5", "l", "kg")).toThrow();
  });

  it("accepts an optional adjustment review threshold on materials", () => {
    const base = {
      name: "苏木染材",
      craftTypes: ["DYEING"],
      stockUnit: "g"
    };
    expect(materialInputSchema.safeParse({ ...base, adjustmentReviewThreshold: "500" }).success).toBe(true);
    expect(materialInputSchema.safeParse({ ...base, adjustmentReviewThreshold: null }).success).toBe(true);
    expect(materialInputSchema.safeParse({ ...base, adjustmentReviewThreshold: "-1" }).success).toBe(false);
    expect(materialInputSchema.safeParse({ ...base, adjustmentReviewThreshold: "1.0000001" }).success).toBe(false);
  });

  it("requires a review password for adjustment review decisions", () => {
    expect(adjustmentReviewSchema.safeParse({ password: "second-person-password" }).success).toBe(true);
    expect(adjustmentReviewSchema.safeParse({ password: "second-person-password", note: "盘点确认" }).success).toBe(true);
    expect(adjustmentReviewSchema.safeParse({ password: "" }).success).toBe(false);
    expect(adjustmentReviewSchema.safeParse({}).success).toBe(false);
  });
});
