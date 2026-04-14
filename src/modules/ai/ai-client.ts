/**
 * src/modules/ai/ai-client.ts
 *
 * Thin wrapper around the Anthropic Messages API used by all CounselWorks AI
 * endpoints. Uses Node 18+ global fetch so there is no runtime dependency on
 * @anthropic-ai/sdk — swap in the SDK later by replacing the fetch call if you
 * want streaming or tool use.
 *
 * The BASE_SYSTEM prompt is prepended to every call. Task-specific system
 * prompts live in ai.router.ts and get concatenated below BASE_SYSTEM.
 *
 * RULES ENFORCED HERE:
 *   - Model is hardcoded (claude-sonnet-4-20250514). No caller override.
 *   - API key is read from ANTHROPIC_API_KEY. If unset, callClaude returns
 *     { success: false } without throwing — callers must handle this gracefully
 *     so AI failure never blocks a user action.
 *   - Timeout is 30s. Hanging Anthropic calls never block a request thread
 *     long enough to stall the portal.
 *   - Output is parsed as JSON when possible; otherwise returned as
 *     { raw_text: "..." } so structured endpoints can distinguish malformed
 *     responses.
 */

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 2048;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 30_000;

// ── BASE SYSTEM PROMPT (included in EVERY AI call) ──────────────────────────
const BASE_SYSTEM = `You are a legal operations assistant for CounselWorks, a service that provides administrative and operational support to U.S. plaintiff law firms.

STRICT RULES — FOLLOW THESE WITHOUT EXCEPTION:
1. You do NOT provide legal advice. You do NOT make legal conclusions.
2. You do NOT recommend case strategy, settlement amounts, or litigation tactics.
3. You ONLY classify, summarize, structure, and draft administrative content.
4. When information is missing or unclear, use [MISSING: description] placeholders. NEVER fabricate facts.
5. Never fabricate case facts, dates, medical information, provider names, dollar amounts, or legal citations.
6. Never guess at medical diagnoses, prognoses, or treatment outcomes.
7. All output is labeled as draft material for attorney review only.
8. You are assisting paralegals, not attorneys. Your output will be reviewed by a human before any attorney sees it.
9. If a request asks you to do something outside your scope (legal advice, case strategy, client counseling), respond with: {"error": "OUT_OF_SCOPE", "message": "This request requires attorney judgment and cannot be handled by the AI assistant."}
10. Be precise, professional, and concise. No conversational filler.`;

export interface AICallResult {
  success: boolean;
  output: any;
  rawResponse: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicMessagesResponse {
  id: string;
  model: string;
  content: AnthropicContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

function makeFailure(message: string, start: number): AICallResult {
  return {
    success: false,
    output: { error: message },
    rawResponse: message,
    model: MODEL,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: Date.now() - start,
  };
}

/**
 * Extract a JSON object from raw text. Strips markdown fences and leading
 * preamble. Returns null if no valid JSON can be extracted — callers should
 * then wrap the raw text in { raw_text: ... } themselves.
 */
function tryParseJSON(text: string): any | null {
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: find the first {...} block and try that.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function callClaude(
  taskSystemPrompt: string,
  userMessage: string,
  options?: { maxTokens?: number; timeoutMs?: number },
): Promise<AICallResult> {
  const start = Date.now();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  console.log(`[AI] callClaude invoked | keyPresent=${!!apiKey} | promptLen=${taskSystemPrompt.length} | userLen=${userMessage.length} | maxTokens=${options?.maxTokens ?? MAX_TOKENS}`);

  if (!apiKey) {
    console.warn('[AI] callClaude aborting: ANTHROPIC_API_KEY is not set in process.env');
    return makeFailure('ANTHROPIC_API_KEY is not set', start);
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: options?.maxTokens ?? MAX_TOKENS,
        system: `${BASE_SYSTEM}\n\n${taskSystemPrompt}`,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });

    console.log(`[AI] Anthropic HTTP ${res.status} in ${Date.now() - start}ms`);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[AI] Anthropic API error body: ${body.slice(0, 500)}`);
      return makeFailure(`Anthropic API ${res.status}: ${body.slice(0, 500)}`, start);
    }

    const json = (await res.json()) as AnthropicMessagesResponse;
    const rawText = (json.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('');

    const parsed = tryParseJSON(rawText);
    const output = parsed ?? { raw_text: rawText };

    console.log(`[AI] callClaude success | inputTokens=${json.usage?.input_tokens} | outputTokens=${json.usage?.output_tokens} | parsed=${parsed !== null} | rawText="${rawText.slice(0, 200).replace(/\n/g, ' ')}"`);

    return {
      success: true,
      output,
      rawResponse: rawText,
      model: MODEL,
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    const msg =
      err?.name === 'AbortError'
        ? `Anthropic API timed out after ${options?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : err?.message ?? String(err);
    console.error(`[AI] callClaude threw: ${msg}`);
    return makeFailure(msg, start);
  } finally {
    clearTimeout(timeout);
  }
}

export { MODEL as CLAUDE_MODEL };
