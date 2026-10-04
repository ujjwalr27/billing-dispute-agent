import Link from "next/link";
import { prisma } from "@/lib/db";
import { ChevronRight, Tray } from "./icons";
import { NewSampleCase } from "./new-sample";
import { Avatar, CASE_STATUS, Empty, StatusBadge } from "./ui";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cases = await prisma.case.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      invoice: { select: { number: true } },
      _count: { select: { findings: { where: { supersededAt: null } }, adjustments: true } },
    },
  });

  const counts = Object.keys(CASE_STATUS).map((s) => ({
    status: s,
    n: cases.filter((c) => c.status === s).length,
  }));

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1 className="large-title">Dispute cases</h1>
          <p className="subtitle">
            Every invoice is recomputed by deterministic code, then an AI agent explains the
            dispute with cited evidence. You review and decide.
          </p>
        </div>
        <NewSampleCase />
      </div>

      {cases.length > 0 && (
        <div className="summary" aria-label="Cases by status">
          {counts.map(({ status, n }) => (
            <span key={status} className="chip">
              <strong>{n}</strong> {CASE_STATUS[status]!.label}
            </span>
          ))}
        </div>
      )}

      {cases.length === 0 ? (
        <div className="list">
          <Empty icon={<Tray size={22} />} title="No cases yet">
            Create a sample case above, or seed the demo data with{" "}
            <span className="mono">npm run seed</span>.
          </Empty>
        </div>
      ) : (
        <nav className="list" aria-label="Cases">
          {cases.map((c) => (
            <Link key={c.id} href={`/cases/${c.id}`} className="list-row">
              <Avatar name={c.customerName} />
              <div className="main">
                <div className="row" style={{ gap: 10 }}>
                  <span className="title">{c.customerName}</span>
                  <StatusBadge status={c.status} />
                </div>
                <div className="meta">
                  <span className="mono">{c.invoice?.number ?? "—"}</span> · {c.disputeDescription}
                </div>
              </div>
              <div className="side">
                <div className="counts">
                  <div>
                    {c._count.findings} {c._count.findings === 1 ? "finding" : "findings"}
                  </div>
                  <div>
                    {c._count.adjustments} {c._count.adjustments === 1 ? "credit" : "credits"}
                  </div>
                </div>
                <ChevronRight className="chev" size={18} />
              </div>
            </Link>
          ))}
        </nav>
      )}
    </main>
  );
}
