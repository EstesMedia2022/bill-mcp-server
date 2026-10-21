import { describe, it, expect } from "vitest";
import { isReadOnlyTool, selectTools, tools } from "./index.js";

describe("selectTools", () => {
  it("should expose every tool when unrestricted", () => {
    expect(selectTools(tools, { readOnly: false, allowList: [] })).toEqual(tools);
  });

  it("should expose only list_* and get_* tools in read-only mode", () => {
    const selected = selectTools(tools, { readOnly: true, allowList: [] });
    const names = selected.map((t) => t.name);

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every(isReadOnlyTool)).toBe(true);
    for (const writeTool of ["create_payment", "charge_customer", "create_vendor_bank_account", "delete_user", "generate_invoice_payment_link"]) {
      expect(names).not.toContain(writeTool);
    }
  });

  it("should restrict to the allow list", () => {
    const selected = selectTools(tools, { readOnly: false, allowList: ["list_bills", "create_bill"] });
    expect(selected.map((t) => t.name)).toEqual(["list_bills", "create_bill"]);
  });

  it("should apply read-only on top of the allow list", () => {
    const selected = selectTools(tools, { readOnly: true, allowList: ["list_bills", "create_bill"] });
    expect(selected.map((t) => t.name)).toEqual(["list_bills"]);
  });

  it("should reject unknown tool names", () => {
    expect(() => selectTools(tools, { readOnly: false, allowList: ["list_bils"] })).toThrow("list_bils");
  });
});
