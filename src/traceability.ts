import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

interface TraceTarget {
  id: string;
  name: string;
  qname: string;
  uri: string;
  line: number;
  character: number;
}

interface TraceLink {
  requirement: string;
  verification: string;
}

interface TraceabilityPayload {
  requirements: TraceTarget[];
  verifications: TraceTarget[];
  links: TraceLink[];
}

const EMPTY: TraceabilityPayload = { requirements: [], verifications: [], links: [] };

/**
 * Requirement / verification matrix.
 *
 * Rows are requirements, columns are verification cases, and a check mark means
 * the verification case references the requirement. Clicking a name opens the
 * declaration in the editor.
 */
export class SysmlTraceabilityPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly getClient: () => LanguageClient | undefined) {}

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      await this.refresh();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'sysml.traceability',
      'SysML Traceability Matrix',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.command === 'open' && typeof msg.uri === 'string') {
        await this.openTarget(msg.uri, Number(msg.line) || 0, Number(msg.character) || 0);
      }
    });
    await this.refresh();
  }

  /** Re-request the matrix; called on model changes when the panel is open. */
  async refresh(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const client = this.getClient();
    let data: TraceabilityPayload = EMPTY;
    if (client) {
      try {
        data = (await client.sendRequest<TraceabilityPayload>('sysml/traceability')) ?? EMPTY;
      } catch {
        data = EMPTY;
      }
    }
    this.panel.webview.html = this.html(this.panel.webview, data);
  }

  private async openTarget(uri: string, line: number, character: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const position = new vscode.Position(line, character);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  private html(webview: vscode.Webview, data: TraceabilityPayload): string {
    const nonce = nonceString();
    const payload = JSON.stringify(data).replace(/</g, '\\u003c');
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Traceability Matrix</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 12px;
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: 12px; color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; }
  #summary { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
  .scroll { overflow: auto; max-height: calc(100vh - 130px); border: 1px solid var(--vscode-panel-border); }
  table { border-collapse: collapse; min-width: 100%; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left; }
  thead th { position: sticky; top: 0; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); z-index: 2; }
  th.rowhead { position: sticky; left: 0; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); z-index: 1; }
  thead th.rowhead { z-index: 3; }
  .link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .link:hover { text-decoration: underline; }
  .tick { color: var(--vscode-testing-iconPassed, #3fb950); font-weight: 700; text-align: center; }
  .miss { text-align: center; color: var(--vscode-descriptionForeground); }
  .empty { padding: 24px; color: var(--vscode-descriptionForeground); }
  .unverified { margin-top: 14px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 8px;
           background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
</style>
</head>
<body>
  <h2>Requirements / verification matrix</h2>
  <div id="summary"></div>
  <div id="content"></div>
  <script nonce="${nonce}">
    const data = ${payload};
    const content = document.getElementById('content');
    const summary = document.getElementById('summary');

    function open(target) {
      vscode.postMessage({ command: 'open', uri: target.uri, line: target.line, character: target.character });
    }

    function link(target, text) {
      const a = document.createElement('a');
      a.className = 'link';
      a.textContent = text || target.name;
      a.title = target.qname;
      a.addEventListener('click', () => open(target));
      return a;
    }

    if (!data.requirements.length && !data.verifications.length) {
      content.innerHTML = '<div class="empty">No requirement or verification case found in the workspace.</div>';
    } else {
      const linked = new Set(data.links.map((l) => l.requirement + '|' + l.verification));
      const verifiedRequirements = new Set(data.links.map((l) => l.requirement));
      const unverified = data.requirements.filter((r) => !verifiedRequirements.has(r.id));

      summary.textContent =
        data.requirements.length + ' requirement(s), ' +
        data.verifications.length + ' verification case(s), ' +
        data.links.length + ' link(s), ' +
        unverified.length + ' unverified';

      const scroll = document.createElement('div');
      scroll.className = 'scroll';
      const table = document.createElement('table');

      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      const corner = document.createElement('th');
      corner.className = 'rowhead';
      corner.textContent = 'Requirement \\\\ Verification';
      headRow.appendChild(corner);
      for (const verification of data.verifications) {
        const th = document.createElement('th');
        th.appendChild(link(verification));
        headRow.appendChild(th);
      }
      head.appendChild(headRow);
      table.appendChild(head);

      const body = document.createElement('tbody');
      for (const requirement of data.requirements) {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.className = 'rowhead';
        th.appendChild(link(requirement));
        tr.appendChild(th);
        for (const verification of data.verifications) {
          const td = document.createElement('td');
          if (linked.has(requirement.id + '|' + verification.id)) {
            td.className = 'tick';
            td.textContent = '\\u2713';
          } else {
            td.className = 'miss';
            td.textContent = '\\u00b7';
          }
          tr.appendChild(td);
        }
        body.appendChild(tr);
      }
      table.appendChild(body);
      scroll.appendChild(table);
      content.appendChild(scroll);

      if (unverified.length) {
        const block = document.createElement('div');
        block.className = 'unverified';
        const title = document.createElement('h2');
        title.textContent = 'Unverified requirements';
        block.appendChild(title);
        const list = document.createElement('div');
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = String(unverified.length);
        list.appendChild(badge);
        list.appendChild(document.createTextNode(' '));
        unverified.forEach((requirement, index) => {
          if (index) list.appendChild(document.createTextNode(', '));
          list.appendChild(link(requirement));
        });
        block.appendChild(list);
        content.appendChild(block);
      }
    }
  </script>
</body>
</html>`;
  }
}

function nonceString(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
