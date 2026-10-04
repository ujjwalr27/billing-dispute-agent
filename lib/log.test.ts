import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "./log";

describe("structured logger", () => {
  let out: ReturnType<typeof vi.spyOn>;
  const prev = process.env.LOG_LEVEL;

  beforeEach(() => {
    process.env.LOG_LEVEL = "info";
    out = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env.LOG_LEVEL = prev;
    vi.restoreAllMocks();
  });

  it("writes one JSON object per line with level, event and fields", () => {
    log("info", "agent.investigation.finished", { caseId: "c1", durationMs: 12 });
    const entry = JSON.parse(out.mock.calls[0][0] as string);
    expect(entry).toMatchObject({ level: "info", event: "agent.investigation.finished", caseId: "c1", durationMs: 12 });
    expect(typeof entry.ts).toBe("string");
  });

  it("redacts secret-looking fields, including nested ones", () => {
    log("info", "x", { apiKey: "abc", nested: { authorization: "Bearer t" }, model: "m" });
    const entry = JSON.parse(out.mock.calls[0][0] as string);
    expect(entry.apiKey).toBe("[redacted]");
    expect(entry.nested.authorization).toBe("[redacted]");
    expect(entry.model).toBe("m");
  });

  it("serializes errors and respects the level threshold", () => {
    log("info", "x", { err: new Error("boom") });
    expect(JSON.parse(out.mock.calls[0][0] as string).err).toEqual({ name: "Error", message: "boom" });
    process.env.LOG_LEVEL = "warn";
    log("info", "dropped");
    expect(out).toHaveBeenCalledTimes(1);
  });
});
