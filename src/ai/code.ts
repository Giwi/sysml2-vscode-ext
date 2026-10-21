/**
 * Pure helpers for model answers, kept free of the `vscode` module so they can
 * be unit tested without an editor host.
 */

/**
 * Extract the code to apply from a model answer. Models usually wrap the
 * document in a fence; when they do not, the trimmed answer is used as-is.
 */
export function extractCode(answer: string, languageId: string): string {
  const fence = new RegExp('```(?:' + languageId + '|sysml|kerml|uml)?\\s*\\n([\\s\\S]*?)```', 'i');
  const match = fence.exec(answer);
  return (match ? match[1] : answer).trim();
}
