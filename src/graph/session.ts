import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { GraphData } from '../shared/protocol';
import { toDot } from './dot';

export type DiagramMode = 'bdd' | 'ibd';

/**
 * Diagram state for the editor-area panel: fetches the payload for the current
 * document and handles messages coming from the webview.
 *
 * Webview protocol:
 *   in  { type: 'graph', data: GraphData | null }
 *   out { command: 'ready' | 'open' | 'export' | 'exportFailed' }
 */
export class GraphSession {
  private refreshTimer: NodeJS.Timeout | undefined;
  /** Last document we drew; survives focus moving to the graph panel. */
  private lastGraphUri: string | undefined;
  private mode: DiagramMode = 'bdd';

  constructor(
    readonly context: vscode.ExtensionContext,
    private readonly getClient: () => LanguageClient | undefined
  ) {}

  /** Switch between the block definition and internal block diagrams. */
  setMode(mode: DiagramMode): void {
    this.mode = mode;
  }

  getMode(): DiagramMode {
    return this.mode;
  }

  /** Debounced refresh, used for model-change notifications. */
  scheduleRefresh(webviews: () => vscode.Webview[]): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => void this.refresh(webviews), 250);
  }

  /** Push the diagram to every webview currently provided by the caller. */
  async refresh(webviews: () => vscode.Webview[]): Promise<void> {
    const data = await this.currentGraph();
    for (const webview of webviews()) {
      void webview.postMessage({ type: 'graph', data: data ?? null });
    }
  }

  /**
   * Push the diagram to one specific webview, whether or not it already reports
   * itself visible. Used for the initial handshake, where visibility may not be
   * settled yet.
   */
  async refreshOne(webview: vscode.Webview): Promise<void> {
    const data = await this.currentGraph();
    try {
      await webview.postMessage({ type: 'graph', data: data ?? null });
    } catch {
      // The panel can be disposed between the request and the reply.
    }
  }

  async currentGraph(): Promise<GraphData | undefined> {
    const uri = this.graphDocumentUri();
    if (!uri) {
      return undefined;
    }
    const client = this.getClient();
    if (!client) {
      return undefined;
    }
    const cfg = vscode.workspace.getConfiguration('sysml');
    const active = vscode.window.activeTextEditor;
    const cursor =
      active && active.document.uri.toString() === uri ? active.selection.active : undefined;

    try {
      if (this.mode === 'ibd') {
        // The IBD is scoped to the part definition under the cursor.
        return await client.sendRequest<GraphData>('sysml/ibd', {
          uri,
          line: cursor?.line,
          character: cursor?.character,
        });
      }
      return await client.sendRequest<GraphData>('sysml/graph', {
        uri,
        maxNodes: cfg.get<number>('graph.maxNodes', 300),
      });
    } catch (err) {
      void vscode.window.showWarningMessage(`SysML: could not build the diagram: ${err}`);
      return undefined;
    }
  }

  /**
   * The document to draw. Prefers the active editor, then any visible SysML
   * editor, then the last document we drew. Without this fallback, focusing the
   * graph panel (which clears the active text editor) would blank the diagram.
   */
  private graphDocumentUri(): string | undefined {
    const active = vscode.window.activeTextEditor;
    if (active && /^(sysml|kerml)$/.test(active.document.languageId)) {
      this.lastGraphUri = active.document.uri.toString();
      return this.lastGraphUri;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (/^(sysml|kerml)$/.test(editor.document.languageId)) {
        this.lastGraphUri = editor.document.uri.toString();
        return this.lastGraphUri;
      }
    }
    return this.lastGraphUri;
  }

  /** Handle a message posted by the diagram webview. */
  async handleMessage(msg: {
    command?: string;
    id?: string;
    format?: string;
    data?: string;
    message?: string;
  }): Promise<void> {
    switch (msg?.command) {
      case 'open':
        if (typeof msg.id === 'string') {
          await this.openNode(msg.id);
        }
        break;
      case 'export':
        if (typeof msg.data === 'string') {
          await this.saveExport(msg.format === 'svg' ? 'svg' : 'png', msg.data);
        }
        break;
      case 'exportFailed':
        void vscode.window.showWarningMessage(`SysML: ${msg.message}`);
        break;
      default:
        break;
    }
  }

  /** Reveal the declaration encoded in a diagram node id (`uri#line:character`). */
  private async openNode(id: string): Promise<void> {
    const hash = id.lastIndexOf('#');
    if (hash < 0) {
      return;
    }
    const uri = vscode.Uri.parse(id.slice(0, hash));
    const [line, character] = id
      .slice(hash + 1)
      .split(':')
      .map((n) => parseInt(n, 10) || 0);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const position = new vscode.Position(line, character);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenter
    );
  }

  /** Write a webview-produced PNG data URI or SVG string to disk. */
  private async saveExport(format: 'png' | 'svg', data: string): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`sysml-diagram.${format}`),
      filters: format === 'svg' ? { 'SVG image': ['svg'] } : { 'PNG image': ['png'] },
    });
    if (!target) {
      return;
    }
    const bytes =
      format === 'png'
        ? Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64')
        : Buffer.from(data, 'utf8');
    await fs.writeFile(target.fsPath, bytes);
    void vscode.window.showInformationMessage(`SysML: diagram exported to ${target.fsPath}`);
  }

  /** Write the current diagram as a Graphviz DOT file. */
  async exportDot(): Promise<void> {
    const data = await this.currentGraph();
    if (!data) {
      void vscode.window.showInformationMessage('SysML: open a .sysml/.kerml file first.');
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('sysml-diagram.dot'),
      filters: { 'DOT graph': ['dot'] },
    });
    if (target) {
      await fs.writeFile(target.fsPath, toDot(data), 'utf8');
      void vscode.window.showInformationMessage(`SysML: diagram exported to ${target.fsPath}`);
    }
  }
}
