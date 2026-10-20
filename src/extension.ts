import * as vscode from 'vscode';
import * as path from 'node:path';
import { LanguageClient } from 'vscode-languageclient/node';
import type { LanguageClientOptions } from 'vscode-languageclient/node';
import { GraphSession, SysmlGraphPanel } from './graphView';
import { SysmlModelExplorer } from './modelExplorer';
import { SysmlTraceabilityPanel } from './traceability';
import { registerAgentPanel } from './ai/agentPanel';
import { registerEditPreview } from './ai/editPreview';
import { registerInlineAssist } from './ai/inlineAssist';

let client: LanguageClient | undefined;
let context: vscode.ExtensionContext | undefined;

function initializationOptions(): unknown {
  const cfg = vscode.workspace.getConfiguration('sysml');
  return {
    libraryPath: context?.asAbsolutePath('library'),
    libraryEnable: cfg.get<boolean>('library.enable', true),
    unresolvedWarning: cfg.get<boolean>('validation.unresolvedReference', true),
    maxNodes: cfg.get<number>('graph.maxNodes', 300),
  };
}

/** Build a language client; recreated on restart so initialization options are re-read. */
function createClient(): LanguageClient {
  if (!context) {
    throw new Error('SysML v2 extension is not active');
  }
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

  // Set SYSML_SERVER_INSPECT=<port> to expose the language server for the
  // "Attach to Language Server" debug configuration (see .vscode/launch.json).
  const inspectPort = process.env.SYSML_SERVER_INSPECT;
  const execArgv = inspectPort ? [`--inspect=${inspectPort}`] : [];

  const serverOptions = {
    module: serverModule,
    transport: 1, // stdio
    options: { execArgv },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'sysml' },
      { scheme: 'file', language: 'kerml' },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{sysml,kerml}'),
    },
    initializationOptions: initializationOptions(),
  };

  return new LanguageClient('sysml', 'SysML v2 Language Server', serverOptions, clientOptions);
}

export async function activate(extensionContext: vscode.ExtensionContext): Promise<void> {
  context = extensionContext;
  const session = new GraphSession(context, () => client);
  const graphPanel = new SysmlGraphPanel(session);
  const modelExplorer = new SysmlModelExplorer(() => client);
  const traceability = new SysmlTraceabilityPanel(() => client);

  const refreshGraph = (): Promise<void> => session.refresh(() => graphPanel.webviews());

  // Register the views before anything that can fail, so a slow or failing
  // language server never leaves a view without its provider.
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(SysmlModelExplorer.viewType, modelExplorer),
    graphPanel,
    vscode.commands.registerCommand('sysml.refreshModelExplorer', () => modelExplorer.refresh()),
    vscode.commands.registerCommand('sysml.openGraphPanel', () => graphPanel.show()),
    vscode.commands.registerCommand('sysml.openTraceability', () => traceability.show()),
    vscode.commands.registerCommand('sysml.refreshGraph', () => refreshGraph()),
    vscode.commands.registerCommand('sysml.exportGraph', () => session.exportDot()),
    vscode.window.onDidChangeActiveTextEditor(() => void refreshGraph())
  );

  // AI features are registered up front as well: the commands explain how to
  // enable a model when none is available, instead of failing silently.
  registerEditPreview(context);
  registerInlineAssist(context, () => client);
  if (typeof vscode.chat?.createChatParticipant === 'function') {
    registerAgentPanel(context, () => client);
  }

  // Re-register the model-change notification on every new client instance.
  const attachNotifications = (c: LanguageClient): void => {
    c.onNotification('sysml/modelChanged', () => {
      session.scheduleRefresh(() => graphPanel.webviews());
      modelExplorer.scheduleRefresh();
      void traceability.refresh();
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('sysml.restartServer', async () => {
      await client?.stop();
      client = createClient();
      attachNotifications(client);
      await client.start();
      modelExplorer.scheduleRefresh();
    })
  );

  client = createClient();
  attachNotifications(client);

  try {
    await client.start();
    modelExplorer.scheduleRefresh();
    // The panel may already be open from a previous session.
    void refreshGraph();
  } catch (err) {
    void vscode.window.showErrorMessage(`SysML v2: failed to start language server: ${err}`);
  }
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
