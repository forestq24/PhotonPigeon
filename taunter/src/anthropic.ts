/** Adapter-only provider call. Never logs credentials, prompts, or provider error bodies. */
export const haikuModel = 'claude-haiku-4-5-20251001';
export const fallbackReply = 'my trash talk is buffering. your move.';

export async function anthropicReply(options: {
  apiKey: string; model: string; prompt: string; workspaceId?: string;
  endpoint?: string; timeoutMs?: number; fallbackResponse?: string;
}): Promise<{ response: string; fallback: boolean }> {
  try {
    if (!options.apiKey || !options.model || options.prompt.length > 2000) throw new Error('Missing configuration');
    const response = await fetch(options.endpoint ?? 'https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(options.timeoutMs ?? 10000), redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01',
        ...(options.workspaceId ? { 'anthropic-workspace-id': options.workspaceId } : {}) },
      body: JSON.stringify({ model: options.model, max_tokens: 100, messages: [{ role: 'user', content: options.prompt }] }),
    });
    if (!response.ok) throw new Error('Provider rejected request');
    const parsed = await response.json() as { content?: { type?: string; text?: unknown }[] } | null;
    const blocks = Array.isArray(parsed?.content) ? parsed.content.filter(block => block?.type === 'text') : [];
    if (blocks.some(block => typeof block.text !== 'string')) throw new Error('Malformed text block');
    const text = blocks.map(block => block.text).join('').trim();
    if (!text || text.length > 1000) throw new Error('Malformed response');
    return { response: text, fallback: false };
  } catch { return { response: options.fallbackResponse ?? fallbackReply, fallback: true }; }
}
