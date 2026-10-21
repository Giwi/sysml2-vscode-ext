import { SymbolKind } from 'vscode-languageserver/node.js';
import type { Location, SymbolInformation } from 'vscode-languageserver/node.js';
import { refAtPosition, symbolAtPosition } from '../model.js';
import type { DocumentModel, SysmlSymbol } from '../model.js';
import type { IndexedSymbol } from '../workspace.js';
import type { FeatureContext } from './context.js';

const KEYWORDS = [
  'about', 'abstract', 'accept', 'action', 'actor', 'after', 'alias', 'all', 'allocate', 'allocation',
  'analysis', 'and', 'as', 'assert', 'assign', 'assume', 'at', 'attribute', 'bind', 'binding', 'by',
  'calc', 'case', 'comment', 'concern', 'connect', 'connection', 'connector', 'const', 'constant',
  'constraint', 'crosses', 'decide', 'def', 'default', 'defined', 'dependency', 'derived', 'do',
  'doc', 'else', 'end', 'entry', 'enum', 'event', 'exhibit', 'exit', 'expose', 'false', 'filter',
  'first', 'flow', 'for', 'fork', 'frame', 'from', 'hastype', 'if', 'implies', 'import', 'in',
  'include', 'individual', 'inout', 'interface', 'istype', 'item', 'join', 'language', 'library',
  'locale', 'loop', 'merge', 'message', 'meta', 'metadata', 'new', 'nonunique', 'not', 'null',
  'objective', 'occurrence', 'of', 'or', 'ordered', 'out', 'package', 'parallel', 'part', 'perform',
  'port', 'private', 'protected', 'public', 'redefines', 'ref', 'references', 'render', 'rendering',
  'rep', 'require', 'requirement', 'return', 'satisfy', 'send', 'snapshot', 'specializes',
  'stakeholder', 'standard', 'state', 'subject', 'subsets', 'succession', 'terminate', 'then',
  'timeslice', 'to', 'transition', 'true', 'until', 'use', 'variant', 'variation', 'verification',
  'verify', 'via', 'view', 'viewpoint', 'when', 'while', 'xor',
];

function toDocumentSymbols(symbols: SysmlSymbol[]): any[] {
  return symbols.map((sym) => ({
    name: sym.name,
    detail: sym.kind,
    kind: symbolKindOf(sym.kind),
    range: sym.range,
    selectionRange: sym.nameRange,
    children: toDocumentSymbols(sym.children),
  }));
}

function symbolKindOf(kind: string): SymbolKind {
  switch (kind) {
    case 'Package':
    case 'Namespace':
    case 'File':
      return SymbolKind.Package;
    case 'Part Definition':
      return SymbolKind.Class;
    case 'Item Definition':
    case 'Attribute Definition':
    case 'Port Definition':
    case 'Interface Definition':
      return SymbolKind.Struct;
    case 'Enumeration':
      return SymbolKind.Enum;
    case 'Action Definition':
    case 'Action':
      return SymbolKind.Function;
    case 'State Definition':
    case 'State':
      return SymbolKind.Event;
    case 'Constraint Definition':
    case 'Calculation Definition':
      return SymbolKind.Object;
    case 'Requirement Definition':
    case 'Requirement':
      return SymbolKind.Interface;
    case 'Connector':
    case 'Binding Connector':
    case 'Succession':
    case 'Flow':
      return SymbolKind.Object;
    default:
      return SymbolKind.Field;
  }
}

function fuzzyScore(query: string, target: string): number {
  if (!query) {
    return 1;
  }
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const index = t.indexOf(q);
  if (index === 0) {
    return 1000 - t.length;
  }
  if (index > 0) {
    return 500 - index - t.length;
  }
  // Subsequence fallback.
  let targetIndex = 0;
  let score = 100;
  for (const ch of q) {
    const found = t.indexOf(ch, targetIndex);
    if (found < 0) {
      return 0;
    }
    score -= found - targetIndex;
    targetIndex = found + 1;
  }
  return Math.max(score, 1);
}

function locationOf(model: DocumentModel, sym: SysmlSymbol): Location {
  return { uri: model.uri, range: sym.nameRange };
}

function completionItemKindOf(kind: string): number {
  switch (kind) {
    case 'Package':
    case 'Namespace':
      return 9; // Module
    case 'Enumeration':
      return 13; // Enum
    case 'Action':
    case 'Action Definition':
      return 3; // Function
    default:
      return 7; // Field
  }
}

/**
 * Core language features: outline, workspace symbols, definition, references,
 * hover and completion.
 */
export function registerLanguageFeatures(ctx: FeatureContext): void {
  ctx.connection.onDocumentSymbol((params) => {
    const model = ctx.workspace.docs.get(params.textDocument.uri);
    return model ? toDocumentSymbols(model.symbols) : [];
  });

  ctx.connection.onWorkspaceSymbol((params) => {
    const scored: { sym: SysmlSymbol; model: DocumentModel; score: number }[] = [];
    for (const { sym, model } of ctx.workspace.allSymbols()) {
      if (model.library) {
        continue; // keep search focused on user files
      }
      const score = Math.max(
        fuzzyScore(params.query, sym.name),
        fuzzyScore(params.query, sym.qname)
      );
      if (score > 0) {
        scored.push({ sym, model, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 200).map(
      ({ sym, model }): SymbolInformation => ({
        name: sym.qname || sym.name,
        kind: symbolKindOf(sym.kind),
        containerName: sym.kind,
        location: { uri: model.uri, range: sym.range },
      })
    );
  });

  ctx.connection.onDefinition((params) => {
    const model = ctx.workspace.docs.get(params.textDocument.uri);
    if (!model) {
      return null;
    }
    const { line, character } = params.position;
    const ref = refAtPosition(model, line, character);
    if (ref?.resolved) {
      return { uri: ref.resolved.uri, range: ref.resolved.selectionRange };
    }
    const sym = symbolAtPosition(model, line, character);
    return sym ? locationOf(model, sym) : null;
  });

  ctx.connection.onReferences((params) => {
    const model = ctx.workspace.docs.get(params.textDocument.uri);
    if (!model) {
      return [];
    }
    const { line, character } = params.position;

    let targetId: string | undefined;
    let targetQName: string | undefined;
    let targetUri: string | undefined;

    const ref = refAtPosition(model, line, character);
    if (ref?.resolved) {
      targetQName = ref.resolved.qname;
      targetUri = ref.resolved.uri;
    } else {
      const sym = symbolAtPosition(model, line, character);
      if (!sym) {
        return [];
      }
      targetId = sym.id;
      targetQName = sym.qname;
      targetUri = model.uri;
    }

    const locations: Location[] = [];
    for (const docModel of ctx.workspace.docs.values()) {
      if (docModel.library) {
        continue;
      }
      const visit = (sym: SysmlSymbol): void => {
        if (sym.id === targetId) {
          locations.push({ uri: docModel.uri, range: sym.nameRange });
        }
        for (const child of sym.children) {
          visit(child);
        }
        for (const item of sym.refs) {
          if (
            item.resolved &&
            item.resolved.qname === targetQName &&
            item.resolved.uri === targetUri
          ) {
            locations.push({ uri: docModel.uri, range: item.range });
          }
        }
      };
      visit(docModel.root);
    }
    return locations;
  });

  ctx.connection.onHover((params) => {
    const model = ctx.workspace.docs.get(params.textDocument.uri);
    if (!model) {
      return null;
    }
    const { line, character } = params.position;

    const ref = refAtPosition(model, line, character);
    if (ref) {
      if (ref.resolved) {
        const lib = ctx.workspace.docs.get(ref.resolved.uri)?.library
          ? ' *(standard library)*'
          : '';
        return {
          contents: {
            kind: 'markdown',
            value: `**${ref.resolved.qname}** — ${ref.resolved.kind}${lib}\n\nReferenced as \`${ref.text}\` (${ref.kind})`,
          },
          range: ref.range,
        };
      }
      return {
        contents: {
          kind: 'markdown',
          value: `**${ref.text}** — unresolved ${ref.kind} reference`,
        },
        range: ref.range,
      };
    }

    const sym = symbolAtPosition(model, line, character);
    if (sym && !sym.isFileRoot) {
      const parent = sym.parent && !sym.parent.isFileRoot ? ` in \`${sym.parent.qname}\`` : '';
      return {
        contents: {
          kind: 'markdown',
          value: `**${sym.name}** — ${sym.kind}${parent}\n\nQualified name: \`${sym.qname}\``,
        },
        range: sym.nameRange,
      };
    }
    return null;
  });

  ctx.connection.onCompletion((params) => {
    const model = ctx.workspace.docs.get(params.textDocument.uri);
    const items: any[] = [];

    for (const keyword of KEYWORDS) {
      items.push({
        label: keyword,
        kind: 14 /* Keyword */,
        detail: 'SysML keyword',
        sortText: `2_${keyword}`,
      });
    }

    if (model) {
      const seen = new Set<string>();
      const scope =
        symbolAtPosition(model, params.position.line, params.position.character) ?? model.root;

      // Visible symbols: scope chain + file level + globals (workspace first).
      const visible: IndexedSymbol[] = [];
      let current: SysmlSymbol | undefined = scope;
      while (current) {
        for (const child of current.children) {
          visible.push({ sym: child, model });
        }
        current = current.parent;
      }
      for (const symbol of model.symbols) {
        visible.push({ sym: symbol, model });
      }
      for (const entry of ctx.workspace.allSymbols()) {
        if (!entry.model.library && entry.model !== model) {
          visible.push(entry);
        }
      }

      for (const { sym } of visible) {
        if (seen.has(sym.name)) {
          continue;
        }
        seen.add(sym.name);
        items.push({
          label: sym.name,
          kind: completionItemKindOf(sym.kind),
          detail: sym.kind,
          sortText: `1_${sym.name}`,
        });
        if (items.length > 400) {
          break;
        }
      }
    }

    return items;
  });
}
