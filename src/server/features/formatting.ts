import { formatText } from '../format.js';
import type { FeatureContext } from './context.js';

/** `textDocument/formatting`, including the optional member alignment. */
export function registerFormatting(ctx: FeatureContext): void {
  ctx.connection.onDocumentFormatting((params) => {
    const document = ctx.documents.get(params.textDocument.uri);
    if (!document) {
      return [];
    }
    const text = document.getText();
    const formatted = formatText(text, {
      insertSpaces: params.options.insertSpaces,
      tabSize: params.options.tabSize,
      alignMembers: ctx.config.formatAlignMembers(),
    });
    if (formatted === text) {
      return [];
    }
    return [
      {
        range: {
          start: { line: 0, character: 0 },
          end: document.positionAt(text.length),
        },
        newText: formatted,
      },
    ];
  });
}
