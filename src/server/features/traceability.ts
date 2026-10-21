import { parseText } from '../parser.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type {
  TraceLink,
  TraceTarget,
  TraceabilityPayload,
  ValidationResult,
} from '../../shared/protocol.js';
import type { SysmlSymbol } from '../model.js';
import type { FeatureContext } from './context.js';

/** Position of the first line inside a declaration body. */
function bodyInsertion(
  document: TextDocument,
  symbol: SysmlSymbol,
  preferObjective = false
): { line: number; character: number } {
  const text = document.getText();
  const start = document.offsetAt(symbol.range.start);
  const end = document.offsetAt(symbol.range.end);
  let searchFrom = start;
  if (preferObjective) {
    const objective = text.indexOf('objective', start);
    if (objective >= 0 && objective < end) {
      searchFrom = objective;
    }
  }
  const open = text.indexOf('{', searchFrom);
  if (open < 0 || open > end) {
    return { line: symbol.range.end.line, character: 0 };
  }
  const position = document.positionAt(open);
  const lineText = text.split(/\r?\n/)[position.line] ?? '';
  const indent = /^\s*/.exec(lineText)?.[0] ?? '';
  return { line: position.line + 1, character: indent.length + 2 };
}

/**
 * Build the requirement/verification matrix.
 *
 * `verify X;` is recorded as an explicit `verify` reference, so the matrix does
 * not have to infer the link from a generic reference subsetting.
 */
export function registerTraceability(ctx: FeatureContext): void {
  ctx.connection.onRequest('sysml/traceability', (): TraceabilityPayload => {
    const requirements: TraceTarget[] = [];
    const verifications: TraceTarget[] = [];
    const links: TraceLink[] = [];

    const toTarget = (sym: SysmlSymbol, uri: string): TraceTarget => ({
      id: sym.id,
      name: sym.name,
      qname: sym.qname,
      uri,
      line: sym.nameRange.start.line,
      character: sym.nameRange.start.character,
    });

    // First pass: every requirement, so links resolve regardless of the
    // declaration order between files.
    for (const model of ctx.workspace.docs.values()) {
      if (model.library) {
        continue;
      }
      const visit = (sym: SysmlSymbol): void => {
        if (/Requirement/.test(sym.kind)) {
          requirements.push(toTarget(sym, model.uri));
        }
        for (const child of sym.children) {
          visit(child);
        }
      };
      visit(model.root);
    }

    for (const model of ctx.workspace.docs.values()) {
      if (model.library) {
        continue;
      }
      const visit = (sym: SysmlSymbol): void => {
        if (/Verification/.test(sym.kind)) {
          const target = toTarget(sym, model.uri);
          const document = ctx.documents.get(model.uri);
          if (document) {
            const insertion = bodyInsertion(document, sym, true);
            target.insertLine = insertion.line;
            target.insertCharacter = insertion.character;
            const body = document
              .getText()
              .slice(document.offsetAt(sym.range.start), document.offsetAt(sym.range.end));
            target.needsObjective = !/\bobjective\b/.test(body);
          }
          verifications.push(target);

          // Prefer the explicit `verify` reference. A verify statement nested
          // deeper still surfaces as a reference subsetting.
          const explicit = sym.refs.filter((ref) => ref.kind === 'verify');
          const candidates = explicit.length
            ? explicit
            : sym.refs.filter((ref) => ref.kind === 'subsets');
          for (const ref of candidates) {
            if (!ref.resolved || !/Requirement/.test(ref.resolved.kind)) {
              continue;
            }
            const requirement = requirements.find(
              (item) => item.qname === ref.resolved!.qname && item.uri === ref.resolved!.uri
            );
            if (
              requirement &&
              !links.some(
                (link) =>
                  link.requirement === requirement.id && link.verification === sym.id
              )
            ) {
              links.push({
                requirement: requirement.id,
                verification: sym.id,
                uri: model.uri,
                line: ref.range.start.line,
                character: ref.range.start.character,
                endLine: ref.range.end.line,
                endCharacter: ref.range.end.character,
              });
            }
          }
        }
        for (const child of sym.children) {
          visit(child);
        }
      };
      visit(model.root);
    }

    return { requirements, verifications, links };
  });

  // Validation for AI-generated text: parse only, no workspace side effects.
  ctx.connection.onRequest('sysml/validate', (params: { text: string }): ValidationResult => {
    if (typeof params?.text !== 'string') {
      return { errors: [] };
    }
    try {
      const result = parseText(params.text, false);
      return { errors: result.errors };
    } catch (error) {
      return {
        errors: [{ line: 0, column: 0, message: `Could not parse: ${String(error)}` }],
      };
    }
  });
}
