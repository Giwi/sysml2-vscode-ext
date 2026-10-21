import * as vscode from 'vscode';
import { graphHtml } from './graph/html';
import type { DiagramMode, GraphSession } from './graph/session';

/**
 * Editor-area entry point: a full-width panel that hosts both the block
 * definition diagram and the internal block diagram.
 *
 * Rendering lives in `media/graph.js`, payloads and webview messages in
 * `graph/session.ts`, and the HTML shell in `graph/html.ts`.
 */
export class SysmlGraphPanel {
  static readonly viewType = 'sysml.graphPanel';

  private panel: vscode.WebviewPanel | undefined;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly session: GraphSession) {}

  /** Visible panel webviews, for broadcast refreshes. */
  webviews(): vscode.Webview[] {
    return this.panel?.visible ? [this.panel.webview] : [];
  }

  /** Show the panel, creating or revealing it, in the requested diagram mode. */
  show(mode: DiagramMode = 'bdd'): void {
    this.session.setMode(mode);
    const title = mode === 'ibd' ? 'SysML Internal Block Diagram' : 'SysML Structure Graph';
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(vscode.ViewColumn.Beside);
      void this.session.refreshOne(this.panel.webview);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      SysmlGraphPanel.viewType,
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.session.context.extensionUri, 'media')],
      }
    );
    this.panel.webview.html = graphHtml(
      this.panel.webview,
      this.session.context.extensionUri
    );
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
