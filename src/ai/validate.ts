import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

export interface ValidationError {
  line: number;
  column: number;
  message: string;
}

/**
 * Parse a proposed document through the language server without touching the
 * workspace. The server exposes `sysml/validate` for exactly this purpose.
 */
export async function validateSysml(
  getClient: () => LanguageClient | undefined,
  text: string
): Promise<ValidationError[]> {
  const client = getClient();
  if (!client) {
    return [];
  }
  try {
    const result = await client.sendRequest<{ errors: ValidationError[] }>('sysml/validate', { text });
    return result?.errors ?? [];
  } catch {
    // A validation failure must not block the assistant entirely.
    return [];
  }
}

/**
 * Gate a proposal on the parser. Invalid SysML is still offered, but the user
 * is told first and can inspect the errors instead of silently accepting a
 * broken model.
 */
export async function confirmProposalParses(
  getClient: () => LanguageClient | undefined,
  text: string
): Promise<boolean> {
  const errors = await validateSysml(getClient, text);
  if (!errors.length) {
    return true;
  }

  const first = errors[0];
  const choice = await vscode.window.showWarningMessage(
    `SysML AI: the proposal has ${errors.length} syntax error${errors.length === 1 ? '' : 's'}` +
      ` (line ${first.line + 1}: ${first.message}).`,
    'Show errors',
    'Propose anyway'
  );

  if (choice === 'Show errors') {
    const details = await vscode.workspace.openTextDocument({
      content:
        '# SysML AI proposal: syntax errors\n\n' +
        errors
          .map((error) => `- line ${error.line + 1}, column ${error.column + 1}: ${error.message}`)
          .join('\n') +
        '\n\n## Proposed document\n\n```sysml\n' +
        text +
        '\n```\n',
      language: 'markdown',
    });
    await vscode.window.showTextDocument(details, { preview: true });
    return false;
  }
  return choice === 'Propose anyway';
}
