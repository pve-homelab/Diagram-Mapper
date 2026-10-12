// Spike quality. Throwaway.
//
// Reference extraction from hcl2json values.
//
// hcl2json renders every HCL expression as a string with the expression wrapped
// in `${...}`. A literal string stays literal. So the only safe place to look
// for references is *inside* `${...}` segments -- scanning literals would turn a
// tag value like "aws_instance.web" into an invented edge, which the product
// spec forbids.

const RESOURCE_TYPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const TRAVERSAL = /([A-Za-z_][A-Za-z0-9_-]*)((?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|\*)|\[[^\]\n]*\])+)/g;

// Roots that are language scope, not graph nodes.
const SCOPE_ROOTS = new Set(['each', 'count', 'self', 'path', 'terraform', 'try', 'can']);

/** Return the contents of every `${...}` segment in a string, brace-balanced. */
export function interpolations(str) {
  const out = [];
  for (let i = 0; i < str.length - 1; i++) {
    if (str[i] === '$' && str[i + 1] === '{') {
      if (str[i - 1] === '$') continue; // $${ is an escaped literal
      let depth = 1;
      let j = i + 2;
      let inStr = false;
      for (; j < str.length && depth > 0; j++) {
        const ch = str[j];
        if (inStr) {
          if (ch === '\\') j++;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      out.push(str.slice(i + 2, j - 1));
      i = j - 1;
    }
  }
  return out;
}

/**
 * Replace every nested quoted string with an empty placeholder, returning the
 * interpolated bodies separately so they can be scanned on their own.
 *
 * This matters: `templatefile("${path.module}/sql/vendor1_cleanup.sql", {...})`
 * contains an interpolation, so the string cannot simply be kept -- the literal
 * filename `vendor1_cleanup.sql` matches the traversal grammar and would become
 * an invented edge. Only `path.module` inside the `${}` is a real reference.
 */
function splitNestedStrings(expr) {
  const nested = [];
  const cleaned = expr.replace(/"((?:[^"\\]|\\.)*)"/g, (m, body) => {
    if (body.includes('${')) nested.push(body);
    return '""';
  });
  return { cleaned, nested };
}

/**
 * Strip HCL comments from an expression body. Multi-line expressions really do
 * carry comments through hcl2json, and a comment mentioning a path such as
 * `tools/build_service_agents.py` otherwise matches the traversal grammar.
 * Run this only after string literals have been blanked, so that a `#` or `//`
 * inside a string cannot truncate real code.
 */
function stripComments(expr) {
  return expr
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(#|\/\/).*$/, ''))
    .join('\n');
}

/** Parse the tail of a traversal into attribute names, discarding indexes. */
function attrSegments(tail) {
  const out = [];
  const re = /\.([A-Za-z_][A-Za-z0-9_-]*)|\.(\*)|\.([0-9]+)|\[([^\]\n]*)\]/g;
  let m;
  while ((m = re.exec(tail)) !== null) {
    // m[3] is a legacy dot-index (site_config.0.x) and m[4] a bracket index
    // (module.project[0], app_settings["KEY"], module.cas[each.key]). Neither
    // is part of the address, so both are dropped.
    if (m[1]) out.push(m[1]);
    else if (m[2]) out.push('*');
  }
  return out;
}

const FOR_BINDING = /\bfor\s+([A-Za-z_]\w*)\s*(?:,\s*([A-Za-z_]\w*)\s*)?in\b/g;

/**
 * Names bound by `for` expressions inside this expression. `[for s in var.x :
 * s.id]` binds `s`, so `s.id` is a loop variable and not a resource called `s`.
 */
function forBindings(expr) {
  const names = new Set();
  FOR_BINDING.lastIndex = 0;
  let m;
  while ((m = FOR_BINDING.exec(expr)) !== null) {
    names.add(m[1]);
    if (m[2]) names.add(m[2]);
  }
  return names;
}

/**
 * Classify traversals found in one expression.
 * @param expr the expression text (contents of a `${...}`)
 * @param extraScope names that are in lexical scope here and therefore are not
 *   graph nodes -- dynamic-block iterators, chiefly.
 * @returns {Array<{root:string, kind:string, target:string, attr:string|null, raw:string}>}
 */
export function traversalsIn(expr, extraScope) {
  const found = [];
  const split = splitNestedStrings(expr);
  const cleaned = stripComments(split.cleaned);
  const local = forBindings(cleaned);

  // A string literal that itself interpolates is scanned only inside its `${}`.
  // The nested scan must inherit this expression's `for` bindings: in
  //   [for g in aws_cloudwatch_log_group.x : "arn:...:${g.name}"]
  // the binding `g` is declared out here but used in there.
  const innerScope = local.size || extraScope ? new Set([...(extraScope ?? []), ...local]) : undefined;
  for (const body of split.nested) {
    for (const inner of interpolations(body)) {
      found.push(...traversalsIn(inner, innerScope));
    }
  }

  TRAVERSAL.lastIndex = 0;
  let m;
  while ((m = TRAVERSAL.exec(cleaned)) !== null) {
    const root = m[1];
    const raw = m[0];
    if (SCOPE_ROOTS.has(root) || local.has(root) || extraScope?.has(root)) {
      found.push({ root, kind: 'scope', target: raw, attr: null, raw });
      continue;
    }
    const segs = attrSegments(m[2]);

    if (root === 'var') {
      if (segs[0]) found.push({ root, kind: 'var', target: segs[0], attr: null, raw });
      continue;
    }
    if (root === 'local') {
      if (segs[0]) found.push({ root, kind: 'local', target: segs[0], attr: null, raw });
      continue;
    }
    if (root === 'module') {
      if (segs[0]) {
        found.push({ root, kind: 'module', target: segs[0], attr: segs[1] ?? null, raw });
      }
      continue;
    }
    if (root === 'data') {
      // data.TYPE.NAME[.attr]
      if (segs[0] && segs[1] && RESOURCE_TYPE.test(segs[0])) {
        found.push({
          root,
          kind: 'data',
          target: `data.${segs[0]}.${segs[1]}`,
          attr: segs[2] ?? null,
          raw,
        });
      }
      continue;
    }
    if (RESOURCE_TYPE.test(root) && segs[0]) {
      found.push({
        root,
        kind: 'resource',
        target: `${root}.${segs[0]}`,
        attr: segs[1] ?? null,
        raw,
      });
      continue;
    }
    found.push({ root, kind: 'ignored', target: raw, attr: null, raw });
  }
  return found;
}

/**
 * Collect the names that `dynamic` blocks bring into scope anywhere in a body.
 * A `dynamic "ingress"` block binds `ingress`; `iterator = "rule"` rebinds it to
 * `rule`. Terraform shadows the outer namespace with these, so treating them as
 * scope (not nodes) matches Terraform's own resolution.
 */
export function dynamicScope(value, acc = new Set()) {
  if (Array.isArray(value)) {
    for (const v of value) dynamicScope(v, acc);
    return acc;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'dynamic') {
        for (const entry of Array.isArray(v) ? v : [v]) {
          if (!entry || typeof entry !== 'object') continue;
          for (const [label, defs] of Object.entries(entry)) {
            acc.add(label);
            for (const def of Array.isArray(defs) ? defs : [defs]) {
              if (def && typeof def === 'object' && typeof def.iterator === 'string') {
                acc.add(def.iterator.replace(/^\$\{|\}$/g, ''));
              }
            }
          }
        }
      }
      dynamicScope(v, acc);
    }
  }
  return acc;
}

/** Walk any hcl2json value, yielding every reference found inside `${}`. */
export function* walkRefs(value, path = [], scope = null) {
  const extraScope = scope ?? dynamicScope(value);
  if (typeof value === 'string') {
    for (const expr of interpolations(value)) {
      for (const t of traversalsIn(expr, extraScope)) yield { ...t, path, expr };
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* walkRefs(value[i], path, extraScope);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // `lifecycle { ignore_changes = [access_config[0].foo] }` holds attribute
      // paths *relative to this resource*, not references to other objects.
      // Reading them as references invents edges to resources that do not exist.
      // (`replace_triggered_by`, by contrast, does hold real references.)
      if (k === 'ignore_changes' && path[path.length - 1] === 'lifecycle') continue;
      // Keys can be interpolated too: { "${var.x}" = 1 }
      for (const expr of interpolations(k)) {
        for (const t of traversalsIn(expr, extraScope)) yield { ...t, path, expr };
      }
      yield* walkRefs(v, [...path, k], extraScope);
    }
  }
}
