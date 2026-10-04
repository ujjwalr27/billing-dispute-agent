// Presentation helpers shared by server and client components (no hooks).
import type { ReactNode } from "react";
import type { Citation } from "@/lib/types";

export const CASE_STATUS: Record<string, { label: string; tone: string }> = {
  OPEN: { label: "Open", tone: "" },
  IN_REVIEW: { label: "In review", tone: "accent" },
  RESOLVED: { label: "Resolved", tone: "good" },
  REOPENED: { label: "Reopened", tone: "warn" },
};

export function StatusBadge({ status, large }: { status: string; large?: boolean }) {
  const s = CASE_STATUS[status] ?? { label: status, tone: "" };
  return (
    <span
      className={`badge dot ${s.tone}${large ? " lg" : ""}`}
      data-testid="case-status"
      data-status={status}
    >
      {s.label}
    </span>
  );
}

export const FINDING_TYPE: Record<string, { label: string; tone: string }> = {
  CALC_ERROR: { label: "Calculation error", tone: "bad" },
  CONTRACT_AMBIGUITY: { label: "Contract ambiguity", tone: "warn" },
  MISSING_EVIDENCE: { label: "Missing evidence", tone: "purple" },
};

export const REVIEW_STATUS: Record<string, { label: string; tone: string }> = {
  PENDING: { label: "Needs review", tone: "" },
  ACCEPTED: { label: "Accepted", tone: "good" },
  EDITED: { label: "Edited", tone: "accent" },
  REJECTED: { label: "Rejected", tone: "bad" },
};

export function Pill({
  map,
  value,
  ...rest
}: {
  map: Record<string, { label: string; tone: string }>;
  value: string;
} & Record<`data-${string}`, string>) {
  const v = map[value] ?? { label: value, tone: "" };
  return (
    <span className={`badge ${v.tone}`} {...rest}>
      {v.label}
    </span>
  );
}

const KIND_LABEL: Record<string, string> = {
  invoice: "Invoice",
  rule: "Rule",
  usage: "Usage",
  payment: "Payment",
};

export function Citations({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return <p className="faint small" style={{ margin: "10px 0 0" }}>No citations</p>;
  return (
    <div className="citations" aria-label="Cited evidence">
      {citations.map((c, i) => (
        <span
          key={i}
          className="citation"
          title={c.note ?? undefined}
          data-cite={`${c.kind}:${c.ref}`}
        >
          <span className={`kind ${c.kind}`}>{KIND_LABEL[c.kind] ?? c.kind}</span>
          <span className="ref">{c.ref}</span>
        </span>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon">{icon}</div>
      <p className="title">{title}</p>
      {children && <p>{children}</p>}
    </div>
  );
}

const AVATAR_COLORS = ["#0a84ff", "#5e5ce6", "#ff9f0a", "#30b0c7", "#ff375f", "#34c759", "#af52de"];

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className="avatar" style={{ background: AVATAR_COLORS[h % AVATAR_COLORS.length] }} aria-hidden="true">
      {initials || "?"}
    </span>
  );
}
