import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCaseFull, getCreditStatus } from "@/lib/cases";
import { prisma } from "@/lib/db";
import { formatCents } from "@/lib/money";
import type { Citation, LineDiff } from "@/lib/types";
import { Calculator, ChevronLeft, Creditcard, Sparkles, Warning } from "../../icons";
import { Empty, StatusBadge } from "../../ui";
import { CaseActions } from "./actions";
import { EvidenceTabs } from "./evidence-tabs";
import { FindingList, ResolutionList, SupersededFindings } from "./findings";
import { History } from "./history";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const c = await prisma.case.findUnique({ where: { id }, select: { customerName: true } });
  return { title: c?.customerName ?? "Case not found" };
}

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const deltaClass = (cents: number) => (cents < 0 ? "delta-neg" : cents > 0 ? "delta-pos" : "");

export default async function CaseDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const c = await getCaseFull(id);
  if (!c) notFound();

  const latestRecalc = c.recalculations[0] ?? null;
  const lineDiffs: LineDiff[] = latestRecalc
    ? parse<LineDiff[]>(latestRecalc.lineDiffs, [])
    : [];

  const findings = c.findings.map((f) => ({
    ...f,
    citationsParsed: parse<Citation[]>(f.citations, []),
  }));
  const options = c.resolutionOptions.map((o) => ({
    ...o,
    citationsParsed: parse<Citation[]>(o.citations, []),
  }));

  const totalCredited = c.adjustments.reduce((s, a) => s + a.amountCents, 0);
  // Computed from the CURRENT evidence by the deterministic engine.
  const credit = await getCreditStatus(c.id);
  const anyStale =
    findings.some((f) => f.stale) || options.some((o) => o.stale);

  const pending = findings.filter((f) => f.reviewStatus === "PENDING").length;
  const resolveBlocker =
    findings.length === 0
      ? "run the AI investigation and review its findings."
      : anyStale
        ? "re-run the investigation (findings are based on earlier evidence)."
        : pending > 0
          ? `review all findings (${pending} pending).`
          : null;

  const lineItems = c.invoice?.lineItems ?? [];
  const billedCents = lineItems.reduce((s, li) => s + li.amountCents, 0);

  const evidenceTabs = [
    {
      id: "lines",
      label: "Line items",
      count: lineItems.length,
      content: (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ref</th>
                <th>Description</th>
                <th>Rule</th>
                <th className="right">Billed</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((li) => (
                <tr key={li.id}>
                  <td className="mono">{li.ref}</td>
                  <td>{li.description}</td>
                  <td className="mono muted">{li.ruleCode ?? "—"}</td>
                  <td className="right num">{formatCents(li.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ),
    },
    {
      id: "rules",
      label: "Pricing rules",
      count: c.pricingRules.length,
      content:
        c.pricingRules.length === 0 ? (
          <p className="muted small">No pricing rules supplied.</p>
        ) : (
          <div className="items">
            {c.pricingRules.map((r) => (
              <div key={r.id} className="item">
                <div>
                  <span className="mono">{r.code}</span>
                  <div className="desc">{r.description}</div>
                </div>
                <span className="badge">{r.kind.replace("_", " ").toLowerCase()}</span>
              </div>
            ))}
          </div>
        ),
    },
    {
      id: "usage",
      label: "Usage",
      count: c.usageEvents.length,
      content:
        c.usageEvents.length === 0 ? (
          <p className="muted small">No usage events supplied.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Type</th>
                  <th className="right">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {c.usageEvents.map((u) => (
                  <tr key={u.id}>
                    <td className="mono">{u.ref}</td>
                    <td>{u.type}</td>
                    <td className="right num">{u.quantity.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
    },
    {
      id: "payments",
      label: "Payments",
      count: c.payments.length,
      content:
        c.payments.length === 0 ? (
          <p className="muted small">No payments or prior adjustments on record.</p>
        ) : (
          <div className="items">
            {c.payments.map((p) => (
              <div key={p.id} className="item">
                <div>
                  <span className="mono">{p.ref}</span>{" "}
                  <span className="badge">{p.kind.toLowerCase()}</span>
                  <div className="desc">{p.reason}</div>
                </div>
                <span className="num">{formatCents(p.amountCents)}</span>
              </div>
            ))}
          </div>
        ),
    },
  ];

  const delta = latestRecalc?.deltaCents ?? null;

  return (
    <main className="container">
      <Link href="/" className="eyebrow">
        <ChevronLeft size={18} /> Cases
      </Link>

      <div className="page-head">
        <div>
          <div className="row" style={{ gap: 12 }}>
            <h1 className="large-title">{c.customerName}</h1>
            <StatusBadge status={c.status} large />
          </div>
          <p className="subtitle">
            <span className="mono">{c.customerId}</span> · Invoice{" "}
            <span className="mono">{c.invoice?.number}</span>
            {c.invoice?.currency ? ` · ${c.invoice.currency}` : ""}
          </p>
        </div>
      </div>

      <section className="metrics" aria-label="Summary">
        <div className="metric">
          <div className="label">Billed</div>
          <div className="value">{formatCents(billedCents)}</div>
          <div className="hint">
            {lineItems.length} line item{lineItems.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="metric">
          <div className="label">Recalculated</div>
          <div className="value">
            {latestRecalc ? formatCents(latestRecalc.recalcTotalCents) : "—"}
          </div>
          <div className="hint">
            {!latestRecalc
              ? "Not run yet"
              : c.latestRecalculationStale
                ? "From earlier evidence"
                : "Deterministic engine"}
          </div>
        </div>
        <div className="metric">
          <div className="label">Difference</div>
          <div className={"value " + (delta == null ? "" : deltaClass(delta))}>
            {delta == null ? "—" : formatCents(delta)}
          </div>
          <div className="hint">
            {delta == null
              ? "Recalculate to compare"
              : delta < 0
                ? "Customer overcharged"
                : delta > 0
                  ? "Customer undercharged"
                  : "Matches the invoice"}
          </div>
        </div>
        <div className="metric">
          <div className="label">Creditable</div>
          <div className="value">{formatCents(credit.remainingCents)}</div>
          <div className="hint">{formatCents(totalCredited)} approved so far</div>
        </div>
      </section>

      <div className="stack" style={{ marginBottom: 20 }}>
        <CaseActions caseId={c.id} status={c.status} resolveBlocker={resolveBlocker} />
        {anyStale && (
          <div className="banner warn">
            <Warning size={18} />
            <div>
              New evidence was added after some conclusions were drawn. Findings marked{" "}
              <strong>stale</strong> below were based on earlier evidence — re-run the
              investigation to refresh them.
            </div>
          </div>
        )}
      </div>

      <div className="layout">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Customer dispute</h2>
            </div>
            <p className="quote">{c.disputeDescription}</p>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Evidence</h2>
              <span className="caption">Read-only inputs to the engine and the agent</span>
            </div>
            <EvidenceTabs tabs={evidenceTabs} />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Original vs. recalculated</h2>
              <span className="caption">Deterministic engine · integer cents</span>
            </div>
            {!latestRecalc && (
              <Empty icon={<Calculator size={22} />} title="Not recalculated yet">
                Use <strong>Recalculate</strong> to run the pricing engine over the evidence.
              </Empty>
            )}
            {latestRecalc && c.latestRecalculationStale && (
              <div className="banner warn" style={{ marginBottom: 14 }}>
                <Warning size={18} />
                <div>
                  These figures were computed from earlier evidence. Click{" "}
                  <strong>Recalculate</strong> to update them for the current evidence.
                </div>
              </div>
            )}
            {latestRecalc && (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Ref</th>
                        <th>Description</th>
                        <th className="right">Billed</th>
                        <th className="right">Expected</th>
                        <th className="right">Delta</th>
                        <th>How</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineDiffs.map((d) => (
                        <tr key={d.ref}>
                          <td className="mono">{d.ref}</td>
                          <td>{d.description}</td>
                          <td className="right num">{formatCents(d.originalCents)}</td>
                          <td className="right num">{formatCents(d.expectedCents)}</td>
                          <td className={"right num " + deltaClass(d.deltaCents)}>
                            {formatCents(d.deltaCents)}
                          </td>
                          <td className="how">
                            {d.status === "unverifiable" && (
                              <span className="badge warn" style={{ marginRight: 6 }}>
                                Unverifiable
                              </span>
                            )}
                            {d.explanation}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2}>Total</td>
                        <td className="right num">{formatCents(latestRecalc.originalTotalCents)}</td>
                        <td className="right num">{formatCents(latestRecalc.recalcTotalCents)}</td>
                        <td className={"right num " + deltaClass(latestRecalc.deltaCents)}>
                          {formatCents(latestRecalc.deltaCents)}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="faint small" style={{ margin: "12px 0 0" }}>
                  A negative delta means the customer was overcharged. Evidence snapshot{" "}
                  <span className="mono" title={latestRecalc.evidenceHash}>
                    {latestRecalc.evidenceHash.slice(0, 12)}
                  </span>
                </p>
              </>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Agent findings</h2>
              {findings.length > 0 && (
                <span className="caption">
                  {pending === 0 ? "All reviewed" : `${pending} awaiting review`}
                </span>
              )}
            </div>
            {findings.length === 0 ? (
              <Empty icon={<Sparkles size={22} />} title="No findings yet">
                Run the AI investigation to get evidence-grounded findings.
              </Empty>
            ) : (
              <FindingList findings={findings} />
            )}
            <SupersededFindings findings={c.supersededFindings} />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Resolution options</h2>
              <span className="caption">Credits are capped by the engine</span>
            </div>
            <ResolutionList caseId={c.id} options={options} remainingCents={credit.remainingCents} />
          </section>
        </div>

        <aside className="rail">
          <section className="panel">
            <div className="panel-head">
              <h2>Credits</h2>
              <span className="caption">Mock only — no money moves</span>
            </div>
            <div className="kv-grid">
              <div className="kv">
                <span className="label">Owed (engine)</span>
                <span className="value">{formatCents(credit.owedCents)}</span>
              </div>
              <div className="kv">
                <span className="label">Approved</span>
                <span className="value">{formatCents(credit.approvedCents)}</span>
              </div>
              <div className="kv">
                <span className="label">Remaining</span>
                <span className="value">{formatCents(credit.remainingCents)}</span>
              </div>
              <div className="kv">
                <span className="label">Earlier credits</span>
                <span className="value">{formatCents(credit.historyCreditCents)}</span>
              </div>
            </div>
            {credit.overCredited && (
              <div className="banner bad" style={{ marginBottom: 12 }}>
                <Warning size={18} />
                <div>
                  Credits already approved exceed what the engine now says is owed (
                  {formatCents(credit.owedCents)}), likely because evidence changed after
                  approval. Review whether a reversal is needed.
                </div>
              </div>
            )}
            {c.adjustments.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                No credits approved yet.
              </p>
            ) : (
              <div className="items">
                {c.adjustments.map((a) => (
                  <div key={a.id} className="item">
                    <div style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 6 }}>
                        <Creditcard size={14} className="faint" />
                        <span>{a.reason}</span>
                      </div>
                      <div className="desc mono" style={{ fontSize: 11.5, overflowWrap: "anywhere" }} title="Idempotency key">
                        {a.idempotencyKey}
                      </div>
                    </div>
                    <span className="num" style={{ fontWeight: 600 }}>
                      {formatCents(a.amountCents)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Activity</h2>
              <span className="caption">Append-only</span>
            </div>
            <History logs={c.decisionLogs} />
          </section>
        </aside>
      </div>
    </main>
  );
}
