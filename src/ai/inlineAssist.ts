import * as vscode from 'vscode';
import { buildContext, replacementText, snapshotEditor, truncate } from './context';
import { aiEnabled, complete, describeError, extractCode, pickModel } from './model';
import { proposeEdit } from './editPreview';

function maxChars(): number {
  return vscode.workspace.getConfiguration('sysml').get<number>('ai.maxContextChars', 12000);
}

/**
 * Run the inline assistant.
 *
 * `insert` appends new declarations at the cursor, `rewrite` replaces the
 * selection (or the whole document). Both end in a diff, never a direct edit.
 */
async function runAssist(mode: 'insert' | 'rewrite'): Promise<void> {
  if (!aiEnabled()) {
    void vscode.window.showInformationMessage(
      'SysML AI is disabled. Enable "sysml.ai.enable" in settings.'
    );
    return;
  }
  const snapshot = snapshotEditor();
  if (!snapshot) {
    void vscode.window.showWarningMessage('SysML: open a SysML or KerML file first.');
    return;
  }

  const prompt = await vscode.window.showInputBox({
    title: mode === 'insert' ? 'Generate SysML' : 'Edit with AI',
    prompt:
      mode === 'insert'
        ? 'Describe the declaration to add at the cursor'
        : 'Describe the change to apply to the selection',
    placeHolder: 'e.g. add a port for a power connection',
    ignoreFocusOut: true,
  });
  if (!prompt) {
    return;
  }

  const tokenSource = new vscode.CancellationTokenSource();
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'SysML AI: thinking...', cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => tokenSource.cancel());
        const model = await pickModel();
        const context = await buildContext(snapshot, {
          maxChars: maxChars(),
          wholeFile: mode === 'insert',
        });
        const request =
          mode === 'insert'
            ? `Add the following to the model. Return only the new declaration or declarations, in one fenced code block: ${prompt}`
            : `Apply this change to the document and return the complete resulting document in one fenced code block: ${prompt}`;

        progress.report({ message: 'generating' });
        const answer = await complete(model, context, request, tokenSource.token);
        const code = extractCode(answer, snapshot.languageId);

        if (mode === 'insert') {
          const document = snapshot.document;
          const offset = document.offsetAt(snapshot.selection.active);
          const full = document.getText();
          const prefix = full.slice(0, offset);
          const suffix = full.slice(offset);
          const separator = prefix.endsWith('\n') || !prefix ? '' : '\n';
          const indent = /^\s*/.exec(document.lineAt(snapshot.selection.active.line).text)?.[0] ?? '';
          const indented = code
            .split('\n')
            .map((line, index) => (index === 0 ? indent + line : indent + line))
            .join('\n');
          await proposeEdit(document, prefix + separator + indented + '\n' + suffix, 'SysML AI: proposed insertion');
        } else {
          await proposeEdit(
            snapshot.document,
            replacementText(snapshot, code),
            'SysML AI: proposed change'
          );
        }
      }
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`SysML AI: ${describeError(error)}`);
  } finally {
    tokenSource.dispose();
  }
}

/** Explain the selection (or the file) in a read-only markdown tab. */
async function runExplain(): Promise<void> {
  if (!aiEnabled()) {
    void vscode.window.showInformationMessage(
      'SysML AI is disabled. Enable "sysml.ai.enable" in settings.'
    );
    return;
  }
  const snapshot = snapshotEditor();
  if (!snapshot) {
    void vscode.window.showWarningMessage('SysML: open a SysML or KerML file first.');
    return;
  }
  const tokenSource = new vscode.CancellationTokenSource();
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'SysML AI: explaining...', cancellable: true },
      async (_progress, token) => {
        token.onCancellationRequested(() => tokenSource.cancel());
        const model = await pickModel();
        const context = await buildContext(snapshot, { maxChars: maxChars() });
        const answer = await complete(
          model,
          context,
          'Explain what this model does, in markdown. Mention the main blocks, their relationships and anything that looks wrong. Do not restate the whole file.',
          tokenSource.token
        );
        const doc = await vscode.workspace.openTextDocument({
          content: `# SysML explanation\n\n${truncate(answer, 20000)}\n`,
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`SysML AI: ${describeError(error)}`);
  } finally {
    tokenSource.dispose();
  }
}

/** Register the AI commands and their keybindings. */
export function registerInlineAssist(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sysml.ai.inlineAssist', () => runAssist('rewrite')),
    vscode.commands.registerCommand('sysml.ai.generate', () => runAssist('insert')),
    vscode.commands.registerCommand('sysml.ai.explain', () => runExplain())
  );
}
