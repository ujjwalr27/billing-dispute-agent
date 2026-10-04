// Structured application logs: one JSON object per line on stdout/stderr, so
// they can be searched and filtered in any log viewer (Vercel, Docker, etc.).
// The append-only DecisionLog table is the *business* audit trail; these logs
// are the *operational* trail (requests, latency, LLM attempts, fallbacks).

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

// Field names whose values must never reach the logs.
const SECRET = /key|token|secret|password|authorization|cookie/i;

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level | "silent";
  return ORDER[lvl] ?? ORDER.info;
}

function clean(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET.test(k) ? "[redacted]" : clean(v, depth + 1);
  }
  return out;
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(clean(fields) as Record<string, unknown>),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => log("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => log("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log("error", event, fields),
};

/** Short random id to correlate the log lines of one request. */
export function requestId(): string {
  return Math.random().toString(36).slice(2, 10);
}
