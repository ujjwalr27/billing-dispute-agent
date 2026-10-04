"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { formatCents } from "@/lib/money";
import type { Citation } from "@/lib/types";
import { CheckCircle, Clock, Creditcard, Info, Warning, XCircle } from "../../icons";
import { LocalTime } from "../../local-time";
import { Citations, Empty, FINDING_TYPE, Pill, REVIEW_STATUS } from "../../ui";

async function req(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

interface FindingVM {
  id: string;
  type: string;
  summary: string;
  reviewStatus: string;
  editedText: string | null;
  stale: boolean;
  citationsParsed: Citation[];
}

const DECISION_TEXT: Record<string, string> = {
  ACCEPTED: "Accepted by reviewer",
  EDITED: "Accepted with reviewer edits",
  REJECTED: "Rejected by reviewer",
};

function StaleBadge() {
  return (
    <span className="badge warn">
      <Clock size={12} /> Stale
    </span>
  );
}

export function FindingList({ findings }: { findings: FindingVM[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [changing, setChanging] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<Record<string, string>>({});
  // Synchronous guard: state updates are async, so a fast double-click could
  // otherwise send two requests before the buttons re-render as disabled.
  const inFlight = useRef(new Set<string>());

  async function act(id: string, reviewStatus: string, editedText?: string) {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setBusy(id);
    setError((e) => ({ ...e, [id]: "" }));
    try {
      await req(`/api/findings/${id}`, "PATCH", { reviewStatus, editedText });
      setEditing(null);
      setChanging(null);
      router.refresh();
    } catch (e) {
      setError((prev) => ({ ...prev, [id]: e instanceof Error ? e.message : "Review failed" }));
    } finally {
      inFlight.current.delete(id);
      setBusy(null);
    }
  }

  return (
    <>
      {findings.map((f) => {
        const decided = f.reviewStatus !== "PENDING";
        const showActions = !f.stale && (!decided || changing === f.id);
        return (
          <article key={f.id} className={"card" + (f.stale ? " stale" : "")} data-review={f.reviewStatus}>
            <div className="row spread">
              <Pill map={FINDING_TYPE} value={f.type} data-type={f.type} />
              <span className="row" style={{ gap: 6 }}>
                {f.stale && <StaleBadge />}
                <Pill map={REVIEW_STATUS} value={f.reviewStatus} />
              </span>
            </div>
            <p className="summary-text">{f.summary}</p>
            {f.editedText && (
              <p className="edit-note">
                <span className="muted">Reviewer edit:</span> {f.editedText}
              </p>
            )}
            <Citations citations={f.citationsParsed} />

            {f.stale && (
              <p className="muted small" style={{ margin: "12px 0 0" }}>
                Based on earlier evidence — re-run the investigation before reviewing.
              </p>
            )}

            {!f.stale && decided && changing !== f.id && editing !== f.id && (
              <div className={"decision" + (f.reviewStatus === "REJECTED" ? " rejected" : "")}>
                {f.reviewStatus === "REJECTED" ? <XCircle /> : <CheckCircle />}
                <span>{DECISION_TEXT[f.reviewStatus] ?? f.reviewStatus}</span>
                <button className="plain sm" onClick={() => setChanging(f.id)}>
                  Change decision
                </button>
              </div>
            )}

            {editing === f.id ? (
              <div style={{ marginTop: 14 }}>
                <textarea
                  rows={3}
                  value={draft}
                  aria-label="Edited finding"
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="actions" style={{ marginTop: 10 }}>
                  <button
                    className="primary sm"
                    disabled={busy === f.id || draft.trim().length === 0}
                    onClick={() => act(f.id, "EDITED", draft.trim())}
                  >
                    Save edit
                  </button>
                  <button className="sm" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              showActions && (
                <div className="actions">
                  {f.reviewStatus !== "ACCEPTED" && (
                    <button
                      className="good sm"
                      disabled={busy === f.id}
                      onClick={() => act(f.id, "ACCEPTED")}
                    >
                      Accept
                    </button>
                  )}
                  <button
                    className="sm"
                    disabled={busy === f.id}
                    onClick={() => {
                      setEditing(f.id);
                      setDraft(f.editedText ?? f.summary);
                    }}
                  >
                    Edit
                  </button>
                  {f.reviewStatus !== "REJECTED" && (
                    <button
                      className="danger sm"
                      disabled={busy === f.id}
                      onClick={() => act(f.id, "REJECTED")}
                    >
                      Reject
                    </button>
                  )}
                  {decided && (
                    <button className="plain sm" onClick={() => setChanging(null)}>
                      Cancel
                    </button>
                  )}
                </div>
              )
            )}
            {error[f.id] && (
              <p role="alert" className="field-error">
                {error[f.id]}
              </p>
            )}
          </article>
        );
      })}
    </>
  );
}

interface OptionVM {
  id: string;
  label: string;
  rationale: string;
  proposedCreditCents: number | null;
  evidenceHash: string;
  stale: boolean;
  citationsParsed: Citation[];
}

export function ResolutionList({
  caseId,
  options,
  remainingCents,
}: {
  caseId: string;
  options: OptionVM[];
  /** how much more can be credited, per the engine (server-enforced too) */
  remainingCents: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, { msg: string; error?: boolean }>>({});

  if (options.length === 0)
    return (
      <Empty icon={<Creditcard size={22} />} title="No resolution options yet">
        The investigation proposes options once it has looked at the evidence.
      </Empty>
    );

  async function approve(opt: OptionVM) {
    if (opt.proposedCreditCents == null) return;
    setBusy(opt.id);
    try {
      // Key on the evidence snapshot + amount, not the option id: re-running the
      // investigation recreates options with new ids, but the same evidence and
      // amount is the same credit. (The server also caps total credits.)
      const key = `${caseId}:${opt.evidenceHash}:${opt.proposedCreditCents}`;
      const res = await req(`/api/cases/${caseId}/adjustments`, "POST", {
        amountCents: opt.proposedCreditCents,
        reason: opt.label,
        idempotencyKey: key,
        approvedBy: "reviewer",
      });
      setStatus((s) => ({
        ...s,
        [opt.id]: {
          msg: res.data.duplicate
            ? "Already approved — no duplicate credit created"
            : "Credit approved",
        },
      }));
      router.refresh();
    } catch (e) {
      setStatus((s) => ({
        ...s,
        [opt.id]: { msg: e instanceof Error ? e.message : "Approval failed", error: true },
      }));
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {options.map((o) => {
        const credit = o.proposedCreditCents;
        const exceeds = credit != null && credit > remainingCents;
        const st = status[o.id];
        return (
          <article key={o.id} className={"card" + (o.stale ? " stale" : "")}>
            <div className="row spread" style={{ alignItems: "flex-start" }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{o.label}</h3>
              <span className="row" style={{ gap: 6 }}>
                {o.stale && <StaleBadge />}
                {credit != null && <span className="option-amount">{formatCents(credit)}</span>}
              </span>
            </div>
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 14 }}>
              {o.rationale}
            </p>
            <Citations citations={o.citationsParsed} />
            {credit != null && (
              <div className="actions">
                <button
                  className="primary sm"
                  disabled={busy === o.id || exceeds || o.stale || (st && !st.error)}
                  onClick={() => approve(o)}
                  title={
                    o.stale
                      ? "Based on outdated evidence — re-run the investigation first"
                      : exceeds
                        ? `Only ${formatCents(remainingCents)} remains creditable`
                        : undefined
                  }
                >
                  {busy === o.id && <span className="spinner" aria-hidden="true" />}
                  Approve mock credit of {formatCents(credit)}
                </button>
                {!st && exceeds && (
                  <span className="muted small row" style={{ gap: 5 }}>
                    <Info size={14} />
                    {remainingCents === 0
                      ? "Overcharge already fully credited"
                      : `Exceeds remaining creditable ${formatCents(remainingCents)}`}
                  </span>
                )}
                {!st && !exceeds && o.stale && (
                  <span className="muted small">Re-run the investigation before approving</span>
                )}
                {st && (
                  <span
                    role={st.error ? "alert" : "status"}
                    className="small row"
                    style={{ gap: 5, color: st.error ? "var(--red)" : "var(--green)" }}
                  >
                    {st.error ? <Warning size={14} /> : <CheckCircle size={14} />}
                    {st.msg}
                  </span>
                )}
              </div>
            )}
          </article>
        );
      })}
    </>
  );
}

interface SupersededVM {
  id: string;
  type: string;
  summary: string;
  reviewStatus: string;
  editedText: string | null;
  supersededAt: string | Date | null;
}

/** Findings replaced by later investigations, kept as part of the history. */
export function SupersededFindings({ findings }: { findings: SupersededVM[] }) {
  const [open, setOpen] = useState(false);
  if (findings.length === 0) return null;
  return (
    <div className="disclosure">
      <button className="plain sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Show"} earlier findings ({findings.length})
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          {findings.map((f) => (
            <article key={f.id} className="card">
              <div className="row spread">
                <Pill map={FINDING_TYPE} value={f.type} data-type={f.type} />
                <span className="row" style={{ gap: 6 }}>
                  <span className="badge">Superseded</span>
                  <Pill map={REVIEW_STATUS} value={f.reviewStatus} />
                </span>
              </div>
              <p className="summary-text">{f.summary}</p>
              {f.editedText && (
                <p className="edit-note">
                  <span className="muted">Reviewer edit:</span> {f.editedText}
                </p>
              )}
              {f.supersededAt && (
                <p className="faint small" style={{ margin: "8px 0 0" }}>
                  Replaced <LocalTime iso={new Date(f.supersededAt).toISOString()} />
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
