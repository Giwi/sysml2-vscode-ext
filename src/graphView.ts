import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { GraphData } from './shared/protocol';

/** Result of a webview image export, written to disk by the session. */
export interface GraphExport {
  format: 'png' | 'svg';
  data: string;
}

export function colorFor(kind: string): string {
  return KIND_COLORS[kind] ?? '#777d87';
}

const KIND_COLORS: Record<string, string> = {
  Package: '#4f9a6e',
  Namespace: '#4f9a6e',
  'Part Definition': '#3b7dd8',
  Part: '#6aa5e8',
  'Item Definition': '#8a6bd8',
  Item: '#ab90e8',
  'Attribute Definition': '#c07a3a',
  Attribute: '#d69b63',
  'Port Definition': '#b5567e',
  Port: '#cf80a1',
  'Interface Definition': '#3aa8a0',
  Interface: '#6cc5be',
  Enumeration: '#8f8f3f',
  'Enumeration Value': '#b3b36b',
  Action: '#c25050',
  'Action Definition': '#a63d3d',
  State: '#7a6f9e',
  'State Definition': '#61577f',
  Requirement: '#557a3f',
  Flow: '#4a7a8c',
  Connection: '#7a4a8c',
};

/**
 * Shared graph logic for the editor-area panel: fetches the graph for the
 * current document and handles messages coming from the webview.
 *
 * Webview protocol:
 *   in  { type: 'graph', data: GraphData | null }
 *   out { command: 'ready' | 'open' | 'export' | 'exportFailed' }
 */
export class GraphSession {
  private refreshTimer: NodeJS.Timeout | undefined;
  /** Last document we drew; survives focus moving to the graph panel. */
  private lastGraphUri: string | undefined;

  constructor(
    readonly context: vscode.ExtensionContext,
    private readonly getClient: () => LanguageClient | undefined
  ) {}

  /** Debounced refresh, used for model-change notifications. */
  scheduleRefresh(webviews: () => vscode.Webview[]): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => void this.refresh(webviews), 250);
  }

  /** Push the graph to every webview currently provided by the caller. */
  async refresh(webviews: () => vscode.Webview[]): Promise<void> {
    const data = await this.currentGraph();
    for (const webview of webviews()) {
      void webview.postMessage({ type: 'graph', data: data ?? null });
    }
  }

  /**
   * Push the graph to one specific webview, whether or not it already reports
   * itself visible. Used for the initial handshake, where visibility may not
   * be settled yet.
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
    interface GraphRequest {
      uri: string;
      maxNodes: number;
    }
    const cfg = vscode.workspace.getConfiguration('sysml');
    const request: GraphRequest = {
      uri,
      maxNodes: cfg.get<number>('graph.maxNodes', 300),
    };
    try {
      return await client.sendRequest<GraphData>('sysml/graph', request);
    } catch (err) {
      void vscode.window.showWarningMessage(`SysML: could not build the graph: ${err}`);
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

  /** Handle a message posted by the graph webview. */
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

  /** Reveal the declaration encoded in a graph node id (`uri#line:character`). */
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
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const pos = new vscode.Position(line, character);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  /** Write a webview-produced PNG data URI or SVG string to disk. */
  private async saveExport(format: 'png' | 'svg', data: string): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`sysml-graph.${format}`),
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
    void vscode.window.showInformationMessage(`SysML: graph exported to ${target.fsPath}`);
  }

  /** Write the current graph as a Graphviz DOT file. */
  async exportDot(): Promise<void> {
    const data = await this.currentGraph();
    if (!data) {
      void vscode.window.showInformationMessage('SysML: open a .sysml/.kerml file first.');
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('sysml-graph.dot'),
      filters: { 'DOT graph': ['dot'] },
    });
    if (target) {
      await fs.writeFile(target.fsPath, toDot(data), 'utf8');
      void vscode.window.showInformationMessage(`SysML: graph exported to ${target.fsPath}`);
    }
  }

  /** HTML for the graph webview. */
  html(webview: vscode.Webview): string {
    const graphUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'graph.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'graph.css')
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src data: blob:;">
  <link href="${styleUri}" rel="stylesheet">
  <title>SysML Block Definition Diagram</title>
</head>
<body>
  <div id="toolbar">
    <span id="status">Open a SysML file to see its structure</span>
    <span id="controls">
      <input id="search" type="search" placeholder="Search blocks" title="Highlight blocks whose name contains this text">
      <select id="kindFilter" title="Show only blocks of one kind">
        <option value="">All kinds</option>
      </select>
      <select id="layout" title="Diagram layout">
        <option value="tree">Layered (hierarchy)</option>
        <option value="force">Force</option>
        <option value="circle">Circle</option>
        <option value="grid">Grid</option>
      </select>
      <button id="zoomOut" title="Zoom out">\u2212</button>
      <button id="zoomIn" title="Zoom in">+</button>
      <button id="fit" title="Fit the diagram to the view">Fit</button>
      <button id="exportPng" title="Export the diagram as a PNG image">PNG</button>
      <button id="exportSvg" title="Export the diagram as an SVG image">SVG</button>
    </span>
  </div>
  <div id="body">
    <svg id="graph" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="diamond" viewBox="0 0 12 12" refX="6" refY="6"
                markerWidth="12" markerHeight="12" orient="auto-start-reverse">
          <path d="M 1 6 L 6 1 L 11 6 L 6 11 Z" fill="#9aa0a6" />
        </marker>
        <marker id="hollow-triangle" viewBox="0 0 14 14" refX="12" refY="7"
                markerWidth="14" markerHeight="14" orient="auto-start-reverse">
          <path d="M 1 1 L 13 7 L 1 13 Z" fill="#1e1e1e" stroke="#8a6bd8" stroke-width="1.4" />
        </marker>
        <marker id="open-arrow" viewBox="0 0 12 12" refX="10" refY="6"
                markerWidth="10" markerHeight="10" orient="auto-start-reverse">
          <path d="M 1 1 L 11 6 L 1 11" fill="none" stroke="#b0b6bd" stroke-width="1.4" />
        </marker>
        <marker id="dot-marker" viewBox="0 0 8 8" refX="7" refY="4"
                markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <circle cx="4" cy="4" r="3" fill="#9aa0a6" />
        </marker>
        <marker id="circle-marker" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="10" markerHeight="10" orient="auto-start-reverse">
          <circle cx="5" cy="5" r="3.5" fill="none" stroke="#777d87" stroke-width="1.3" />
        </marker>
      </defs>
      <g id="viewport">
        <g id="edges"></g>
        <g id="nodes"></g>
      </g>
    </svg>
    <div id="details" hidden>
      <div id="detailsHead">
        <strong id="detailsName"></strong>
        <button id="detailsClose" title="Clear selection">\u00d7</button>
      </div>
      <div id="detailsKind"></div>
      <div id="detailsMeta"></div>
      <button id="detailsOpen" title="Open the declaration in the editor">Open in editor</button>
    </div>
  </div>
  <div id="legend">
    <i style="background:#3b7dd8"></i>part
    <i style="background:#8a6bd8"></i>item
    <i style="background:#c07a3a"></i>attribute
    <i style="background:#b5567e"></i>port
    <i style="background:#c25050"></i>action/rel
    <i style="background:#7a6f9e"></i>state
    <i style="background:#557a3f"></i>requirement
  </div>
  <script nonce="${nonce}" src="${graphUri}"></script>
</body>
</html>`;
  }
}

/** Editor-area entry point: a full-width panel for a larger canvas. */
export class SysmlGraphPanel {
  static readonly viewType = 'sysml.graphPanel';

  private panel: vscode.WebviewPanel | undefined;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly session: GraphSession) {}

  /** Visible panel webviews, for broadcast refreshes. */
  webviews(): vscode.Webview[] {
    return this.panel?.visible ? [this.panel.webview] : [];
  }

  /** Show the panel, creating or revealing it. */
  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      void this.session.refreshOne(this.panel.webview);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      SysmlGraphPanel.viewType,
      'SysML Structure Graph',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.session.context.extensionUri, 'media')],
      }
    );
    this.panel.webview.html = this.session.html(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
      }
    });
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.command === 'ready') {
        // Reply to this panel directly: it may not report visible yet.
        await this.session.refreshOne(this.panel!.webview);
      } else {
        await this.session.handleMessage(msg);
      }
    });
    // One delayed retry covers a panel opened before the server is ready.
    this.retryTimer = setTimeout(() => {
      if (this.panel) {
        void this.session.refreshOne(this.panel.webview);
      }
    }, 700);
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

/** Serialize a graph as Graphviz DOT. */
function toDot(data: GraphData): string {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const lines: string[] = [
    'digraph sysml {',
    '  rankdir=TB;',
    '  node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=10];',
  ];
  for (const n of data.nodes) {
    lines.push(
      `  "${esc(n.id)}" [label="${esc(n.label)}\\n(${esc(n.kind)})", fillcolor="${colorFor(n.kind)}", fontcolor="white"];`
    );
  }
  for (const e of data.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) {
      continue;
    }
    if (e.kind === 'contains') {
      lines.push(`  "${esc(e.from)}" -> "${esc(e.to)}" [style=dotted, color="#9aa0a6"];`);
    } else {
      const arrow = e.kind === 'specializes' ? 'empty' : 'vee';
      lines.push(
        `  "${esc(e.from)}" -> "${esc(e.to)}" [label="${esc(e.label || e.kind)}", arrowhead=${arrow}, color="#c25050"];`
      );
    }
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
