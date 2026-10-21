import * as vscode from 'vscode';

/**
 * Prompt shared by the inline assist and the chat participant.
 *
 * The rules matter more than the wording: the model must return a complete
 * SysML document (not a fragment surrounded by prose) so the result can be
 * shown as a diff and applied verbatim.
 */
export const SYSTEM_PROMPT = `You are a SysML v2 modelling assistant embedded in an editor.

Rules:
- Answer with valid SysML v2 textual notation (or KerML when the file is KerML).
- When asked to change, create or fix a model, return ONLY the complete resulting document in a single fenced code block.
- Preserve every declaration that the request does not ask to change.
- Never use "analysis case def" or "verification case def"; use "analysis def" and "verification def".
- Do not invent standard-library names. Common types come from ScalarValues, Parts, Items, Ports and Requirements.
- Keep explanations short and outside the code block.`;

/** Read the model preference from settings. */
function preferredModel(): string {
  return vscode.workspace.getConfiguration('sysml').get<string>('ai.model', '').trim();
}

/** Whether the AI features are enabled in settings. */
export function aiEnabled(): boolean {
  return vscode.workspace.getConfiguration('sysml').get<boolean>('ai.enable', true);
}

/**
 * Pick a chat model. A configured family or id wins; otherwise the first model
 * offered by the host is used. Throws a readable error when none is available,
 * because that is the common failure mode (no Copilot or other provider).
 */
export async function pickModel(): Promise<vscode.LanguageModelChat> {
  if (typeof vscode.lm?.selectChatModels !== 'function') {
    throw new Error(
      'Language model API unavailable. Update VS Code or install a chat model provider such as GitHub Copilot.'
    );
  }
  const preference = preferredModel();
  if (preference) {
    const byFamily = await vscode.lm.selectChatModels({ family: preference });
    if (byFamily.length) {
      return byFamily[0];
    }
    const byId = await vscode.lm.selectChatModels({ id: preference });
    if (byId.length) {
      return byId[0];
    }
  }
  const models = await vscode.lm.selectChatModels();
  if (!models.length) {
    throw new Error(
      'No language model is available. Install or sign in to a chat provider such as GitHub Copilot.'
    );
  }
  return models[0];
}

/** Stream a completion and return the concatenated text. */
export async function complete(
  model: vscode.LanguageModelChat,
  context: string,
  request: string,
  token: vscode.CancellationToken,
  onChunk?: (text: string) => void
): Promise<string> {
  const messages = [
    vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
    vscode.LanguageModelChatMessage.User(context + '\n\nRequest: ' + request),
  ];
  const response = await model.sendRequest(messages, {}, token);
  let text = '';
  for await (const chunk of response.text) {
    text += chunk;
    onChunk?.(text);
  }
  return text;
}

/**
 * Extract the code to apply from a model answer. Models usually wrap the
 * document in a fence; when they do not, the trimmed answer is used as-is.
 */
export { extractCode } from './code';

/** Surface language model errors without a stack trace. */
export function describeError(error: unknown): string {
  if (error instanceof vscode.LanguageModelError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
