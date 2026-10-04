"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Warning } from "./icons";

const SAMPLES = [
  { id: "calcError", label: "Calculation error" },
  { id: "ambiguity", label: "Contract ambiguity" },
  { id: "missingEvidence", label: "Missing evidence" },
] as const;

/** Create a fresh copy of a demo dispute and open it. */
export function NewSampleCase() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function create(scenario: string) {
    setBusy(scenario);
    setErr(null);
    try {
      const res = await fetch("/api/samples", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      router.push(`/cases/${json.data.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create the case");
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="row" role="group" aria-label="New sample case">
        <span className="muted small">New sample case:</span>
        {SAMPLES.map((s) => (
          <button key={s.id} className="sm" disabled={busy !== null} onClick={() => create(s.id)}>
            {busy === s.id ? <span className="spinner" aria-hidden="true" /> : <Plus size={14} />}
            {s.label}
          </button>
        ))}
      </div>
      {err && (
        <p role="alert" className="field-error row" style={{ gap: 6 }}>
          <Warning size={14} /> {err}
        </p>
      )}
    </div>
  );
}
