import * as vscode from 'vscode';

/**
 * HTML shell for the diagram webview.
 *
 * All rendering happens in `media/graph.js` (built from
 * `src/webview/graph.ts`); this module only provides the DOM skeleton, the
 * SVG marker definitions and the content security policy.
 */
export function graphHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const graphUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'graph.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'graph.css'));
  const nonce = getNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src data: blob:;">
  <link href="${styleUri}" rel="stylesheet">
  <title>SysML Diagram</title>
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

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
