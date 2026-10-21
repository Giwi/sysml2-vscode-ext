import type { ModelTreeNode } from '../../shared/protocol.js';
import type { SysmlSymbol } from '../model.js';
import type { FeatureContext } from './context.js';

function toModelTree(sym: SysmlSymbol, uri: string): ModelTreeNode {
  return {
    name: sym.name,
    kind: sym.kind,
    qname: sym.qname,
    uri,
    line: sym.nameRange.start.line,
    character: sym.nameRange.start.character,
    children: sym.children.map((child) => toModelTree(child, uri)),
  };
}

function fileNameOf(uri: string): string {
  const slash = uri.lastIndexOf('/');
  return slash >= 0 ? decodeURIComponent(uri.slice(slash + 1)) : uri;
}

/**
 * Whole-model outline for the Model Explorer: one root per user file, with the
 * declaration tree underneath. Standard library files are excluded because
 * they would dominate the tree.
 */
export function registerModelTree(ctx: FeatureContext): void {
  ctx.connection.onRequest('sysml/modelTree', () => {
    const files: ModelTreeNode[] = [];
    for (const model of ctx.workspace.docs.values()) {
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
}
