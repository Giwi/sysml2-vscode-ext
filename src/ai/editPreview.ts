import * as vscode from 'vscode';

/**
 * Diff preview with explicit accept/reject.
 *
 * The proposal is materialised as an untitled document so the normal diff
 * editor can show it. Accepting applies a single full-document edit, which
 * keeps the change atomic and undoable in one step.
 */
interface PendingEdit {
  previewUri: vscode.Uri;
  originalUri: vscode.Uri;
  newText: string;
  baseText: string;
  title: string;
}

const pending = new Map<string, PendingEdit>();

/** Show a proposed document next to the original and ask for a decision. */
export async function proposeEdit(
  original: vscode.TextDocument,
  newText: string,
  title: string
): Promise<void> {
  if (normalise(newText) === normalise(original.getText())) {
    void vscode.window.showInformationMessage('SysML: the assistant proposed no changes.');
    return;
  }

  const preview = await vscode.workspace.openTextDocument({
    content: newText,
    language: original.languageId,
  });
  const entry: PendingEdit = {
    previewUri: preview.uri,
    originalUri: original.uri,
    newText,
    baseText: normalise(original.getText()),
    title,
  };
  pending.set(preview.uri.toString(), entry);

  await vscode.commands.executeCommand(
    'vscode.diff',
    original.uri,
    preview.uri,
    title,
    { preview: true }
  );

  const choice = await vscode.window.showInformationMessage(
    'SysML AI: review the proposed change, then accept or reject it.',
    'Accept',
    'Reject'
  );
  if (choice === 'Accept') {
    await acceptEdit(preview.uri.toString());
  } else if (choice === 'Reject') {
    await rejectEdit(preview.uri.toString());
  }
}

async function acceptEdit(key: string): Promise<void> {
  const entry = pending.get(key);
  if (!entry) {
    return;
  }
  pending.delete(key);
  const document = await vscode.workspace.openTextDocument(entry.originalUri);

  // The model may have taken a while, and the file may have changed since.
  if (normalise(document.getText()) !== entry.baseText) {
    const choice = await vscode.window.showWarningMessage(
      'The document changed since this proposal was generated. Applying it will discard those changes.',
      { modal: true },
      'Apply anyway'
    );
    if (choice !== 'Apply anyway') {
      await closePreview(entry.previewUri);
      return;
    }
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    entry.originalUri,
    new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    entry.newText
  );
  if (!(await vscode.workspace.applyEdit(edit))) {
    void vscode.window.showWarningMessage('SysML: could not apply the proposed change.');
    return;
  }
  await document.save();
  await closePreview(entry.previewUri);
  void vscode.window.showInformationMessage('SysML: AI change applied.');
}

async function rejectEdit(key: string): Promise<void> {
  const entry = pending.get(key);
  if (!entry) {
    return;
  }
  pending.delete(key);
  await closePreview(entry.previewUri);
}

/** Close the modified side of the diff if it is the active editor. */
async function closePreview(previewUri: vscode.Uri): Promise<void> {
  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.toString() === previewUri.toString()) {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
}

function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

/** Inline Accept/Reject lenses shown above the proposed document. */
class PreviewCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const key = document.uri.toString();
    if (!pending.has(key)) {
      return [];
    }
    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        title: '\u2713 Accept AI change',
        command: 'sysml.ai.accept',
        arguments: [key],
      }),
      new vscode.CodeLens(range, {
        title: '\u2717 Reject',
        command: 'sysml.ai.reject',
        arguments: [key],
      }),
    ];
  }
}

/** Register the accept/reject commands and the diff lenses. */
export function registerEditPreview(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sysml.ai.accept', (key?: string) =>
      acceptEdit(key ?? currentPreviewKey())
    ),
    vscode.commands.registerCommand('sysml.ai.reject', (key?: string) =>
      rejectEdit(key ?? currentPreviewKey())
    ),
    vscode.languages.registerCodeLensProvider({ scheme: 'untitled' }, new PreviewCodeLensProvider())
  );
}

/** Fallback for the palette and keybindings, where no preview uri is passed. */
function currentPreviewKey(): string {
  const active = vscode.window.activeTextEditor;
  if (active) {
    const key = active.document.uri.toString();
    if (pending.has(key)) {
      return key;
    }
  }
  const last = [...pending.keys()].pop();
  return last ?? '';
}
