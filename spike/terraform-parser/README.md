# Terraform parser spike (AIS-4)

Throwaway spike code. The finding is the deliverable; it lives in the `parser-spike`
document on AIS-4. Do not build production code on top of this directory.

## Run it

```sh
npm install
npm test                              # golden fixture: fixtures/hard-cases vs hard-cases.expected.json
./clone-repos.sh /path/to/repos       # the six pinned public repositories
node run.mjs /path/to/repos/<repo> --json out.json   # summary on stdout, full graph to out.json
node audit.mjs /path/to/repos/*       # block inventory: lexer vs Go HCL vs naive scan
node linecheck.mjs /path/to/repos/<repo>   # every edge cites a line containing its reference
node tscompare.mjs /path/to/repos/<repo>/  # tree-sitter-hcl vs Go HCL: speed, errors, inventory
```

## Layout

- `src/locate.mjs` — lexical block index (positions; hcl2json has none)
- `src/refs.mjs` — reference extraction from `${...}` expressions
- `src/build.mjs` — one module unit (directory) to nodes, edges, unresolved
- `src/repo.mjs` — all units in a repository, plus local module linking
- `fixtures/hard-cases/` — every construct that broke an earlier version; the expected
  graph was written by hand from the source, line by line

## Rules the code holds

1. An edge exists only when both endpoints resolve to a declared block.
2. Everything else is an `unresolved` record with file, line and a typed reason.
3. Node ids are Terraform addresses, so re-parsing is byte-identical.
