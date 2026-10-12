import { describe, expect, it } from "vitest";
import { Diagnostic, DiagnosticCode, isHardFailure } from "./index.ts";

describe("diagnostic codes", () => {
  it("is a closed enum", () => {
    expect(DiagnosticCode.safeParse("SOMETHING_WENT_WRONG").success).toBe(false);
    expect(DiagnosticCode.safeParse("FILE_PARSE_ERROR").success).toBe(true);
  });

  it("separates hard failures from soft diagnostics", () => {
    expect(isHardFailure("NO_TERRAFORM_FOUND")).toBe(true);
    expect(isHardFailure("UNRESOLVED_REFERENCE")).toBe(false);
  });

  it("carries the file and line that defeated the parser", () => {
    const d = Diagnostic.parse({
      code: "FILE_PARSE_ERROR",
      severity: "warning",
      message: "Unexpected token",
      path: "modules/vpc/main.tf",
      line: 12,
    });
    expect(d.path).toBe("modules/vpc/main.tf");
    expect(() => Diagnostic.parse({ ...d, line: 0 })).toThrow();
  });
});
