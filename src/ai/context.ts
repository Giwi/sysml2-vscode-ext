import * as vscode from 'vscode';

/** The editor state handed to the language model. */
export interface EditorSnapshot {
  document: vscode.TextDocument;
  selection: vscode.Selection;
  selectedText: string;
  languageId: string;
  fileName: string;
}

/** Capture the active editor, if it holds a SysML or KerML document. */
export function snapshotEditor(): EditorSnapshot | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !/^(sysml|kerml)$/.test(editor.document.languageId)) {
    return undefined;
  }
  return {
    document: editor.document,
    selection: editor.selection,
    selectedText: editor.document.getText(editor.selection),
    languageId: editor.document.languageId,
    fileName: editor.document.fileName,
  };
}

/** Keep prompts within a predictable budget. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + '\n... (truncated)';
}

/**
 * A compact declaration outline, taken from the document symbol provider.
 * The language server already builds this tree, so no extra parsing is needed.
 */
export async function outlineOf(document: vscode.TextDocument): Promise<string> {
  try {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );
    if (!symbols || symbols.length === 0) {
      return '';
    }
    const lines: string[] = [];
    const walk = (items: vscode.DocumentSymbol[], depth: number): void => {
      for (const item of items) {
        lines.push('  '.repeat(depth) + `${item.name} (${item.detail || 'element'})`);
        if (depth < 2 && item.children?.length) {
          walk(item.children, depth + 1);
        }
      }
    };
    walk(symbols, 0);
    return lines.slice(0, 120).join('\n');
  } catch {
    return '';
  }
}

export interface ContextOptions {
  maxChars: number;
  /** Include the whole file even when there is a selection. */
  wholeFile?: boolean;
}

/** Build the textual context block sent alongside a user request. */
export async function buildContext(
  snapshot: EditorSnapshot,
  options: ContextOptions
): Promise<string> {
  const { document, selection, selectedText, fileName, languageId } = snapshot;
  const outline = await outlineOf(document);
  const parts: string[] = [
    `File: ${fileName}`,
    `Language: ${languageId === 'kerml' ? 'KerML' : 'SysML v2'}`,
    `Cursor: line ${selection.active.line + 1}, column ${selection.active.character + 1}`,
  ];
  if (outline) {
    parts.push('', 'Declarations:', outline);
  }

  if (selectedText.trim() && !options.wholeFile) {
    parts.push(
      '',
      'Selected text:',
      '```' + languageId,
      truncate(selectedText, options.maxChars),
      '```'
    );
  } else {
    parts.push(
      '',
      'Document:',
      '```' + languageId,
      truncate(document.getText(), options.maxChars),
      '```'
    );
  }
  return parts.join('\n');
}

/** Replace the selection, or the whole document when nothing is selected. */
export function replacementText(snapshot: EditorSnapshot, newText: string): string {
  const full = snapshot.document.getText();
  if (snapshot.selection.isEmpty) {
    return newText;
  }
  const start = snapshot.document.offsetAt(snapshot.selection.start);
  const end = snapshot.document.offsetAt(snapshot.selection.end);
  return full.slice(0, start) + newText + full.slice(end);
}
