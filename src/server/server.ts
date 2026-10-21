import {
  CodeActionKind,
  createConnection,
  DidChangeWatchedFilesNotification,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseText } from './parser.js';
import { Workspace } from './workspace.js';
import type { DocumentModel } from './model.js';
import type { IndexProgress } from '../shared/protocol.js';
import {
  SEMANTIC_TOKEN_MODIFIERS,
  SEMANTIC_TOKEN_TYPES,
} from './navigation.js';
import type { FeatureContext } from './features/context.js';
import { registerDiagnostics, validateOpenDocuments } from './features/diagnostics.js';
import { registerLanguageFeatures } from './features/language.js';
import { registerRename } from './features/rename.js';
import { registerCodeActions } from './features/codeActions.js';
import { registerFormatting } from './features/formatting.js';
import { registerNavigation } from './features/navigation.js';
import { registerGraph } from './features/graph.js';
import { registerModelTree } from './features/modelTree.js';
import { registerTraceability } from './features/traceability.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const workspace = new Workspace();

let libraryEnabled = true;
let unresolvedWarnings = true;
let maxGraphNodes = 300;
let formatAlignMembers = false;
let libraryPath = '';

/**
 * Library indexing runs in the background. Track when a request last arrived so
 * the indexer can pause between files and answer it promptly.
 */
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

function isLibraryUri(uri: string): boolean {
  return (
    libraryPath.length > 0 &&
    uri.startsWith('file://') &&
    decodeURIComponent(uri.slice(7)).startsWith(libraryPath)
  );
}

function updateDocument(
  uri: string,
  text: string,
  library: boolean,
  fast = false
): DocumentModel {
  return workspace.update(uri, parseText(text, fast), library);
}

function uriToFsPath(uri: string): string {
  return decodeURIComponent(uri.slice(7));
}

function fsPathToUri(fsPath: string): string {
  return 'file://' + encodeURI(fsPath).replace(/#/g, '%23');
}

/** Shared dependencies for the feature modules. */
const featureContext: FeatureContext = {
  connection,
  documents,
  workspace,
  config: {
    libraryEnabled: () => libraryEnabled,
    unresolvedWarnings: () => unresolvedWarnings,
    maxGraphNodes: () => maxGraphNodes,
    formatAlignMembers: () => formatAlignMembers,
    isLibraryUri,
  },
};

registerDiagnostics(featureContext);
registerLanguageFeatures(featureContext);
registerRename(featureContext);
registerCodeActions(featureContext);
registerFormatting(featureContext);
registerNavigation(featureContext);
registerGraph(featureContext);
registerModelTree(featureContext);
registerTraceability(featureContext);

async function loadLibrary(dir: string): Promise<void> {
  const files: string[] = [];
  const walkDir = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walkDir(full);
      } else if (/\.(sysml|kerml)$/i.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walkDir(dir);

  // Parse one file per turn so the event loop can service LSP requests in
  // between. A library file takes up to a couple of seconds to parse, so
  // batching several of them would stall the graph, hover and completion.
  connection.sendNotification('sysml/indexProgress', { done: 0, total: files.length });
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    // Give an in-flight request priority over the next library file.
    const deadline = Date.now() + 500;
    while (Date.now() - lastRequestAt < 120 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    try {
      const text = fs.readFileSync(file, 'utf8');
      const model = updateDocument(fsPathToUri(file), text, true, true);
      model.errors = []; // syntax noise in library files is not actionable for users
    } catch {
      // ignore unreadable library files
    }
    if (i % 5 === 0 || i === files.length - 1) {
      const progress: IndexProgress = { done: i + 1, total: files.length };
      connection.sendNotification('sysml/indexProgress', progress);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function scanWorkspaceFolders(): Promise<void> {
  const folders = await connection.workspace.getWorkspaceFolders();
  if (!folders) {
    return;
  }
  for (const folder of folders) {
    if (!folder.uri.startsWith('file://')) {
      continue;
    }
    const root = uriToFsPath(folder.uri);
    const files: string[] = [];
    const walkDir = (current: string, depth: number): void => {
      if (depth > 12) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          // The bundled standard library is indexed separately and with a
          // faster parser; scanning it here would parse it twice.
          if (libraryPath && (full === libraryPath || full.startsWith(libraryPath + path.sep))) {
            continue;
          }
          walkDir(full, depth + 1);
        } else if (/\.(sysml|kerml)$/i.test(entry.name)) {
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
        // ignore unreadable workspace files
      }
    }
  }
}

connection.onInitialize((params) => {
  libraryPath = params.initializationOptions?.libraryPath ?? '';
  libraryEnabled = params.initializationOptions?.libraryEnable ?? true;
  unresolvedWarnings = params.initializationOptions?.unresolvedWarning ?? true;
  maxGraphNodes = params.initializationOptions?.maxNodes ?? 300;
  formatAlignMembers = params.initializationOptions?.formatAlignMembers ?? false;

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      documentFormattingProvider: true,
      renameProvider: { prepareProvider: true },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.RefactorExtract],
      },
      semanticTokensProvider: {
        legend: {
          tokenTypes: [...SEMANTIC_TOKEN_TYPES],
          tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
        },
        full: true,
      },
      foldingRangeProvider: true,
      inlayHintProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
        retriggerCharacters: [','],
      },
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

  // Warm the ANTLR ATN/DFA caches once. The first parse of any document costs
  // about two seconds because the grammar tables are built lazily; doing it
  // here keeps later files in the single-digit millisecond range.
  setTimeout(() => {
    try {
      parseText('package Warmup { part def Element; }', true);
    } catch {
      // Warm-up is best effort and must never affect startup.
    }
  }, 0);

  void (async () => {
    await scanWorkspaceFolders();
    if (libraryEnabled && libraryPath) {
      // Let the first requests (opening a file, drawing the graph) through
      // before the background index starts competing for the event loop.
      await new Promise((resolve) => setTimeout(resolve, 600));
      await loadLibrary(libraryPath);
    }
    validateOpenDocuments(featureContext);
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
  if (typeof settings.format?.alignMembers === 'boolean') {
    formatAlignMembers = settings.format.alignMembers;
  }
  validateOpenDocuments(featureContext);
});

documents.listen(connection);
connection.listen();
