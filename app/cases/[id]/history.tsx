// Human-readable rendering of the append-only decision log. The raw payload
// stays available on hover (title) for auditing.
import type { ReactNode } from "react";
import { formatCents } from "@/lib/money";
import {
  Calculator,
  CheckCircle,
  Creditcard,
  Doc,
  Lock,
  Pencil,
  Plus,
  Sparkles,
  Undo,
  Warning,
} from "../../icons";
import { REVIEW_STATUS } from "../../ui";
import { LocalTime } from "../../local-time";

interface LogEntry {
  id: string;
  action: string;
  actor: string;
  payload: string;
  createdAt: Date | string;
}

type P = Record<string, unknown>;

const num = (v: unknown) => (typeof v === "number" ? v : 0);
const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : []);
const reviewLabel = (v: unknown) => REVIEW_STATUS[String(v)]?.label ?? String(v);

function describe(action: string, p: P): { title: string; detail?: string; tone: string; icon: ReactNode } {
  switch (action) {
    case "case.created":
      return { title: "Case opened", detail: p.customer ? `Dispute from ${p.customer}` : undefined, tone: "accent", icon: <Doc size={14} /> };
    case "recalculation.ran": {
      const d = num(p.deltaCents);
      return {
        title: "Invoice recalculated",
        detail: d < 0 ? `Overcharged by ${formatCents(-d)}` : d > 0 ? `Undercharged by ${formatCents(d)}` : "Matches the invoice",
        tone: "",
        icon: <Calculator size={14} />,
      };
    }
    case "investigation.ran": {
      const failures = list(p.toolFailures);
      const parts = [`${num(p.findingCount)} finding${num(p.findingCount) === 1 ? "" : "s"} via ${p.provider ?? "agent"}`];
      if (failures.length) parts.push(`tools unavailable: ${failures.join(", ")}`);
      if (list(p.droppedCitations).length) parts.push(`${list(p.droppedCitations).length} invalid citation(s) dropped`);
      if (p.evidenceChangedMidRun) parts.push("evidence changed during the run");
      return { title: "AI investigation", detail: parts.join(" · "), tone: "purple", icon: <Sparkles size={14} /> };
    }
    case "finding.reviewed":
      return {
        title: `Finding ${reviewLabel(p.to).toLowerCase()}`,
        detail:
          `${reviewLabel(p.from)} → ${reviewLabel(p.to)}` +
          (typeof p.editedText === "string" ? ` · “${p.editedText}”` : ""),
        tone: p.to === "REJECTED" ? "bad" : "good",
        icon: p.to === "EDITED" ? <Pencil size={14} /> : <CheckCircle size={14} />,
      };
    case "adjustment.approved":
      return {
        title: `Credit of ${formatCents(num(p.amountCents))} approved`,
        detail: `${formatCents(num(p.remainingAfterCents))} still creditable`,
        tone: "good",
        icon: <Creditcard size={14} />,
      };
    case "adjustment.blocked":
      return {
        title: `Credit of ${formatCents(num(p.amountCents))} blocked`,
        detail: typeof p.reason === "string" ? p.reason : undefined,
        tone: "bad",
        icon: <Warning size={14} />,
      };
    case "evidence.added": {
      const added = (p.added ?? {}) as Record<string, unknown>;
      const refs = [...list(added.rules), ...list(added.usage), ...list(added.payments), ...list(p.updatedRules)];
      const parts = [refs.length ? `Added ${refs.join(", ")}` : "No new items"];
      if (typeof p.note === "string" && p.note) parts.push(`“${p.note}”`);
      return { title: "Evidence added", detail: parts.join(" · "), tone: "warn", icon: <Plus size={14} /> };
    }
    case "case.resolved":
      return {
        title: "Case resolved",
        detail: `${formatCents(num(p.creditedCents))} credited` + (typeof p.note === "string" && p.note ? ` · “${p.note}”` : ""),
        tone: "good",
        icon: <Lock size={14} />,
      };
    case "case.reopened":
      return { title: "Case reopened", detail: typeof p.reason === "string" ? p.reason : undefined, tone: "warn", icon: <Undo size={14} /> };
    default:
      return { title: action, tone: "", icon: <Doc size={14} /> };
  }
}

export function History({ logs }: { logs: LogEntry[] }) {
  return (
    <ol className="timeline">
      {logs.map((l) => {
        let payload: P = {};
        try {
          payload = JSON.parse(l.payload) as P;
        } catch {
          /* keep empty */
        }
        const d = describe(l.action, payload);
        return (
          <li key={l.id} data-action={l.action} title={`${l.action} ${l.payload}`}>
            <span className={`ico ${d.tone}`}>{d.icon}</span>
            <div>
              <div className="what">{d.title}</div>
              {d.detail && <div className="detail">{d.detail}</div>}
              <div className="when">
                <LocalTime iso={new Date(l.createdAt).toISOString()} /> · {l.actor}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
