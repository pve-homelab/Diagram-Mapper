import { expect, it } from "vitest";
import { JOBS } from "./jobs.ts";

it("declares the two M1 job names", () => {
  expect(Object.values(JOBS).sort()).toEqual(["retention.sweep", "scan.ingest"]);
});
