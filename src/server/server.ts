import {
  createConnection,
  DiagnosticSeverity,
  DidChangeWatchedFilesNotification,
  ProposedFeatures,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node.js';
import type { Diagnostic, Location, SymbolInformation } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseText } from './parser.js';
import { refAtPosition, symbolAtPosition } from './model.js';
import type { DocumentModel, SysmlSymbol } from './model.js';
import { Workspace } from './workspace.js';
import type { IndexedSymbol } from './workspace.js';

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

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const workspace = new Workspace();

// Library indexing runs in the background. Track when a request last arrived so
// the indexer can pause between files and answer it promptly.
let lastRequestAt = 0;

for (const method of [
  'onRequest',
  'onHover',
  'onDefinition',
  'onReferences',
  'onCompletion',
  'onDocumentSymbol',
  'onWorkspaceSymbol',
] as const) {
  const original = (connection as any)[method].bind(connection);
  (connection as any)[method] = (first: any, second?: any) => {
    const track = (handler: any) => (...args: any[]) => {
      lastRequestAt = Date.now();
      return handler(...args);
    };
    return second === undefined ? original(track(first)) : original(first, track(second));
  };
}

let libraryEnabled = true;
let unresolvedWarnings = true;
let maxGraphNodes = 300;
let libraryPath = '';

function isLibraryUri(uri: string): boolean {
  return libraryPath.length > 0 && uri.startsWith('file://') && decodeURIComponent(uri.slice(7)).startsWith(libraryPath);
}

function updateDocument(uri: string, text: string, library: boolean, fast = false): DocumentModel {
  return workspace.update(uri, parseText(text, fast), library);
}

function uriToFsPath(uri: string): string {
  return decodeURIComponent(uri.slice(7));
}

function fsPathToUri(p: string): string {
  return 'file://' + encodeURI(p).replace(/#/g, '%23');
}

async function loadLibrary(dir: string): Promise<void> {
  const files: string[] = [];
  const walkDir = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walkDir(full);
      } else if (/\.(sysml|kerml)$/i.test(e.name)) {
        files.push(full);
      }
    }
  };
  walkDir(dir);

  // Parse one file per turn so the event loop can service LSP requests in
  // between. A library file takes up to a couple of seconds to parse, so
  // batching several of them would stall the graph, hover and completion.
  for (const file of files) {
    // Give an in-flight request priority over the next library file.
    const deadline = Date.now() + 500;
    while (Date.now() - lastRequestAt < 120 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    try {
      const text = fs.readFileSync(file, 'utf8');
      const model = updateDocument(fsPathToUri(file), text, true, true);
      model.errors = []; // syntax noise in library files is not actionable for users
    } catch {
      // ignore unreadable library files
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function scanWorkspaceFolders(): Promise<void> {
  const folders = await connection.workspace.getWorkspaceFolders();
  if (!folders) {
    return;
  }
  for (const folder of folders) {
    if (folder.uri.startsWith('file://')) {
      const root = uriToFsPath(folder.uri);
      const files: string[] = [];
      const walkDir = (d: string, depth: number): void => {
        if (depth > 12) {
          return;
        }
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name === 'node_modules') {
            continue;
          }
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            // The bundled standard library is indexed separately and with a
            // faster parser; scanning it here would parse it twice.
            if (libraryPath && (full === libraryPath || full.startsWith(libraryPath + path.sep))) {
              continue;
            }
            walkDir(full, depth + 1);
          } else if (/\.(sysml|kerml)$/i.test(e.name)) {
            files.push(full);
          }
        }
      };
      walkDir(root, 0);
      for (const file of files) {
        const uri = fsPathToUri(file);
        if (documents.get(uri)) {
          continue; // open documents are managed by TextDocuments
        }
        try {
          updateDocument(uri, fs.readFileSync(file, 'utf8'), false);
        } catch {
          // ignore
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function validate(model: DocumentModel): void {
  const diagnostics: Diagnostic[] = [];

  for (const err of model.errors) {
    diagnostics.push({
      range: {
        start: { line: err.line, character: err.column },
        end: { line: err.line, character: err.column + 1 },
      },
      severity: DiagnosticSeverity.Error,
      source: 'sysml',
      message: `Syntax error: ${err.message}`,
    });
  }

  // Duplicate declarations are a local property of the file, so they are
  // reported even when the standard library is not indexed.
  const checkDuplicates = (sym: SysmlSymbol): void => {
    const seen = new Map<string, SysmlSymbol>();
    for (const child of sym.children) {
      const prev = seen.get(child.name);
      if (prev) {
        diagnostics.push({
          range: child.nameRange,
          severity: DiagnosticSeverity.Error,
          source: 'sysml',
          message: `Duplicate declaration '${child.name}' (already declared as ${prev.kind.toLowerCase()})`,
        });
      } else {
        seen.set(child.name, child);
      }
      checkDuplicates(child);
    }
  };
  checkDuplicates(model.root);

  // Unresolved-reference warnings need the library index: without it every
  // standard-library type would look unresolved and flood the file.
  if (unresolvedWarnings && libraryEnabled) {
    const visit = (sym: SysmlSymbol): void => {
      for (const ref of sym.refs) {
        if (!ref.resolved && ref.kind !== 'dependency') {
          diagnostics.push({
            range: ref.range,
            severity: DiagnosticSeverity.Warning,
            source: 'sysml',
            message: `Unresolved reference '${ref.text}'`,
          });
        }
      }
      for (const c of sym.children) {
        visit(c);
      }
    };
    visit(model.root);
  }

  connection.sendDiagnostics({ uri: model.uri, diagnostics });
}

function validateOpenDocuments(): void {
  for (const doc of documents.all()) {
    const model = workspace.docs.get(doc.uri);
    if (model) {
      workspace.resolveRefs(model);
      validate(model);
    }
  }
}

documents.onDidOpen((e) => {
  const model = updateDocument(e.document.uri, e.document.getText(), isLibraryUri(e.document.uri));
  validate(model);
});

documents.onDidChangeContent((e) => {
  const model = updateDocument(e.document.uri, e.document.getText(), isLibraryUri(e.document.uri));
  validate(model);
  connection.sendNotification('sysml/modelChanged', { uri: e.document.uri });
});

documents.onDidClose((e) => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

connection.onDidChangeWatchedFiles(async (params) => {
  for (const change of params.changes) {
    const uri = change.uri;
    if (documents.get(uri)) {
      continue; // open docs are handled by TextDocuments
    }
    if (change.type === 3 /* Deleted */) {
      workspace.remove(uri);
      continue;
    }
    try {
      const fsPath = uriToFsPath(uri);
      updateDocument(uri, fs.readFileSync(fsPath, 'utf8'), isLibraryUri(uri));
    } catch {
      workspace.remove(uri);
    }
  }
  validateOpenDocuments();
  connection.sendNotification('sysml/modelChanged', { uri: '' });
});

// ---------------------------------------------------------------------------
// LSP features
// ---------------------------------------------------------------------------

connection.onInitialize((params) => {
  libraryPath = params.initializationOptions?.libraryPath ?? '';
  libraryEnabled = params.initializationOptions?.libraryEnable ?? true;
  unresolvedWarnings = params.initializationOptions?.unresolvedWarning ?? true;
  maxGraphNodes = params.initializationOptions?.maxNodes ?? 300;

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      completionProvider: {
        triggerCharacters: [':', '.', ' ', '>'],
        resolveProvider: false,
      },
      workspace: {
        workspaceFolders: { supported: true },
      },
    },
  };
});

connection.onInitialized(() => {
  connection.client
    .register(DidChangeWatchedFilesNotification.type, {
      watchers: [{ globPattern: '**/*.{sysml,kerml}' }],
    })
    .catch(() => {
      /* client without file watcher support */
    });

  void (async () => {
    await scanWorkspaceFolders();
    if (libraryEnabled && libraryPath) {
      // Let the first requests (opening a file, drawing the graph) through
      // before the background index starts competing for the event loop.
      await new Promise((r) => setTimeout(r, 600));
      await loadLibrary(libraryPath);
    }
    validateOpenDocuments();
  })();
});

connection.onDidChangeConfiguration((change) => {
  const settings = change.settings?.sysml ?? {};
  if (typeof settings.library?.enable === 'boolean') {
    libraryEnabled = settings.library.enable;
  }
  if (settings.validation?.unresolvedReference !== undefined) {
    unresolvedWarnings = !!settings.validation.unresolvedReference;
  }
  if (typeof settings.graph?.maxNodes === 'number') {
    maxGraphNodes = settings.graph.maxNodes;
  }
  validateOpenDocuments();
});

// --- Document symbols (outline / breadcrumbs) ---

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

connection.onDocumentSymbol((params) => {
  const model = workspace.docs.get(params.textDocument.uri);
  if (!model) {
    return [];
  }
  return toDocumentSymbols(model.symbols);
});

// --- Workspace symbol search (Ctrl+T) ---

function fuzzyScore(query: string, target: string): number {
  if (!query) {
    return 1;
  }
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const idx = t.indexOf(q);
  if (idx === 0) {
    return 1000 - t.length;
  }
  if (idx > 0) {
    return 500 - idx - t.length;
  }
  // subsequence fallback
  let ti = 0;
  let score = 100;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) {
      return 0;
    }
    score -= found - ti;
    ti = found + 1;
  }
  return Math.max(score, 1);
}

connection.onWorkspaceSymbol((params) => {
  const scored: { sym: SysmlSymbol; model: DocumentModel; score: number }[] = [];
  for (const { sym, model } of workspace.allSymbols()) {
    if (model.library) {
      continue; // keep search focused on user files
    }
    const score = Math.max(fuzzyScore(params.query, sym.name), fuzzyScore(params.query, sym.qname));
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

// --- Definition / references / hover ---

function locationOf(model: DocumentModel, sym: SysmlSymbol): any {
  return { uri: model.uri, range: sym.nameRange };
}

connection.onDefinition((params) => {
  const model = workspace.docs.get(params.textDocument.uri);
  if (!model) {
    return null;
  }
  const { line, character } = params.position;
  const ref = refAtPosition(model, line, character);
  if (ref?.resolved) {
    return {
      uri: ref.resolved.uri,
      range: ref.resolved.selectionRange,
    };
  }
  const sym = symbolAtPosition(model, line, character);
  if (sym) {
    return locationOf(model, sym);
  }
  return null;
});

connection.onReferences((params) => {
  const model = workspace.docs.get(params.textDocument.uri);
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
  for (const docModel of workspace.docs.values()) {
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
      for (const r of sym.refs) {
        if (r.resolved && r.resolved.qname === targetQName && r.resolved.uri === targetUri) {
          locations.push({ uri: docModel.uri, range: r.range });
        }
      }
    };
    visit(docModel.root);
  }
  return locations;
});

connection.onHover((params) => {
  const model = workspace.docs.get(params.textDocument.uri);
  if (!model) {
    return null;
  }
  const { line, character } = params.position;

  const ref = refAtPosition(model, line, character);
  if (ref) {
    if (ref.resolved) {
      const lib = workspace.docs.get(ref.resolved.uri)?.library ? ' *(standard library)*' : '';
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

// --- Completion ---

connection.onCompletion((params) => {
  const model = workspace.docs.get(params.textDocument.uri);
  const items: any[] = [];

  for (const kw of KEYWORDS) {
    items.push({ label: kw, kind: 14 /* Keyword */, detail: 'SysML keyword', sortText: `2_${kw}` });
  }

  if (model) {
    const seen = new Set<string>();
    const scope = symbolAtPosition(model, params.position.line, params.position.character) ?? model.root;

    // Visible symbols: scope chain + file level + globals (workspace first).
    const visible: IndexedSymbol[] = [];
    let cur: SysmlSymbol | undefined = scope;
    while (cur) {
      for (const c of cur.children) {
        visible.push({ sym: c, model });
      }
      cur = cur.parent;
    }
    for (const s of model.symbols) {
      visible.push({ sym: s, model });
    }
    for (const entry of workspace.allSymbols()) {
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

// --- Structural graph (custom request, rendered by the webview) ---

/**
 * Payload for `sysml/graph`.
 *
 * Node ids are `uri#line:character`, which lets the webview jump back to a
 * declaration without a second request. `children` is a count, not a list:
 * the webview derives containment from the edges so the payload stays small.
 */
interface GraphNode {
  id: string;
  label: string;
  kind: string;
  depth: number;
  children: number;
}

interface GraphEdge {
  from: string;
  to: string;
  kind: string;
  label: string;
}

/**
 * Containment tree plus cross-references for one document.
 *
 * The walk is bounded by `maxNodes` so a pathological file cannot freeze the
 * webview. Cross-reference targets are added only when they belong to a user
 * file: the standard library would add thousands of nodes for no benefit.
 */
connection.onRequest('sysml/graph', (params: { uri: string; maxNodes?: number }) => {
  const model = workspace.docs.get(params.uri);
  if (!model) {
    return null;
  }
  const limit = params.maxNodes ?? maxGraphNodes;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();

  const addNode = (sym: SysmlSymbol, depth: number): boolean => {
    if (nodes.length >= limit) {
      return false;
    }
    if (!nodeIds.has(sym.id)) {
      nodeIds.add(sym.id);
      nodes.push({
        id: sym.id,
        label: sym.name,
        kind: sym.kind,
        depth,
        children: sym.children.length,
      });
    }
    return true;
  };

  const visit = (sym: SysmlSymbol, depth: number): void => {
    if (!addNode(sym, depth)) {
      return;
    }
    for (const child of sym.children) {
      edges.push({ from: sym.id, to: child.id, kind: 'contains', label: '' });
      visit(child, depth + 1);
    }
    for (const ref of sym.refs) {
      if (!ref.resolved) {
        continue;
      }
      const targetModel = workspace.docs.get(ref.resolved.uri);
      const target = targetModel?.root.children.find((c) => c.qname === ref.resolved!.qname);
      if (!target || targetModel?.library) {
        continue;
      }
      addNode(target, depth);
      edges.push({
        from: sym.id,
        to: target.id,
        kind: ref.kind,
        label: ref.kind === 'typing' ? 'typed by' : ref.kind === 'specializes' ? 'specializes' : ref.kind,
      });
    }
  };

  for (const sym of model.symbols) {
    visit(sym, 0);
  }

  return { uri: model.uri, nodes, edges, truncated: nodes.length >= limit };
});

// --- Model Explorer tree ---

interface ModelTreeNode {
  name: string;
  kind: string;
  qname: string;
  uri: string;
  line: number;
  character: number;
  children: ModelTreeNode[];
}

function toModelTree(sym: SysmlSymbol, uri: string): ModelTreeNode {
  return {
    name: sym.name,
    kind: sym.kind,
    qname: sym.qname,
    uri,
    line: sym.nameRange.start.line,
    character: sym.nameRange.start.character,
    children: sym.children.map((c) => toModelTree(c, uri)),
  };
}

/**
 * Whole-model outline for the Model Explorer: one root per user file, with the
 * declaration tree underneath. Standard library files are excluded because
 * they would dominate the tree.
 */
connection.onRequest('sysml/modelTree', () => {
  const files: ModelTreeNode[] = [];
  for (const model of workspace.docs.values()) {
    if (model.library || model.symbols.length === 0) {
      continue;
    }
    files.push({
      name: fileNameOf(model.uri),
      kind: 'File',
      qname: model.uri,
      uri: model.uri,
      line: 0,
      character: 0,
      children: model.symbols.map((sym) => toModelTree(sym, model.uri)),
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
});

function fileNameOf(uri: string): string {
  const slash = uri.lastIndexOf('/');
  return slash >= 0 ? decodeURIComponent(uri.slice(slash + 1)) : uri;
}

// ---------------------------------------------------------------------------

documents.listen(connection);
connection.listen();
