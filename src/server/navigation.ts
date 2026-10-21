import type {
  FoldingRange,
  InlayHint,
  ParameterInformation,
  Position,
  SemanticTokens,
  SignatureHelp,
  SignatureInformation,
} from 'vscode-languageserver/node.js';
import { InlayHintKind } from 'vscode-languageserver/node.js';
import type { DocumentModel, LspRange, SysmlSymbol } from './model.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

// ---------------------------------------------------------------------------
// Semantic tokens
// ---------------------------------------------------------------------------

/** Token types advertised in the server capabilities. */
export const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'class',
  'interface',
  'enum',
  'enumMember',
  'function',
  'property',
  'variable',
] as const;

/** One modifier: declarations are distinguished from references. */
export const SEMANTIC_TOKEN_MODIFIERS = ['declaration'] as const;

type TokenType = (typeof SEMANTIC_TOKEN_TYPES)[number];

/** Map a SysML symbol kind onto a semantic token type. */
function tokenTypeFor(kind: string): TokenType {
  if (/Enumeration Value/.test(kind)) return 'enumMember';
  if (/Enumeration/.test(kind)) return 'enum';
  if (/Interface Definition/.test(kind)) return 'interface';
  if (/Calculation|Action/.test(kind)) return 'function';
  if (/Definition$/.test(kind)) return 'class';
  if (/Package|Namespace/.test(kind)) return 'namespace';
  if (/Requirement/.test(kind)) return 'interface';
  return 'property';
}

interface RawToken {
  line: number;
  character: number;
  length: number;
  type: number;
  modifiers: number;
  declaration: boolean;
}

const DECLARATION_MODIFIER = 1 << 0;

/**
 * Collect declaration and reference tokens.
 *
 * References are coloured by the kind of their resolved target, so usages read
 * the same as declarations. Declarations win when both land on one range.
 */
export function semanticTokens(model: DocumentModel): SemanticTokens {
  const typeIndex = new Map<string, number>(
    SEMANTIC_TOKEN_TYPES.map((type, index) => [type, index])
  );
  const tokens = new Map<string, RawToken>();

  const add = (range: LspRange, kind: string, declaration: boolean): void => {
    if (range.start.line !== range.end.line) {
      return;
    }
    const length = range.end.character - range.start.character;
    if (length <= 0) {
      return;
    }
    const type = typeIndex.get(tokenTypeFor(kind));
    if (type === undefined) {
      return;
    }
    const key = `${range.start.line}:${range.start.character}:${length}`;
    const existing = tokens.get(key);
    if (existing && (existing.declaration || !declaration)) {
      return;
    }
    tokens.set(key, {
      line: range.start.line,
      character: range.start.character,
      length,
      type,
      modifiers: declaration ? DECLARATION_MODIFIER : 0,
      declaration,
    });
  };

  const visit = (symbol: SysmlSymbol): void => {
    if (!symbol.isFileRoot) {
      add(symbol.nameRange, symbol.kind, true);
    }
    for (const ref of symbol.refs) {
      if (ref.resolved) {
        add(ref.range, ref.resolved.kind, false);
      }
    }
    for (const child of symbol.children) {
      visit(child);
    }
  };
  visit(model.root);

  const ordered = [...tokens.values()].sort(
    (a, b) => a.line - b.line || a.character - b.character
  );
  const data: number[] = [];
  let previousLine = 0;
  let previousCharacter = 0;
  for (const token of ordered) {
    const deltaLine = token.line - previousLine;
    const deltaCharacter = deltaLine === 0 ? token.character - previousCharacter : token.character;
    data.push(deltaLine, deltaCharacter, token.length, token.type, token.modifiers);
    previousLine = token.line;
    previousCharacter = token.character;
  }
  return { data };
}

// ---------------------------------------------------------------------------
// Folding ranges
// ---------------------------------------------------------------------------

/**
 * Folding from braces plus comment blocks.
 *
 * The scanner skips strings, line comments and block comments so braces inside
 * them do not open a fold. `endLine` stops one line before the closing brace so
 * the brace itself stays visible.
 */
export function foldingRanges(text: string): FoldingRange[] {
  const lines = text.split(/\r?\n/);
  const ranges: FoldingRange[] = [];
  const stack: number[] = [];
  let inBlockComment = false;
  let commentStart = -1;
  let lineCommentStart = -1;
  let lineCommentEnd = -1;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber];
    const trimmed = line.trim();

    // Consecutive `//` lines fold as one comment region.
    if (!inBlockComment && /^\/\//.test(trimmed)) {
      if (lineCommentStart < 0) {
        lineCommentStart = lineNumber;
      }
      lineCommentEnd = lineNumber;
    } else {
      if (lineCommentStart >= 0 && lineCommentEnd > lineCommentStart) {
        ranges.push({ startLine: lineCommentStart, endLine: lineCommentEnd, kind: 'comment' });
      }
      lineCommentStart = -1;
    }

    let quote: string | undefined;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          if (commentStart >= 0 && lineNumber > commentStart) {
            ranges.push({ startLine: commentStart, endLine: lineNumber, kind: 'comment' });
          }
          commentStart = -1;
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
        inBlockComment = true;
        commentStart = lineNumber;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '{') {
        stack.push(lineNumber);
      } else if (ch === '}' && stack.length) {
        const start = stack.pop()!;
        if (lineNumber > start) {
          ranges.push({ startLine: start, endLine: lineNumber - 1, kind: 'region' });
        }
      }
    }
  }

  if (lineCommentStart >= 0 && lineCommentEnd > lineCommentStart) {
    ranges.push({ startLine: lineCommentStart, endLine: lineCommentEnd, kind: 'comment' });
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Inlay hints: inferred literal types
// ---------------------------------------------------------------------------

/** Infer the type of a literal default value, or nothing when it is not a literal. */
function inferLiteralType(value: string): string | undefined {
  const text = value.trim().replace(/;$/, '').trim();
  if (!text) {
    return undefined;
  }
  if (/^["']/.test(text)) {
    return 'String';
  }
  if (/^(true|false)$/.test(text)) {
    return 'Boolean';
  }
  if (/^[+-]?\d+$/.test(text)) {
    return 'Integer';
  }
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(text)) {
    return 'Real';
  }
  return undefined;
}

/**
 * Show the inferred type of a feature whose type is not written, for example
 * `attribute mass = 12.5;` gets a `: Real` hint after the name.
 */
export function inlayHints(model: DocumentModel, document: TextDocument): InlayHint[] {
  const hints: InlayHint[] = [];

  const visit = (symbol: SysmlSymbol): void => {
    if (
      !symbol.isFileRoot &&
      !symbol.kind.endsWith('Definition') &&
      !/Package|Namespace|File|Enumeration/.test(symbol.kind) &&
      !symbol.refs.some((ref) => ref.kind === 'typing') &&
      symbol.nameRange.start.line === symbol.nameRange.end.line
    ) {
      const source = document.getText({
        start: symbol.range.start,
        end: symbol.range.end,
      });
      const assignment = /=\s*([^;]+)/.exec(source);
      if (assignment) {
        const type = inferLiteralType(assignment[1]);
        if (type) {
          hints.push({
            position: symbol.nameRange.end,
            label: `: ${type}`,
            kind: InlayHintKind.Type,
            paddingLeft: true,
          });
        }
      }
    }
    for (const child of symbol.children) {
      visit(child);
    }
  };
  visit(model.root);
  return hints;
}

// ---------------------------------------------------------------------------
// Signature help
// ---------------------------------------------------------------------------

/** Find the opening `(` for the call containing the cursor. */
function openingParen(text: string, offset: number): number {
  let depth = 0;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ')') {
      depth++;
    } else if (ch === '(') {
      if (depth === 0) {
        return i;
      }
      depth--;
    } else if (ch === ';' || ch === '{' || ch === '}') {
      if (depth === 0) {
        return -1;
      }
    }
  }
  return -1;
}

/** Top-level comma separated parameters between two parentheses. */
function parameterList(source: string, open: number): string[] {
  const parameters: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = open + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      if (depth === 0) {
        if (current.trim()) {
          parameters.push(current.trim());
        }
        break;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      parameters.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  return parameters.filter(Boolean);
}

/** Parameters declared in the body of a calc/action definition. */
function bodyParameters(source: string): string[] {
  const parameters: string[] = [];
  const feature = /(?:^|\n)\s*(in|out|inout)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^;\n]+))?;/g;
  let match: RegExpExecArray | null;
  while ((match = feature.exec(source))) {
    const direction = match[1];
    const name = match[2];
    const type = match[3]?.trim();
    parameters.push(type ? `${direction} ${name} : ${type}` : `${direction} ${name}`);
  }
  const returnType = /(?:^|\n)\s*return\s*:\s*([^;\n]+);/.exec(source);
  if (returnType) {
    parameters.push(`return : ${returnType[1].trim()}`);
  }
  return parameters;
}

/**
 * Signature help for calls to `calc def` and `action def`.
 *
 * Parameters come from the declaration header when it has a parenthesis list,
 * otherwise from `in`/`out`/`return` features in the body, which is how the
 * SysML v2 grammar declares them.
 */
export function signatureHelp(
  document: TextDocument,
  position: Position,
  resolve: (name: string) => { sym: SysmlSymbol; text: string } | undefined
): SignatureHelp | undefined {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const open = openingParen(text, offset);
  if (open < 0) {
    return undefined;
  }
  const nameMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(text.slice(0, open));
  if (!nameMatch) {
    return undefined;
  }
  const target = resolve(nameMatch[1]);
  if (!target || !/Calculation|Action/.test(target.sym.kind)) {
    return undefined;
  }
  const brace = target.text.indexOf('{');
  const header = brace >= 0 ? target.text.slice(0, brace) : target.text;
  const headerOpen = header.indexOf('(');
  const parameters = headerOpen >= 0 ? parameterList(header, headerOpen) : bodyParameters(target.text);
  if (!parameters.length) {
    return undefined;
  }

  const labels = parameters.map((parameter) => parameter.replace(/\s+/g, ' '));
  const signature: SignatureInformation = {
    label: `${target.sym.name}(${labels.join(', ')})`,
    parameters: labels.map<ParameterInformation>((label) => ({ label })),
  };

  // Active parameter = top-level commas between `(` and the cursor.
  let activeParameter = 0;
  let depth = 0;
  for (let i = open + 1; i < offset; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) activeParameter++;
  }

  return {
    signatures: [signature],
    activeSignature: 0,
    activeParameter: Math.min(activeParameter, parameters.length - 1),
  };
}
