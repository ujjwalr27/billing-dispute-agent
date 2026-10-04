import { describe, expect, it } from "vitest";
import type { AgentOutput } from "@/lib/validation";
import { GeminiProvider } from "./gemini";
import type { InvestigationContext } from "./provider";

const ctx: InvestigationContext = {
  disputeDescription: "test",
  evidence: null,
  recalc: null,
  payments: [],
  toolFailures: [],
};
const OK: AgentOutput = { findings: [], resolutionOptions: [] };

/** Replace the network call with a scripted sequence of outcomes per model. */
function scripted(
  provider: GeminiProvider,
  script: Record<string, Array<number | "ok">>,
): string[] {
  const calls: string[] = [];
  (provider as unknown as { call: (m: string) => Promise<AgentOutput> }).call = async (
    model: string,
  ) => {
    calls.push(model);
    const next = script[model]?.shift();
    if (next === "ok") return OK;
    throw Object.assign(new Error(`status ${next}`), { status: next });
  };
  return calls;
}

describe("GeminiProvider resilience", () => {
  it("retries a transient 503 and succeeds on the same model", async () => {
    const p = new GeminiProvider("k", "primary", { backoffMs: 0 });
    const calls = scripted(p, { primary: [503, 503, "ok"] });
    await expect(p.investigate(ctx)).resolves.toEqual(OK);
    expect(calls).toEqual(["primary", "primary", "primary"]);
    expect(p.lastModelUsed).toBe("primary");
  });

  it("moves to the fallback model when the primary stays overloaded", async () => {
    const p = new GeminiProvider("k", "primary", {
      fallbackModels: ["backup"],
      retries: 1,
      backoffMs: 0,
    });
    const calls = scripted(p, { primary: [503, 503], backup: ["ok"] });
    await expect(p.investigate(ctx)).resolves.toEqual(OK);
    expect(calls).toEqual(["primary", "primary", "backup"]);
    expect(p.lastModelUsed).toBe("backup");
  });

  it("does not retry non-retryable errors like 404", async () => {
    const p = new GeminiProvider("k", "primary", {
      fallbackModels: ["backup"],
      backoffMs: 0,
    });
    const calls = scripted(p, { primary: [404], backup: ["ok"] });
    await p.investigate(ctx);
    expect(calls).toEqual(["primary", "backup"]);
  });

  it("throws when every model is exhausted, so the orchestrator can fall back", async () => {
    const p = new GeminiProvider("k", "primary", {
      fallbackModels: ["backup"],
      retries: 0,
      backoffMs: 0,
    });
    scripted(p, { primary: [503], backup: [429] });
    await expect(p.investigate(ctx)).rejects.toThrow(/All Gemini models failed/);
  });

  it("stops once the total time budget is spent, so the orchestrator can fall back", async () => {
    const p = new GeminiProvider("k", "primary", { fallbackModels: ["backup"], budgetMs: 0 });
    const calls = scripted(p, { primary: ["ok"], backup: ["ok"] });
    await expect(p.investigate(ctx)).rejects.toThrow(/time budget exhausted/);
    expect(calls).toEqual([]);
  });

  it("passes a bounded per-request timeout to every call", async () => {
    const p = new GeminiProvider("k", "primary", { timeoutMs: 1234 });
    const timeouts: number[] = [];
    (p as unknown as { call: (m: string, pr: string, t: number) => Promise<AgentOutput> }).call =
      async (_m, _pr, t) => {
        timeouts.push(t);
        return OK;
      };
    await p.investigate(ctx);
    expect(timeouts).toEqual([1234]);
  });
});
