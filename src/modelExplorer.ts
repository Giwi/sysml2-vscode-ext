import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { ModelTreeNode } from './shared/protocol';

export type { ModelTreeNode } from './shared/protocol';

export class SysmlModelExplorer implements vscode.TreeDataProvider<ModelTreeNode> {
  static readonly viewType = 'sysml.modelExplorer';

  private readonly emitter = new vscode.EventEmitter<ModelTreeNode | undefined>();
  private roots: ModelTreeNode[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getClient: () => LanguageClient | undefined) {}

  /** Debounced refresh; the server re-indexes after each edit. */
  scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => void this.refresh(), 400);
  }

  async refresh(): Promise<void> {
    const client = this.getClient();
    if (!client) {
      this.roots = [];
      this.emitter.fire(undefined);
      return;
    }
    try {
      this.roots = (await client.sendRequest<ModelTreeNode[]>('sysml/modelTree')) ?? [];
    } catch {
      this.roots = [];
    }
    this.emitter.fire(undefined);
  }

  getTreeItem(node: ModelTreeNode): vscode.TreeItem {
    const collapsible =
      node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(node.name, collapsible);
    item.description = node.kind === 'File' ? '' : node.kind;
    item.tooltip = node.kind === 'File' ? node.uri : `${node.qname} (${node.kind})`;
    item.contextValue = node.kind === 'File' ? 'sysmlFile' : 'sysmlElement';
    if (node.kind === 'File') {
      // resourceUri gives the file icon and makes the label open the file.
      item.resourceUri = vscode.Uri.parse(node.uri);
    } else {
      item.iconPath = new vscode.ThemeIcon(iconFor(node.kind));
    }

    if (node.kind === 'File' || node.line > 0) {
      item.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [
          vscode.Uri.parse(node.uri),
          { selection: new vscode.Range(node.line, node.character, node.line, node.character) },
        ],
      };
    }
    return item;
  }

  getChildren(node?: ModelTreeNode): ModelTreeNode[] {
    return node ? node.children : this.roots;
  }
}

function iconFor(kind: string): string {
  switch (kind) {
    case 'File':
      return 'file-code';
    case 'Package':
    case 'Namespace':
      return 'package';
    case 'Part Definition':
    case 'Part':
      return 'symbol-class';
    case 'Item Definition':
    case 'Item':
      return 'symbol-field';
    case 'Attribute Definition':
    case 'Attribute':
      return 'symbol-property';
    case 'Port Definition':
    case 'Port':
      return 'plug';
    case 'Interface Definition':
    case 'Interface':
    case 'Connection':
    case 'Connector':
      return 'plug';
    case 'Enumeration':
    case 'Enumeration Value':
      return 'symbol-enum';
    case 'Action Definition':
    case 'Action':
      return 'play';
    case 'State Definition':
    case 'State':
      return 'circle-outline';
    case 'Requirement Definition':
    case 'Requirement':
      return 'checklist';
    case 'Constraint Definition':
    case 'Constraint':
      return 'symbol-operator';
    case 'Calculation Definition':
      return 'symbol-method';
    case 'Flow':
      return 'arrow-right';
    case 'Allocation Definition':
      return 'git-compare';
    case 'View Definition':
    case 'View':
      return 'preview';
    default:
      return 'symbol-misc';
  }
}
