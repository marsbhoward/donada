// =============================================================================
// draw_date_loader.ts
// =============================================================================
// Shared utility imported by both create_listing.ts and draw_script.ts.
// Responsible for reading the draw date CSV, parsing dates and times, and
// returning the nearest upcoming draw date in the formats each script needs.
//
// CSV format expected:
//   Label,date,time
//   next_draw_date,2026-02-15,06:00PM
//   next_draw_date,2026-03-15,06:00PM
//
// Rules:
//   - Only rows where Label === "next_draw_date" are considered.
//   - Only future dates (relative to now) are eligible.
//   - The nearest upcoming date is always selected.
//   - If no future dates remain the function throws, prompting Donada to
//     update the CSV before the next round can proceed.
// =============================================================================

import { readFileSync } from "fs";
import { join } from "path";

const DEFAULT_CSV_PATH = join(__dirname, "..", "public", "data", "drawDates.csv");

// ── Types ────────────────────────────────────────────────────────────────────

/** One row from the draw date CSV. Column names match the CSV header exactly. */
interface DrawDateRow {
  Label: string; // expected value: "next_draw_date"
  date: string;  // format: "YYYY-MM-DD"
  time: string;  // format: "HH:MMAM" or "HH:MMPM"  e.g. "06:00PM"
}

/** The resolved draw date returned to callers. */
export interface ResolvedDrawDate {
  date: Date;           // native JS Date object (local time)
  posixSeconds: number; // Unix timestamp in seconds
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Parses a single CSV row into a JS Date.
 * Combines the "date" and "time" columns into one string before parsing so
 * that the JS Date constructor can handle both in one pass.
 *
 * Throws a descriptive error if the combined string is not a valid date,
 * so misconfigured CSV rows surface immediately rather than silently
 * producing NaN-based timestamps.
 */
function parseDrawDateRow(row: DrawDateRow): Date {
  // e.g. "2026-02-15 06:00PM"
  const combined = `${row.date} ${row.time}`;
  const parsed = new Date(combined);

  if (isNaN(parsed.getTime())) {
    throw new Error(
      `draw_date_loader: Could not parse draw date from CSV row.\n` +
      `  Label : "${row.Label}"\n` +
      `  date  : "${row.date}"\n` +
      `  time  : "${row.time}"\n` +
      `  Combined string passed to Date(): "${combined}"\n` +
      `  Check that date is YYYY-MM-DD and time is HH:MMAM/PM.`
    );
  }

  return parsed;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Reads the draw date CSV at `csvPath` and returns the nearest upcoming
 * draw date as both a JS Date and a Unix timestamp in seconds.
 *
 * Steps:
 *   1. Read and parse the CSV file.
 *   2. Filter to rows labelled "next_draw_date".
 *   3. Parse each row into a JS Date.
 *   4. Discard any dates that are already in the past.
 *   5. Sort the remaining dates ascending and return the first (nearest).
 *
 * Throws if:
 *   - The file cannot be read.
 *   - Any "next_draw_date" row contains an unparseable date/time.
 *   - No future draw dates remain (CSV needs updating).
 */
export function loadNextDrawDate(csvPath: string = DEFAULT_CSV_PATH): ResolvedDrawDate {
  // 1. Read file
  let raw: string;
  try {
    raw = readFileSync(csvPath, "utf-8");
  } catch (err) {
    throw new Error(
      `draw_date_loader: Could not read draw date CSV at "${csvPath}".\n` +
      `  Ensure the file exists and the path is correct.\n` +
      `  Original error: ${(err as Error).message}`
    );
  }

  // 2. Parse CSV manually — split on newlines, skip header, map to row objects
  const [header, ...lines] = raw.split(/\r?\n/).filter(l => l.trim() !== "");
  const keys = header.split(",").map(k => k.trim()) as (keyof DrawDateRow)[];
  const rows: DrawDateRow[] = lines.map(line => {
    const values = line.split(",").map(v => v.trim());
    return keys.reduce((obj, key, i) => {
      obj[key] = values[i] ?? "";
      return obj;
    }, {} as DrawDateRow);
  });

  const now = new Date();

  // 3 & 4. Parse, filter to future dates only, sort ascending
  const futureDates = rows
    .filter(row => row.Label === "next_draw_date")
    .map(row => parseDrawDateRow(row))   // throws on bad format
    .filter(date => date > now)
    .sort((a, b) => a.getTime() - b.getTime());

  // 5. Guard: no future dates left
  if (futureDates.length === 0) {
    throw new Error(
      `draw_date_loader: No upcoming draw dates found in "${csvPath}".\n` +
      `  All "next_draw_date" rows are either in the past or missing.\n` +
      `  Please add a future date to the CSV before running again.`
    );
  }

  // Return the nearest upcoming date
  const next = futureDates[0];

  return {
    date: next,
    posixSeconds: Math.floor(next.getTime() / 1000),
  };
}

/**
 * Converts a Unix timestamp in seconds to Cardano POSIX time in milliseconds.
 * Cardano's on-chain time checks use milliseconds, so all draw_date datum
 * values must go through this conversion before being submitted on-chain.
 */
export function toCardanoPosix(posixSeconds: number): bigint {
  return BigInt(posixSeconds) * 1000n;
}
