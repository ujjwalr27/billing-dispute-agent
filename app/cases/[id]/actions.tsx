"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Bolt, Calculator, Check, Info, Plus, Sparkles, Undo, Warning } from "../../icons";

async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(describeError(json, res.status));
  }
  return json.data;
}

/** Include Zod's field/form messages so reviewers see *what* was invalid. */
function describeError(
  json: { error?: string; details?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> } },
  status: number,
): string {
  const base = json.error ?? `Request failed (${status})`;
  const msgs = [
    ...(json.details?.formErrors ?? []),
    ...Object.entries(json.details?.fieldErrors ?? {}).flatMap(([field, list]) =>
      (list ?? []).map((m) => `${field}: ${m}`),
    ),
  ];
  return msgs.length ? `${base}: ${msgs.slice(0, 3).join("; ")}` : base;
}

type Busy = "recalc" | "investigate" | "investigate-fault" | "resolve" | "reopen" | null;

export function CaseActions({
  caseId,
  status,
  resolveBlocker,
}: {
  caseId: string;
  status: string;
  /** why the case can't be resolved yet, or null when it can */
  resolveBlocker: string | null;
}) {
  const resolved = status === "RESOLVED";
  const router = useRouter();
  const [busy, setBusy] = useState<Busy>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  async function run(label: Exclude<Busy, null>, fn: () => Promise<unknown>) {
    setBusy(label);
    setErr(null);
    setMsg(null);
    try {
      const data = (await fn()) as Record<string, unknown> | undefined;
      if (label.startsWith("investigate") && data) {
        setMsg(
          `Investigation complete via ${data.provider}. ` +
            `${data.findings} finding(s), ${data.resolutionOptions} option(s).` +
            (Array.isArray(data.toolFailures) && data.toolFailures.length
              ? ` Tool failures: ${(data.toolFailures as string[]).join(", ")}.`
              : "") +
            (Array.isArray(data.droppedCitations) && data.droppedCitations.length
              ? ` Dropped ${(data.droppedCitations as unknown[]).length} invalid citation(s).`
              : ""),
        );
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  const spin = (label: Busy, icon: React.ReactNode) =>
    busy === label ? <span className="spinner" aria-hidden="true" /> : icon;

  return (
    <div>
      <div className="toolbar" role="toolbar" aria-label="Case actions">
        <button
          disabled={busy !== null}
          onClick={() => run("recalc", () => post(`/api/cases/${caseId}/recalculate`))}
        >
          {spin("recalc", <Calculator />)}
          {busy === "recalc" ? "Recalculating…" : "Recalculate"}
        </button>
        <button
          className="primary"
          disabled={busy !== null || resolved}
          title={resolved ? "Reopen the case to re-investigate" : undefined}
          onClick={() => run("investigate", () => post(`/api/cases/${caseId}/investigate`))}
        >
          {spin("investigate", <Sparkles />)}
          {busy === "investigate" ? "Investigating…" : "Run AI investigation"}
        </button>
        <button
          className="plain"
          disabled={busy !== null || resolved}
          title="Simulate the usage-events tool being unavailable"
          onClick={() =>
            run("investigate-fault", () =>
              post(`/api/cases/${caseId}/investigate`, { faultInject: "usage" }),
            )
          }
        >
          {spin("investigate-fault", <Bolt />)}
          Investigate w/ usage tool down
        </button>

        <span className="grow" />

        <button
          disabled={busy !== null}
          onClick={() => {
            setSheetOpen(true);
            setMsg(null);
          }}
        >
          <Plus />
          Add evidence
        </button>
        {!resolved && (
          <button
            className="good"
            disabled={busy !== null || resolveBlocker !== null}
            title={resolveBlocker ? `To resolve: ${resolveBlocker}` : "Close this dispute"}
            onClick={() => run("resolve", () => post(`/api/cases/${caseId}/resolve`))}
          >
            {spin("resolve", <Check />)}
            Mark resolved
          </button>
        )}
        {resolved && (
          <button
            className="danger"
            disabled={busy !== null}
            onClick={() => run("reopen", () => post(`/api/cases/${caseId}/reopen`))}
          >
            {spin("reopen", <Undo />)}
            Reopen case
          </button>
        )}
      </div>

      {((!resolved && resolveBlocker) || msg || err) && (
        <div className="toolbar-foot">
          {!resolved && resolveBlocker && (
            <p className="faint small" style={{ margin: "0 6px" }}>
              To resolve: {resolveBlocker}
            </p>
          )}
          {msg && (
            <div className="banner info" role="status">
              <Info size={18} />
              <div>{msg}</div>
            </div>
          )}
          {err && (
            <div className="banner bad" role="alert">
              <Warning size={18} />
              <div>{err}</div>
            </div>
          )}
        </div>
      )}

      {sheetOpen && (
        <AddEvidenceSheet
          caseId={caseId}
          onClose={(info) => {
            setSheetOpen(false);
            if (info) setMsg(info);
          }}
        />
      )}
    </div>
  );
}

function AddEvidenceSheet({
  caseId,
  onClose,
}: {
  caseId: string;
  /** called with an optional message to show after the sheet closes */
  onClose: (info?: string) => void;
}) {
  const router = useRouter();
  const [text, setText] = useState(EMPTY);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Latest callback without re-running the mount effect (which would steal focus).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    textRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, []);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(
          `Evidence must be valid JSON (${e instanceof Error ? e.message : "parse error"}).`,
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error('Evidence must be a JSON object, e.g. { "usage": [...] }.');
      }
      const ev = parsed as { rules?: unknown[]; usage?: unknown[]; payments?: unknown[] };
      const count = [ev.rules, ev.usage, ev.payments].reduce(
        (n: number, list) => n + (Array.isArray(list) ? list.length : 0),
        0,
      );
      if (count === 0) {
        throw new Error("Add at least one rule, usage event, or payment.");
      }
      const result = (await post(`/api/cases/${caseId}/evidence`, { ...parsed, note })) as {
        reopened: boolean;
        skipped: string[];
        updatedRules: string[];
      };
      router.refresh();
      onClose(
        result.reopened
          ? result.skipped.length
            ? `Evidence added. Already present (ignored): ${result.skipped.join(", ")}.`
            : "Evidence added. Earlier conclusions are now stale — re-run the investigation."
          : `Nothing new — already on this case: ${result.skipped.join(", ")}. Case not reopened.`,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Invalid JSON or request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="sheet-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="add-evidence-title">
        <h2 id="add-evidence-title">Add evidence</h2>
        <p className="muted small" style={{ margin: "6px 0 0" }}>
          New evidence changes the evidence snapshot, marks earlier conclusions as stale, and
          reopens the case. Paste pricing rules, usage events or payments as JSON.
        </p>

        <label className="field" htmlFor="evidence-json">
          Evidence (JSON)
        </label>
        <textarea
          id="evidence-json"
          ref={textRef}
          rows={12}
          className="mono"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="sm" type="button" onClick={() => setText(EXAMPLE)}>
            Insert example
          </button>
          <span className="faint small">
            The API overage rule and usage missing from the Cinder Logistics case.
          </span>
        </div>

        <label className="field" htmlFor="evidence-note">
          Note
        </label>
        <input
          id="evidence-note"
          type="text"
          placeholder="Why this evidence was added"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {err && (
          <div className="banner bad" role="alert" style={{ marginTop: 14 }}>
            <Warning size={18} />
            <div>{err}</div>
          </div>
        )}

        <div className="sheet-actions">
          <button type="button" disabled={busy} onClick={() => onClose()}>
            Cancel
          </button>
          <button className="primary" type="button" disabled={busy} onClick={submit}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Adding…" : "Add evidence & reopen"}
          </button>
        </div>
      </div>
    </div>
  );
}

// The form starts empty so nothing case-specific is submitted by accident.
const EMPTY = JSON.stringify({ rules: [], usage: [], payments: [] }, null, 2);

// Opt-in example: the pricing rule + usage missing from the "missing evidence"
// demo case, so the reopen -> re-investigate flow can be shown quickly.
const EXAMPLE = JSON.stringify(
  {
    rules: [
      {
        code: "RULE-OVERAGE",
        description: "API overage pricing",
        kind: "PER_UNIT",
        params: { usageType: "api_call", unitPriceCents: 1 },
      },
    ],
    usage: [
      {
        ref: "USG-API-1",
        type: "api_call",
        quantity: 3000,
        occurredAt: "2026-01-25T00:00:00.000Z",
      },
    ],
    payments: [],
  },
  null,
  2,
);
