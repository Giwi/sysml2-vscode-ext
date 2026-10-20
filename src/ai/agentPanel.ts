import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { buildContext, replacementText, snapshotEditor, truncate } from './context';
import { SYSTEM_PROMPT, aiEnabled, describeError, extractCode, pickModel } from './model';
import { proposeEdit } from './editPreview';
import { confirmProposalParses } from './validate';

/**
 * The last code block produced in the chat, so the "Preview as diff" button
 * can apply it. Commands invoked from a chat button receive no arguments.
 */
let lastProposal: { code: string; mode: 'insert' | 'rewrite'; uri?: string } | undefined;

function maxChars(): number {
  return vscode.workspace.getConfiguration('sysml').get<number>('ai.maxContextChars', 12000);
}

function hasCodeBlock(answer: string): boolean {
  return /```(?:sysml|kerml|uml)?\s*\n[\s\S]*?```/i.test(answer);
}

/**
 * Chat handler for the SysML Assistant participant.
 *
 * The editor context is attached automatically: selection when there is one,
 * otherwise the file, plus the declaration outline.
 */
async function handleChat(
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  if (!aiEnabled()) {
    response.markdown('SysML AI is disabled. Enable `sysml.ai.enable` in settings.');
    return {};
  }
  let model: vscode.LanguageModelChat;
  try {
    model = await pickModel();
  } catch (error) {
    response.markdown(`**SysML AI:** ${describeError(error)}`);
    return { errorDetails: { message: 'no model' } };
  }

  const snapshot = snapshotEditor();
  const mode: 'insert' | 'rewrite' = request.command === 'generate' ? 'insert' : 'rewrite';
  const contextText = snapshot
    ? await buildContext(snapshot, { maxChars: maxChars(), wholeFile: mode === 'insert' })
    : 'No SysML or KerML editor is active. Answer from general SysML v2 knowledge.';

  const instructions =
    request.command === 'explain'
      ? 'Explain the model in markdown: main blocks, relationships, and anything suspicious. Do not return a full document.'
      : mode === 'insert'
        ? 'Return only the new declarations in one fenced code block.'
        : 'If the user asks for a change, return the complete resulting document in one fenced code block.';

  try {
    const messages = [
      vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
      vscode.LanguageModelChatMessage.User(
        `${contextText}\n\nInstruction: ${instructions}\n\nUser request: ${request.prompt}`
      ),
    ];
    const stream = await model.sendRequest(messages, {}, token);
    let answer = '';
    for await (const chunk of stream.text) {
      answer += chunk;
      response.markdown(chunk);
    }

    if (request.command !== 'explain' && hasCodeBlock(answer)) {
      lastProposal = {
        code: extractCode(answer, snapshot?.languageId ?? 'sysml'),
        mode,
        uri: snapshot?.document.uri.toString(),
      };
      response.button({
        command: 'sysml.ai.previewLast',
        title: mode === 'insert' ? 'Preview insertion as diff' : 'Preview change as diff',
      });
    }

    return {};
  } catch (error) {
    response.markdown(`**SysML AI:** ${describeError(error)}`);
    return { errorDetails: { message: String(error) } };
  }
}

/** Apply the last chat proposal to the active editor through a diff. */
async function previewLast(getClient: () => LanguageClient | undefined): Promise<void> {
  if (!lastProposal) {
    void vscode.window.showInformationMessage('SysML AI: ask the assistant for a change first.');
    return;
  }
  const snapshot = snapshotEditor();
  if (!snapshot) {
    void vscode.window.showWarningMessage('SysML: open a SysML or KerML file first.');
    return;
  }
  if (lastProposal.uri && lastProposal.uri !== snapshot.document.uri.toString()) {
    void vscode.window.showWarningMessage(
      'SysML AI: this proposal was generated for another file. Reopen that file or ask again.'
    );
    return;
  }

  const { code, mode } = lastProposal;
  let newText: string;
  if (mode === 'insert') {
    const document = snapshot.document;
    const offset = document.offsetAt(snapshot.selection.active);
    const full = document.getText();
    const prefix = full.slice(0, offset);
    const suffix = full.slice(offset);
    const separator = prefix.endsWith('\n') || !prefix ? '' : '\n';
    newText = prefix + separator + code + '\n' + suffix;
  } else {
    newText = replacementText(snapshot, code);
  }
  if (!(await confirmProposalParses(getClient, newText))) {
    return;
  }
  await proposeEdit(snapshot.document, newText, 'SysML AI: proposed change');
}

/** Register the chat participant and its companion command. */
export function registerAgentPanel(
  context: vscode.ExtensionContext,
  getClient: () => LanguageClient | undefined
): void {
  const participant = vscode.chat.createChatParticipant('sysml.assistant', handleChat);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'sysml-icon.svg');
  context.subscriptions.push(
    participant,
    vscode.commands.registerCommand('sysml.ai.previewLast', () => previewLast(getClient))
  );
}

/** Exposed for tests and diagnostics. */
export function lastProposalSummary(): string {
  return lastProposal ? `${lastProposal.mode}: ${truncate(lastProposal.code, 60)}` : 'none';
}
