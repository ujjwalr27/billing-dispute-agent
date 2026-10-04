// Helpers that invoke the real Next.js route handlers (validation, error
// mapping, persistence) exactly as the framework would, without an HTTP server.
import { prisma } from "@/lib/db";
import type { CreateCaseInput } from "@/lib/validation";
import * as casesRoute from "@/app/api/cases/route";
import * as caseRoute from "@/app/api/cases/[id]/route";
import * as recalcRoute from "@/app/api/cases/[id]/recalculate/route";
import * as investigateRoute from "@/app/api/cases/[id]/investigate/route";
import * as evidenceRoute from "@/app/api/cases/[id]/evidence/route";
import * as adjustmentsRoute from "@/app/api/cases/[id]/adjustments/route";
import * as reopenRoute from "@/app/api/cases/[id]/reopen/route";
import * as resolveRoute from "@/app/api/cases/[id]/resolve/route";
import * as findingRoute from "@/app/api/findings/[id]/route";
import * as samplesRoute from "@/app/api/samples/route";

export interface ApiResult<T = any> {
  status: number;
  ok: boolean;
  data: T;
  error?: string;
  details?: any;
}

type Handler = (req: any, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

async function invoke<T = any>(
  handler: Handler,
  method: string,
  id: string | null,
  body?: unknown,
): Promise<ApiResult<T>> {
  const req = new Request("http://test.local/api", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await handler(req, { params: Promise.resolve({ id: id ?? "" }) });
  const json = await res.json();
  return { status: res.status, ok: json.ok, data: json.data, error: json.error, details: json.details };
}

export const api = {
  listCases: () => invoke(casesRoute.GET as Handler, "GET", null),
  createCase: (body: unknown) => invoke<{ id: string }>(casesRoute.POST as Handler, "POST", null, body),
  getCase: (id: string) => invoke(caseRoute.GET as Handler, "GET", id),
  recalculate: (id: string) => invoke(recalcRoute.POST as Handler, "POST", id, {}),
  investigate: (id: string, body: unknown = {}) =>
    invoke(investigateRoute.POST as Handler, "POST", id, body),
  addEvidence: (id: string, body: unknown) => invoke(evidenceRoute.POST as Handler, "POST", id, body),
  approveCredit: (id: string, body: unknown) =>
    invoke(adjustmentsRoute.POST as Handler, "POST", id, body),
  reopen: (id: string, body: unknown = {}) => invoke(reopenRoute.POST as Handler, "POST", id, body),
  resolve: (id: string, body: unknown = {}) => invoke(resolveRoute.POST as Handler, "POST", id, body),
  createSample: (body: unknown) => invoke<{ id: string }>(samplesRoute.POST as Handler, "POST", null, body),
  reviewFinding: (id: string, body: unknown) =>
    invoke(findingRoute.PATCH as Handler, "PATCH", id, body),
};

/** Wipe all data (cascades from Case) so every test starts clean. */
export async function resetDb() {
  await prisma.case.deleteMany({});
}

/** Create a case through the API and return its id. */
export async function createCase(input: CreateCaseInput): Promise<string> {
  const res = await api.createCase(input);
  if (res.status !== 201) throw new Error(`createCase failed: ${res.status} ${res.error}`);
  return res.data.id;
}

/** Full case as the UI sees it. */
export async function getCase(id: string) {
  const res = await api.getCase(id);
  if (!res.ok) throw new Error(`getCase failed: ${res.status} ${res.error}`);
  return res.data;
}

export function credit(amountCents: number, idempotencyKey: string, reason = "test credit") {
  return { amountCents, idempotencyKey, reason, approvedBy: "test-reviewer" };
}

export function actions(c: { decisionLogs: { action: string }[] }): string[] {
  // decisionLogs are newest-first; return chronological order
  return [...c.decisionLogs].reverse().map((l) => l.action);
}
