/**
 * Indentation formatter for SysML/KerML.
 *
 * This is deliberately conservative: it normalises indentation and trailing
 * whitespace while preserving every token, comment and blank-line grouping.
 * A full pretty-printer would need to reflow expressions and risks changing
 * meaning, so it is out of scope for `textDocument/formatting`.
 */

export interface FormatOptions {
  insertSpaces: boolean;
  tabSize: number;
  /** Align the `:` or `=` of consecutive members in the same block. */
  alignMembers?: boolean;
}

/**
 * Re-indent each line from brace depth.
 *
 * Braces inside strings, line comments and block comments are ignored so the
 * depth stays correct. `}` lines are dedented before their own indentation is
 * written, which is the common editor convention.
 */
export function formatText(text: string, options: FormatOptions): string {
  const unit = options.insertSpaces ? ' '.repeat(Math.max(1, options.tabSize)) : '\t';
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let depth = 0;
  let inBlockComment = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      // Collapse runs of blank lines to one.
      if (out.length > 0 && out[out.length - 1] !== '') {
        out.push('');
      }
      continue;
    }

    const { opens, closes, blockComment } = scanLine(trimmed, inBlockComment);
    inBlockComment = blockComment;

    // A closing brace on its own line belongs to the outer level.
    const dedent = !opens && closes > 0 ? closes : 0;
    let lineDepth = Math.max(0, depth - dedent);
    out.push(unit.repeat(lineDepth) + trimmed);

    depth = Math.max(0, depth + opens - closes);
    if (opens === 0 && closes > 0) {
      depth = Math.max(0, depth);
    }
  }

  // Keep at most one trailing newline.
  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }

  const finalLines = options.alignMembers ? alignMembers(out) : out;
  return finalLines.join('\n') + '\n';
}

/**
 * Align the `:` or `=` separator of consecutive members that share the same
 * indentation. Blank lines, comments and block boundaries end a group, so
 * unrelated declarations are never aligned with each other.
 */
function alignMembers(lines: string[]): string[] {
  const result = [...lines];
  let index = 0;

  while (index < result.length) {
    const line = result[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    const indent = /^\s*/.exec(line)?.[0] ?? '';
    const first = memberHead(line, indent);
    if (!first) {
      index++;
      continue;
    }

    const group: { line: number; head: string; tail: string }[] = [
      { line: index, head: first.head, tail: first.tail },
    ];
    let next = index + 1;
    while (next < result.length) {
      const candidate = result[next];
      if (!candidate.trim()) {
        break;
      }
      if ((/^\s*/.exec(candidate)?.[0] ?? '') !== indent) {
        break;
      }
      const parsed = memberHead(candidate, indent);
      if (!parsed) {
        break;
      }
      group.push({ line: next, head: parsed.head, tail: parsed.tail });
      next++;
    }

    if (group.length >= 2) {
      const width = Math.max(...group.map((item) => item.head.length));
      for (const item of group) {
        result[item.line] = indent + item.head.padEnd(width) + ' ' + item.tail;
      }
    }
    index = next;
  }
  return result;
}

/**
 * Split a member line into the text before its separator and the separator
 * plus the rest. Returns undefined for lines that are not member declarations.
 */
function memberHead(line: string, indent: string): { head: string; tail: string } | undefined {
  const body = line.slice(indent.length);
  if (!/^[A-Za-z_]/.test(body)) {
    return undefined; // comments, braces and keywords without members
  }
  const marker = memberMarker(body);
  if (marker < 0) {
    return undefined;
  }
  const head = body.slice(0, marker).trimEnd();
  if (!head) {
    return undefined;
  }
  return { head, tail: body.slice(marker).trimStart() };
}

/** Index of the first `:` or `=` that separates a member, or -1. */
function memberMarker(body: string): number {
  let quote: string | undefined;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const next = body[i + 1];
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      break;
    }
    if (ch === '/' && next === '*') {
      const end = body.indexOf('*/', i + 2);
      if (end < 0) {
        break;
      }
      i = end + 1;
      continue;
    }
    if (ch === ':') {
      // Skip `::` and the `:>` specialization operator.
      if (next === ':' || next === '>') {
        i++;
        continue;
      }
      return i;
    }
    if (ch === '=') {
      const prev = body[i - 1];
      if (next === '=' || next === '>' || prev === '=' || prev === '<' || prev === '>' || prev === '!') {
        continue;
      }
      return i;
    }
  }
  return -1;
}

/**
 * Count braces outside strings and comments.
 * `blockComment` carries the block-comment state across lines.
 */
function scanLine(
  line: string,
  startInBlockComment: boolean
): { opens: number; closes: number; blockComment: boolean } {
  let opens = 0;
  let closes = 0;
  let inBlock = startInBlockComment;
  let quote: string | undefined;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      break;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      opens++;
    } else if (ch === '}') {
      closes++;
    }
  }
  return { opens, closes, blockComment: inBlock };
}
