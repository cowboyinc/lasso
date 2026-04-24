/**
 * Direct vLLM client — calls runner's OpenAI-compatible endpoint
 * for streaming chat completions. No on-chain job submission.
 */

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
}

const MAX_CONTEXT = 8192;
const SAFETY_MARGIN = 800;
const MAX_OUTPUT_TOKENS = 6144;
const MIN_OUTPUT_TOKENS = 1024;

function estimateTokens(text: string): number {
  const hasCode = text.includes("```") || text.includes("def ") || text.includes("import ");
  const bytesPerToken = hasCode ? 2 : 3;
  return Math.ceil(text.length / bytesPerToken);
}

/**
 * Trim conversation messages to fit within the model's context window.
 * Always keeps the system prompt and the most recent user message.
 */
export function trimMessages(
  systemPrompt: string,
  history: ChatMessage[]
): { messages: ChatMessage[]; maxOutputTokens: number } {
  const systemMsg: ChatMessage = { role: "system", content: systemPrompt };
  const systemTokens = estimateTokens(systemPrompt);
  const inputBudget = MAX_CONTEXT - MAX_OUTPUT_TOKENS - SAFETY_MARGIN;

  const fitting: ChatMessage[] = [];
  let tokenCount = systemTokens;

  // Add messages newest-first until budget is full
  for (let i = history.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(history[i].content);
    if (tokenCount + msgTokens > inputBudget && fitting.length >= 2) break;
    tokenCount += msgTokens;
    fitting.unshift(history[i]);
  }

  // Always include at least the last message
  if (fitting.length === 0 && history.length > 0) {
    fitting.push(history[history.length - 1]);
    tokenCount += estimateTokens(history[history.length - 1].content);
  }

  const roomForOutput = MAX_CONTEXT - tokenCount - SAFETY_MARGIN;
  const maxOutputTokens = Math.max(
    MIN_OUTPUT_TOKENS,
    Math.min(MAX_OUTPUT_TOKENS, roomForOutput)
  );

  return {
    messages: [systemMsg, ...fitting],
    maxOutputTokens,
  };
}

/**
 * Stream a chat completion from a vLLM endpoint.
 * Returns the full accumulated response text.
 */
export async function streamChat(
  runnerUrl: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  callbacks: StreamCallbacks
): Promise<string> {
  const url = `${runnerUrl.replace(/\/$/, "")}/v1/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: maxTokens,
        repetition_penalty: 1.15,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    callbacks.onError(`Failed to connect to runner: ${msg}`);
    return "";
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    callbacks.onError(`Runner error (${response.status}): ${errorText.slice(0, 200)}`);
    return "";
  }

  if (!response.body) {
    callbacks.onError("No response body from runner");
    return "";
  }

  let accumulated = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data);
          const token = chunk.choices?.[0]?.delta?.content;
          if (token) {
            accumulated += token;
            callbacks.onToken(token);
          }
        } catch { /* skip malformed SSE */ }
      }
    }

    callbacks.onDone(accumulated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    callbacks.onError(`Stream error: ${msg}`);
  }

  return accumulated;
}

/**
 * Discover the model name from a vLLM endpoint.
 * Returns the first available model ID.
 */
export async function discoverModel(runnerUrl: string): Promise<string | null> {
  try {
    const url = `${runnerUrl.replace(/\/$/, "")}/v1/models`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { data: { id: string }[] };
    return data.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}
