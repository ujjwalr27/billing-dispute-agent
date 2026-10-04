import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "@/lib/log";
import { agentOutputSchema, type AgentOutput } from "@/lib/validation";
import type { AgentProvider, InvestigationContext } from "./provider";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt";

/** HTTP statuses worth retrying: overload, rate limit, transient server errors. */
const RETRYABLE = new Set([429, 500, 503, 504]);

export interface GeminiOptions {
  /** models tried in order after the primary fails with a retryable error */
  fallbackModels?: string[];
  /** retries per model for retryable errors (default 2) */
  retries?: number;
  /** base backoff in ms, doubled each retry (default 1000) */
  backoffMs?: number;
  /** per-request timeout in ms (default 30s) */
  timeoutMs?: number;
  /** total time budget across all attempts and models (default 75s) */
  budgetMs?: number;
}

/**
 * Gemini-backed interpreter. It receives the deterministic recalculation and
 * evidence as read-only context and returns structured, cited findings. It is
 * never asked to compute money. Output is parsed and validated by the caller;
 * this class only handles the model call and JSON extraction.
 *
 * Gemini models intermittently return 503 "high demand". Each model is retried
 * with exponential backoff, then the next fallback model is tried, before the
 * orchestrator falls back to the deterministic mock.
 */
export class GeminiProvider implements AgentProvider {
  readonly name = "gemini";
  /** the model that actually produced the last successful answer */
  lastModelUsed: string | null = null;
  private client: GoogleGenerativeAI;
  private models: string[];
  private retries: number;
  private backoffMs: number;
  private timeoutMs: number;
  private budgetMs: number;

  constructor(apiKey: string, model = "gemini-3.6-flash", opts: GeminiOptions = {}) {
    this.client = new GoogleGenerativeAI(apiKey);
    this.models = [model, ...(opts.fallbackModels ?? []).filter((m) => m && m !== model)];
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.budgetMs = opts.budgetMs ?? 75_000;
  }

  async investigate(ctx: InvestigationContext): Promise<AgentOutput> {
    const prompt = buildUserPrompt(ctx);
    const failures: string[] = [];
    // Bound total latency: the reviewer is waiting on this request, and slow
    // or hung upstream calls must end in the mock fallback, not a timeout page.
    const deadline = Date.now() + this.budgetMs;

    for (const modelName of this.models) {
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`Gemini time budget exhausted (${failures.join(", ") || "no attempts"})`);
        }
        const t0 = Date.now();
        try {
          const output = await this.call(modelName, prompt, Math.min(this.timeoutMs, remaining));
          this.lastModelUsed = modelName;
          logger.info("agent.llm.call", { model: modelName, attempt: attempt + 1, ok: true, durationMs: Date.now() - t0 });
          return output;
        } catch (err) {
          const status = statusOf(err);
          const retryable = status !== undefined && RETRYABLE.has(status);
          failures.push(`${modelName}#${attempt + 1}: ${status ?? shortMessage(err)}`);
          logger.warn("agent.llm.call", {
            model: modelName,
            attempt: attempt + 1,
            ok: false,
            status,
            retryable,
            error: shortMessage(err),
            durationMs: Date.now() - t0,
          });
          if (!retryable) break; // e.g. 404 / bad JSON: retrying this model won't help
          if (attempt < this.retries) {
            await sleep(Math.min(this.backoffMs * 2 ** attempt, Math.max(0, deadline - Date.now())));
          }
        }
      }
    }
    throw new Error(`All Gemini models failed (${failures.join(", ")})`);
  }

  private async call(modelName: string, prompt: string, timeoutMs: number): Promise<AgentOutput> {
    const model = this.client.getGenerativeModel(
      {
        model: modelName,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      },
      { timeout: timeoutMs },
    );
    const result = await model.generateContent(prompt);
    const parsed = extractJson(result.response.text());
    // Validate here so a malformed model response surfaces as a clear error to
    // the orchestrator rather than silently persisting garbage.
    return agentOutputSchema.parse(parsed);
  }
}

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

function shortMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 80);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Extract a JSON object from a model response, tolerating stray fences/prose. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Gemini response did not contain parseable JSON");
  }
}
