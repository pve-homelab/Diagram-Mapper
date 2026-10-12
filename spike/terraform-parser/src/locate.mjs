// Spike quality. Throwaway.
//
// @cdktf/hcl2json returns a position-free JSON tree. The product has to cite
// file:line, so this module recovers block positions by scanning the raw source
// for block headers. It is a lexical scan, not a parser: it tracks brace depth
// and string/heredoc/comment state so that a `{` inside a string does not
// desynchronise the depth counter.
//
// What it gives us: the declaration line and closing line of every top-level
// block, plus a line index for attributes inside a block (first `name =` at the
// block's own depth). That is enough for "this resource is declared at
// main.tf:42" and "the reference lives at main.tf:57".

const BLOCK_HEADER =
  /^\s*(resource|data|module|variable|output|locals|provider|terraform|moved|import|check|removed)\b([^{]*)\{/;

function splitLabels(rest) {
  const labels = [];
  const re = /"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(rest)) !== null) labels.push(m[1] !== undefined ? m[1] : m[2]);
  return labels;
}

/**
 * Lexically index a .tf file.
 * @returns {{ blocks: Array<{kind:string,labels:string[],line:number,endLine:number}>, lines: string[] }}
 */
export function indexFile(source) {
  const lines = source.split('\n');
  const blocks = [];
  const stack = []; // open blocks, innermost last
  let depth = 0;

  // Lexer state that survives across lines.
  //   mode stack entries: 'string' | { interp: n }
  // Brackets are only counted in code mode, i.e. not inside a string literal
  // and not inside a `${...}` / `%{...}` template interpolation. This matters:
  //   cluster_dns_ips = "[${join(", ", formatlist("\"%s\"", local.x))}]"
  // A naive "toggle on every quote" scanner reads the quote after `join(` as
  // closing the outer string, and from there the bracket depth is permanently
  // wrong -- every later block in the file is then missed.
  const modes = [];
  let inBlockComment = false;
  let heredocTag = null;

  const mode = () => (modes.length ? modes[modes.length - 1] : 'code');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (heredocTag !== null) {
      if (raw.trim().replace(/[,\s)]+$/, '') === heredocTag) heredocTag = null;
      continue;
    }

    // A block header only counts when we are at top level and in code mode.
    if (depth === 0 && modes.length === 0 && !inBlockComment) {
      const header = BLOCK_HEADER.exec(raw);
      if (header) {
        stack.push({
          kind: header[1],
          labels: splitLabels(header[2]),
          line: i + 1,
          endLine: i + 1,
          depth,
        });
      }
    }

    for (let c = 0; c < raw.length; c++) {
      const ch = raw[c];
      const next = raw[c + 1];
      const m = mode();

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          c++;
        }
        continue;
      }

      if (m === 'string') {
        if (ch === '\\') {
          c++;
        } else if (ch === '"') {
          modes.pop();
        } else if ((ch === '$' || ch === '%') && next === '{') {
          modes.push({ interp: 0 });
          c++;
        }
        continue;
      }

      // code mode, or inside an interpolation (which behaves like code except
      // that its braces belong to the interpolation, not to a block body).
      if (ch === '"') {
        modes.push('string');
        continue;
      }
      if (ch === '#' || (ch === '/' && next === '/')) break; // rest of line
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        c++;
        continue;
      }
      if (ch === '<' && next === '<') {
        const hd = /^<<[-~]?([A-Za-z_][A-Za-z0-9_]*)/.exec(raw.slice(c));
        if (hd) {
          heredocTag = hd[1];
          break;
        }
      }

      if (m !== 'code') {
        // Inside `${...}`: track its own nesting so the matching `}` pops it.
        if (ch === '{') m.interp++;
        else if (ch === '}') {
          if (m.interp === 0) modes.pop();
          else m.interp--;
        }
        continue;
      }

      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') {
        depth--;
        if (stack.length && depth === stack[stack.length - 1].depth) {
          const b = stack.pop();
          b.endLine = i + 1;
          delete b.depth;
          blocks.push(b);
        }
      }
    }
  }

  // Unterminated blocks (malformed file): close them at EOF so we still return
  // something usable rather than dropping the resource silently.
  while (stack.length) {
    const b = stack.pop();
    b.endLine = lines.length;
    b.unterminated = true;
    delete b.depth;
    blocks.push(b);
  }

  blocks.sort((a, b) => a.line - b.line);
  return { blocks, lines };
}

/** First line within [startLine,endLine] that assigns `name`, else startLine. */
export function findAttributeLine(lines, startLine, endLine, name) {
  const re = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*=`);
  for (let i = startLine; i < endLine; i++) {
    if (re.test(lines[i] ?? '')) return i + 1;
  }
  return startLine;
}

/** First line within the block whose text contains `needle`, else startLine. */
export function findTextLine(lines, startLine, endLine, needle) {
  for (let i = startLine - 1; i < endLine; i++) {
    if ((lines[i] ?? '').includes(needle)) return i + 1;
  }
  return startLine;
}
