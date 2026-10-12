import { SCHEMA_VERSION } from "@diagram-mapper/graph";

/** Liveness only at M0. TECH-SPEC section 7.8 adds the database check in M1. */
export function GET(): Response {
  return Response.json({ status: "ok", schemaVersion: SCHEMA_VERSION });
}
