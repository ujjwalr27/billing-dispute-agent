"use client";

import { useEffect, useState } from "react";

const fmt = (iso: string, timeZone?: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));

/** Renders a timestamp in the viewer's time zone (UTC until hydrated). */
export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState(() => fmt(iso, "UTC") + " UTC");
  useEffect(() => setText(fmt(iso)), [iso]);
  return <time dateTime={iso}>{text}</time>;
}
