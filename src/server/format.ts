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
  return out.join('\n') + '\n';
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
