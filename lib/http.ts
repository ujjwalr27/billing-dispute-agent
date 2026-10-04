import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError } from "@/lib/errors";
import { logger, requestId } from "@/lib/log";

/** Standard JSON success response. */
export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ ok: true, data }, { status });
}

/** Standard JSON error response. */
export function fail(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ ok: false, error: message, details }, { status });
}

/**
 * Wrap a route handler so thrown errors become clean JSON responses instead of
 * opaque 500s — Zod validation errors become 400s with field details. Every
 * request is logged as one structured line (method, path, status, latency).
 */
export function handle<A extends unknown[]>(
  fn: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    const started = Date.now();
    const req = args[0] instanceof Request ? args[0] : null;
    const id = requestId();
    const res = await run(fn, args, id);
    const status = res.status;
    logger[status >= 500 ? "error" : status >= 400 ? "warn" : "info"]("api.request", {
      requestId: id,
      method: req?.method,
      path: req ? new URL(req.url).pathname : undefined,
      status,
      durationMs: Date.now() - started,
    });
    return res;
  };
}

async function run<A extends unknown[]>(
  fn: (...args: A) => Promise<Response>,
  args: A,
  id: string,
): Promise<Response> {
  try {
    return await fn(...args);
  } catch (err) {
    if (err instanceof ZodError) {
      return fail("Validation failed", 400, err.flatten());
    }
    if (err instanceof AppError) {
      logger.warn("api.rejected", { requestId: id, status: err.status, reason: err.message });
      return fail(err.message, err.status);
    }
    // Prisma "record to update/delete not found" (e.g. unknown finding id).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return fail("Not found", 404);
    }
    // Unique constraint (e.g. a duplicate evidence ref slipping past checks).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return fail("Conflicts with existing data (duplicate reference)", 409);
    }
    // Malformed JSON request body.
    if (err instanceof SyntaxError) {
      return fail("Request body must be valid JSON", 400);
    }
    // Anything else is a genuine server fault: log it, don't leak internals.
    logger.error("api.error", {
      requestId: id,
      err,
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 6).join(" | ") : undefined,
    });
    return fail("Internal server error", 500);
  }
}
