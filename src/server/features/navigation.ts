import * as fs from 'node:fs';
import { TextDocument } from 'vscode-languageserver/node.js';
import type { SysmlSymbol } from '../model.js';
import {
  foldingRanges,
  inlayHints,
  semanticTokens,
  signatureHelp,
} from '../navigation.js';
import type { FeatureContext } from './context.js';

/** Filesystem path of a `file://` URI, used to read indexed declarations. */
function toFsPath(uri: string): string {
  return decodeURIComponent(uri.slice(7));
}

/**
 * Semantic tokens, folding, inlay hints and signature help.
 *
 * The pure logic lives in `navigation.ts`; this module only bridges it to the
 * LSP connection and resolves declaration text for signature help.
 */
export function registerNavigation(ctx: FeatureContext): void {
  ctx.connection.languages.semanticTokens.on((params) => {
    const model = ctx.workspace.docs.get(params.textDocument.uri);
    return model ? semanticTokens(model) : { data: [] };
  });

  ctx.connection.onFoldingRanges((params) => {
    const document = ctx.documents.get(params.textDocument.uri);
    return document ? foldingRanges(document.getText()) : [];
  });

  ctx.connection.onRequest(
    'textDocument/inlayHint',
    (params: { textDocument: { uri: string } }) => {
      const model = ctx.workspace.docs.get(params.textDocument.uri);
      const document = ctx.documents.get(params.textDocument.uri);
      return model && document ? inlayHints(model, document) : [];
    }
  );

  ctx.connection.onSignatureHelp((params) => {
    const document = ctx.documents.get(params.textDocument.uri);
    if (!document) {
      return null;
    }
    const help = signatureHelp(document, params.position, (name) => {
      const candidates = ctx.workspace.lookupByName(name);
      const hit =
        candidates.find((entry) => /Calculation|Action/.test(entry.sym.kind)) ?? candidates[0];
      if (!hit) {
        return undefined;
      }
      const openDocument = ctx.documents.get(hit.model.uri);
      let source = openDocument?.getText();
      if (!source) {
        try {
          source = fs.readFileSync(toFsPath(hit.model.uri), 'utf8');
        } catch {
          return undefined;
        }
      }
      const owner = TextDocument.create(hit.model.uri, 'sysml', 1, source);
      return { sym: hit.sym as SysmlSymbol, text: owner.getText(hit.sym.range) };
    });
    return help ?? null;
  });
}
