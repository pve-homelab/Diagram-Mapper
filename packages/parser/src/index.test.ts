import { describe, expect, it } from "vitest";
import { parse } from "./index.ts";

describe("parse (M0 placeholder)", () => {
  it("reports NO_TERRAFORM_FOUND rather than an empty graph", () => {
    const result = parse([{ path: "README.md", contents: "# hi" }]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["NO_TERRAFORM_FOUND"]);
  });

  it("counts .tf and .tf.json files only", () => {
    const result = parse([
      { path: "main.tf", contents: "" },
      { path: "vars.tf.json", contents: "{}" },
      { path: "notes.txt", contents: "" },
    ]);
    expect(result.files).toBe(2);
    expect(result.diagnostics).toEqual([]);
  });
});
