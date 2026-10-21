import { CodeActionKind } from 'vscode-languageserver/node.js';
import type { CodeAction, TextEdit } from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { refAtPosition, symbolAtPosition } from '../model.js';
import type { RefKind } from '../model.js';
import type { FeatureContext } from './context.js';

const SCALAR_TYPES = new Set([
  'Real',
  'Integer',
  'Natural',
  'Boolean',
  'String',
  'Rational',
  'Complex',
  'UnlimitedNatural',
]);

/** Insert an import at the top of the enclosing package, or of the file. */
function importEdit(document: TextDocument, moduleName: string): TextEdit | undefined {
  const text = document.getText();
  if (new RegExp(`import\\s+${moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)) {
    return undefined;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const match = /^(\s*)(package|library package|namespace)\b[^{]*\{\s*$/.exec(lines[i]);
    if (match) {
      return {
        range: { start: { line: i + 1, character: 0 }, end: { line: i + 1, character: 0 } },
        newText: `${match[1]}    import ${moduleName}::*;\n`,
      };
    }
  }
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    newText: `import ${moduleName}::*;\n`,
  };
}

/** Position and indentation for a declaration at file or package scope. */
function fileScopeInsertion(document: TextDocument): { line: number; indent: string } {
  const lines = document.getText().split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const match = /^(\s*)(package|library package|namespace)\b[^{]*\{\s*$/.exec(lines[i]);
    if (match) {
      return { line: i + 1, indent: match[1] + '    ' };
    }
  }
  return { line: 0, indent: '' };
}

/**
 * Declaration text for an unresolved reference.
 *
 * The reference kind tells us what the user was trying to name: a type or a
 * specialization needs a part definition, a `verify`/`satisfy` needs a
 * requirement, and an import needs a package.
 */
function missingDeclaration(
  kind: RefKind | undefined,
  name: string
): { label: string; text: string } {
  switch (kind) {
    case 'import':
      return { label: 'package', text: `package ${name} {\n}` };
    case 'verify':
    case 'satisfy':
      return { label: 'requirement definition', text: `requirement def ${name} {\n}` };
    default:
      return { label: 'part definition', text: `part def ${name} {\n}` };
  }
}

/** Turn a comment body into a valid CamelCase requirement name. */
function requirementNameFrom(comment: string): string {
  const words = comment
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  let name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('');
  if (!name) {
    return 'ExtractedRequirement';
  }
  if (!/^[A-Za-z]/.test(name)) {
    name = 'Requirement' + name;
  }
  return name;
}

function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (Math.abs(a.length - b.length) > 2) {
    return 3;
  }
  const prev = new Array(b.length + 1).fill(0).map((_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      last = tmp;
    }
  }
  return prev[b.length];
}

/** Quick fixes and extract refactorings advertised on a document. */
export function registerCodeActions(ctx: FeatureContext): void {
  ctx.connection.onCodeAction((params) => {
    const model = ctx.workspace.docs.get(params.textDocument.uri);
    const document = ctx.documents.get(params.textDocument.uri);
    if (!model || !document) {
      return [];
    }
    const actions: CodeAction[] = [];

    for (const diagnostic of params.context.diagnostics) {
      const unresolved = /^Unresolved reference '(.+)'$/.exec(diagnostic.message);
      if (!unresolved) {
        continue;
      }
      const name = unresolved[1];
      const lastSegment = name.split('::').pop() ?? name;

      // 1. Exact standard-library symbol: import its owning package.
      const libraryHit = ctx.workspace
        .lookupByName(lastSegment)
        .find((entry) => entry.model.library);
      if (libraryHit) {
        const owner = libraryHit.sym.parent?.qname || libraryHit.sym.qname.split('::')[0];
        if (owner) {
          const edit = importEdit(document, owner);
          if (edit) {
            actions.push({
              title: `Import ${owner}`,
              kind: CodeActionKind.QuickFix,
              diagnostics: [diagnostic],
              edit: { changes: { [model.uri]: [edit] } },
            });
          }
        }
      }

      // 2. Scalar types live in ScalarValues, which is the common case.
      if (SCALAR_TYPES.has(lastSegment) && !/import\s+ScalarValues/.test(document.getText())) {
        const edit = importEdit(document, 'ScalarValues');
        if (edit) {
          actions.push({
            title: 'Import ScalarValues',
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            edit: { changes: { [model.uri]: [edit] } },
          });
        }
      }

      // 3. Likely typo of a user declaration: offer the closest name.
      let best: { name: string; distance: number } | undefined;
      for (const candidate of ctx.workspace.allSymbols()) {
        if (candidate.model.library || candidate.sym.name === lastSegment) {
          continue;
        }
        const distance = editDistance(
          lastSegment.toLowerCase(),
          candidate.sym.name.toLowerCase()
        );
        if (distance <= 2 && (!best || distance < best.distance)) {
          best = { name: candidate.sym.name, distance };
        }
      }
      if (best) {
        actions.push({
          title: `Change to '${best.name}'`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: {
            changes: {
              [model.uri]: [{ range: diagnostic.range, newText: best.name }],
            },
          },
        });
      }

      // 4. Create the missing declaration, with the kind implied by the usage.
      // Scalar types are a missing import, not a missing declaration.
      if (!libraryHit && lastSegment && !SCALAR_TYPES.has(lastSegment)) {
        const ref = refAtPosition(
          model,
          diagnostic.range.start.line,
          diagnostic.range.start.character
        );
        const declaration = missingDeclaration(ref?.kind, lastSegment);
        const scope = fileScopeInsertion(document);
        actions.push({
          title: `Create ${declaration.label} '${lastSegment}'`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: {
            changes: {
              [model.uri]: [
                {
                  range: {
                    start: { line: scope.line, character: 0 },
                    end: { line: scope.line, character: 0 },
                  },
                  newText: `${declaration.text.replace(/\n/g, '\n' + scope.indent)}\n\n`,
                },
              ],
            },
          },
        });
      }
    }

    // 5. Extract a requirement from a comment on the current line.
    const lineText = document.getText().split(/\r?\n/)[params.range.start.line] ?? '';
    const blockComment = /\/\*\s*(.*?)\s*\*\//.exec(lineText);
    const lineComment = /\/\/\s*(.+)$/.exec(lineText);
    const comment = blockComment?.[1] ?? lineComment?.[1];
    if (comment && comment.trim().length > 3) {
      const name = requirementNameFrom(comment);
      const indent = /^\s*/.exec(lineText)?.[0] ?? '';
      const text =
        `${indent}requirement def ${name} {\n` +
        `${indent}  doc /* ${comment.trim().replace(/\*\//g, '')} */\n` +
        `${indent}}\n`;
      actions.push({
        title: `Extract requirement '${name}' from comment`,
        kind: CodeActionKind.RefactorExtract,
        edit: {
          changes: {
            [model.uri]: [
              {
                range: {
                  start: { line: params.range.start.line + 1, character: 0 },
                  end: { line: params.range.start.line + 1, character: 0 },
                },
                newText: text,
              },
            ],
          },
        },
      });
    }

    // 6. Create an allocation that satisfies the requirement under the cursor.
    const symbol = symbolAtPosition(
      model,
      params.range.start.line,
      params.range.start.character
    );
    if (symbol && /Requirement/.test(symbol.kind) && !symbol.isFileRoot && !symbol.library) {
      const indent =
        /^\s*/.exec(document.getText().split(/\r?\n/)[symbol.range.start.line] ?? '')?.[0] ?? '';
      const text =
        `\n${indent}allocation def ${symbol.name}Satisfaction {\n` +
        `${indent}  satisfy ${symbol.name};\n` +
        `${indent}}\n`;
      actions.push({
        title: `Create allocation satisfying '${symbol.name}'`,
        kind: CodeActionKind.RefactorExtract,
        edit: {
          changes: {
            [model.uri]: [
              {
                range: {
                  start: { line: symbol.range.end.line + 1, character: 0 },
                  end: { line: symbol.range.end.line + 1, character: 0 },
                },
                newText: text,
              },
            ],
          },
        },
      });
    }

    return actions;
  });
}
