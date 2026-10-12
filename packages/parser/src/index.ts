import { type Diagnostic, SCHEMA_VERSION } from "@diagram-mapper/graph";

/** A file handed to the parser. The parser never reads the filesystem or network itself. */
export interface FileInput {
  path: string;
  contents: string;
}

export interface ParseResult {
  schemaVersion: number;
  files: number;
  diagnostics: Diagnostic[];
}

/**
 * Placeholder for the M1 parser (TECH-SPEC section 5, ADR-0005). It only implements the
 * discover stage's empty-input rule so the contract is exercised end to end.
 */
export function parse(files: readonly FileInput[]): ParseResult {
  const terraform = files.filter((f) => f.path.endsWith(".tf") || f.path.endsWith(".tf.json"));
  const diagnostics: Diagnostic[] =
    terraform.length === 0
      ? [
          {
            code: "NO_TERRAFORM_FOUND",
            severity: "error",
            message: "No Terraform files were found in the input.",
          },
        ]
      : [];
  return { schemaVersion: SCHEMA_VERSION, files: terraform.length, diagnostics };
}
