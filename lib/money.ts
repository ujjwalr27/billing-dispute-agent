import Decimal from "decimal.js";

/**
 * Money is represented everywhere as an integer number of cents. Rule math that
 * needs fractional intermediate values uses decimal.js (never JS floats), and
 * the result is rounded to whole cents with banker's rounding at the boundary.
 *
 * This module is the ONLY place rounding happens, so the rule is auditable.
 */

Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN });

/** Multiply a cents amount by a quantity/factor, returning whole cents. */
export function scaleCents(cents: number, factor: number | string): number {
  return new Decimal(cents).times(factor).toDecimalPlaces(0).toNumber();
}

/** Sum a list of whole-cent amounts. */
export function sumCents(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/** Format whole cents as a display string, e.g. 12345 -> "$123.45". */
export function formatCents(cents: number, currency = "USD"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = (abs % 100).toString().padStart(2, "0");
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${sign}${symbol}${dollars.toLocaleString("en-US")}.${remainder}`;
}

/** Convert a dollars value (number or string) to whole cents. */
export function toCents(dollars: number | string): number {
  return new Decimal(dollars).times(100).toDecimalPlaces(0).toNumber();
}

/** Largest value a money column (PostgreSQL INTEGER) can store. */
export const MAX_STORABLE_CENTS = 2_147_483_647;

/** True when a cents value fits the database's 32-bit money columns. */
export function isStorableCents(cents: number): boolean {
  return Number.isSafeInteger(cents) && Math.abs(cents) <= MAX_STORABLE_CENTS;
}

/**
 * Split a whole-cent total across weights so the parts are whole cents and sum
 * EXACTLY to the total (largest-remainder method, ties broken by position).
 * Zero/negative total weight splits evenly.
 */
export function allocateCents(totalCents: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const w = weights.map((x) => (x > 0 ? new Decimal(x) : new Decimal(0)));
  let sumW = w.reduce((a, b) => a.plus(b), new Decimal(0));
  const effective = sumW.isZero() ? w.map(() => new Decimal(1)) : w;
  if (sumW.isZero()) sumW = new Decimal(weights.length);

  const exact = effective.map((x) => new Decimal(totalCents).times(x).dividedBy(sumW));
  const parts = exact.map((x) => x.floor().toNumber());
  let remainder = totalCents - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x.minus(x.floor()) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) {
    parts[order[k].i] += 1;
  }
  return parts;
}
