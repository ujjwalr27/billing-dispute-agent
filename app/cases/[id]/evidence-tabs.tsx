"use client";

import { useId, useState, type ReactNode } from "react";

interface Tab {
  id: string;
  label: string;
  count: number;
  content: ReactNode;
}

/**
 * Segmented control over pre-rendered evidence panes. Inactive panes stay in
 * the DOM (hidden) so the page's content is complete for search and tests.
 */
export function EvidenceTabs({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  const base = useId();
  return (
    <>
      <div className="segmented" role="tablist" aria-label="Evidence">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={active === t.id}
            aria-controls={`${base}-pane-${t.id}`}
            onClick={() => setActive(t.id)}
          >
            {t.label} <span className="count">{t.count}</span>
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-pane-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={active !== t.id}
          style={{ marginTop: 14 }}
        >
          {t.content}
        </div>
      ))}
    </>
  );
}
