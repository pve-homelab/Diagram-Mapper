/** Queue names consumed by the worker (TECH-SPEC section 10, ADR-0008). Handlers land in M1. */
export const JOBS = {
  scanIngest: "scan.ingest",
  retentionSweep: "retention.sweep",
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];
