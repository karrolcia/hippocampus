/**
 * Timestamp handling at the DB storage boundary.
 *
 * Every `created_at` / `updated_at` in this schema is written by SQLite's
 * `datetime('now')`, which produces `YYYY-MM-DD HH:MM:SS` **in UTC**: a space
 * separator, second resolution, no zone marker. Two consequences drive this
 * module, and both of them fail toward absence, which is the dangerous
 * direction for a memory server.
 *
 * 1. Those columns are TEXT, so `created_at >= ?` is a **lexicographic**
 *    comparison, not a temporal one — correct only when the bound is in the
 *    identical stored form. ISO-8601's `T` separator is ASCII 0x54, above the
 *    space (0x20) and above every digit (0x30–0x39), so a `T`-separated bound
 *    sorts above every stored row and filters out the whole table. Measured:
 *    `since: "2026-08-25"` returned 37 results, `since: "2026-08-25T00:00:00"`
 *    returned 0 — with `success: true` and no error, on the exact spelling the
 *    tool's own schema documented. Every scheduled agent that sweeps "what
 *    landed since my last run" read that as "nothing happened" (D13).
 *
 * 2. `new Date('2026-08-25 10:36:55')` and `new Date('2026-08-25T10:36:55')`
 *    are both parsed as **local** time — per ES2015+ a date-time form without
 *    a zone designator is local, and only a date-only form is UTC. Reading a
 *    stored timestamp that way shifts it by the host's UTC offset, so an age
 *    computation silently depends on where the process happens to run (the
 *    container is UTC; a laptop in Helsinki is +3).
 *
 * So: `normalizeSinceBound` for any date a caller supplies, and
 * `parseStoredTimestamp` for any timestamp read back out. Neither hands a
 * zone-less string to a bare `new Date()`.
 */

/** `YYYY-MM-DD` — a whole calendar day, no time part. */
const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})$/;

/**
 * `YYYY-MM-DD`, a `T`-or-space separator, `HH:MM[:SS][.fff]`, optional zone.
 * The zone group decides which branch runs below: absent means a wall-clock
 * time that is UTC by this schema's contract, present means a real instant
 * that has to be converted to UTC. Lowercase `t`/`z` are accepted for the same
 * reason `param-normalization.ts` accepts aliases — leniency inbound, one
 * canonical form out. RFC 3339 permits them explicitly.
 */
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|z|[+-]\d{2}:?\d{2})?$/;

/**
 * The stored form, exactly. Every value this module hands back must match it —
 * `Date` widens to an expanded year (`+010000-01-01`) outside 0000-9999, and
 * such a string sorts BELOW every stored row, so it would match everything
 * rather than erroring. Same class of bug as the one this module removes, with
 * the sign flipped.
 */
const STORED_FORM = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** A zone suffix on an already-ISO string: `Z`, `+03:00`, `-0500`. */
const HAS_ZONE = /(?:Z|z|[+-]\d{2}:?\d{2})$/;

/**
 * The echoed value is a date, not memory content, so quoting it back is a
 * debugging aid rather than a leak — but the field accepts an arbitrary string
 * and the error must not become an unbounded one.
 */
const MAX_ECHO = 40;

function sinceError(raw: string): Error {
  const echo = raw.length > MAX_ECHO ? `${raw.slice(0, MAX_ECHO)}…` : raw;
  return new Error(
    `Invalid "since" value: "${echo}". Expected a UTC date or datetime — ` +
      `"YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS", or ISO-8601 with a zone ` +
      `("2026-08-25T10:36:55Z", "2026-08-25T13:36:55+03:00"). ` +
      `Rejected rather than returned as an empty result set.`
  );
}

/** `Z`/`z` stay `Z`; `+0300` becomes `+03:00` (Date only parses the colon form). */
function normalizeZone(zone: string): string {
  if (zone === 'Z' || zone === 'z') return 'Z';
  return zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
}

/** `Date` → the stored `YYYY-MM-DD HH:MM:SS` UTC form. */
function toStoredForm(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Matching the format is not enough. `2026-13-01` and `2026-02-30` are
 * well-shaped and meaningless, and either would produce a bound that lexically
 * exceeds every stored row — the silent zero reborn one layer in. Round-trip
 * through `Date` (explicitly UTC) and require every component to survive.
 */
function assertRealInstant(stored: string, raw: string): string {
  const ms = new Date(`${stored.replace(' ', 'T')}Z`).getTime();
  if (Number.isNaN(ms)) throw sinceError(raw);
  if (toStoredForm(ms) !== stored) throw sinceError(raw);
  return stored;
}

/**
 * Convert a caller-supplied `since` bound into the stored UTC form
 * `YYYY-MM-DD HH:MM:SS`, so that a lexicographic `created_at >= ?` is a
 * temporal comparison.
 *
 * Accepts `YYYY-MM-DD`, `YYYY-MM-DD HH:MM[:SS]`, the same with a `T`
 * separator, and full ISO-8601 with `Z` or a `±HH:MM` / `±HHMM` offset.
 * Offsets are **converted**, not stripped: `2026-08-25T13:36:55+03:00` is
 * `2026-08-25 10:36:55`, not `13:36:55`.
 *
 * @throws if the value is not a real instant. A bad bound must surface as an
 * error — returning nothing is indistinguishable from "nothing was stored",
 * which is the failure this function exists to remove.
 */
export function normalizeSinceBound(input: string): string {
  const raw = input.trim();

  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly) return assertRealInstant(`${dateOnly[1]} 00:00:00`, raw);

  const parts = DATE_TIME.exec(raw);
  if (!parts) throw sinceError(raw);

  const [, date, hhmm, ss, zone] = parts;
  const seconds = ss === undefined ? ':00' : `:${ss}`;

  // No zone: UTC by this schema's contract, so this is pure string surgery.
  // Routing it through `new Date()` would re-introduce the local-parse shift.
  if (!zone) return assertRealInstant(`${date} ${hhmm}${seconds}`, raw);

  const ms = new Date(`${date}T${hhmm}${seconds}${normalizeZone(zone)}`).getTime();
  if (Number.isNaN(ms)) throw sinceError(raw);

  // Fractional seconds are truncated to the stored second resolution. On an
  // inclusive lower bound that can only widen the window by under a second —
  // it errs toward returning an extra row, never toward hiding one.
  const stored = toStoredForm(ms);

  // The zone-less branch validates by round-trip; this one cannot (the value is
  // deliberately not what came in), so it checks the shape instead. An offset
  // that pushes the instant outside 0000-9999 lands here, not in the database.
  if (!STORED_FORM.test(stored)) throw sinceError(raw);
  return stored;
}

/**
 * Read a stored timestamp as the UTC instant it is.
 *
 * `new Date(value)` would read the zone-less stored form as local time, making
 * every age computation depend on the host's UTC offset. Returns NaN for an
 * unparseable value, matching `Date.prototype.getTime`.
 */
export function parseStoredTimestamp(value: string): number {
  const iso = value.trim().replace(' ', 'T');
  // Tolerate a value that already carries a zone — an ISO string from an older
  // write path is still a valid instant, and only a bare one needs the marker.
  return new Date(HAS_ZONE.test(iso) ? iso : `${iso}Z`).getTime();
}
