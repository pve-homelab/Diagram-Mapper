/**
 * Wire-format version of the resource graph. Describes data compatibility, deliberately
 * decoupled from any package version (ADR-0011 decision 5). The graph schema itself
 * (ADR-0003, TECH-SPEC section 4) lands in M1.
 */
export const SCHEMA_VERSION = 1;

export * from "./errors.ts";
