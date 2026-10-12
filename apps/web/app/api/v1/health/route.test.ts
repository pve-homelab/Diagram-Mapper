import { expect, it } from "vitest";
import { GET } from "./route.ts";

it("reports liveness and the graph schema version", async () => {
  const res = GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok", schemaVersion: 1 });
});
