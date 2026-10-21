import type { Connection, TextDocuments } from 'vscode-languageserver/node.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { DocumentModel, LspRange, SysmlSymbol } from '../model.js';
import type { Workspace } from '../workspace.js';

/** Dependencies handed to every feature module. */
export interface FeatureContext {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  workspace: Workspace;
  config: {
    libraryEnabled: () => boolean;
    unresolvedWarnings: () => boolean;
    maxGraphNodes: () => number;
    formatAlignMembers: () => boolean;
    isLibraryUri: (uri: string) => boolean;
  };
}

/** True when the 0-based position falls inside the range (end exclusive). */
export function rangeContains(range: LspRange, line: number, character: number): boolean {
  if (line < range.start.line || line > range.end.line) {
    return false;
  }
  if (line === range.start.line && character < range.start.character) {
    return false;
  }
  if (line === range.end.line && character >= range.end.character) {
    return false;
  }
  return true;
}

/** Find a declaration by qualified name inside one document. */
export function symbolByQName(model: DocumentModel, qname: string): SysmlSymbol | undefined {
  let found: SysmlSymbol | undefined;
  const visit = (sym: SysmlSymbol): void => {
    if (found) {
      return;
    }
    if (sym.qname === qname) {
      found = sym;
      return;
    }
    for (const child of sym.children) {
      visit(child);
    }
  };
  visit(model.root);
  return found;
}
