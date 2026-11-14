// Comparing texts the way Multica stores them.

import { structuredPatch } from "diff";

/** Text that ends in exactly one newline, so a stored copy and a file compare alike. */
export const norm = (text: string | null | undefined): string =>
  `${(text ?? "").replace(/\n*$/, "")}\n`;

export interface TextDiff {
  /** The number of lines that differ: a changed line counts once. */
  lines: number;
  /** The unified diff, from `live` to `setup`, without its file headers. */
  diff: string;
}

/** How `live` differs from `setup`, compared as they are. */
export const textDiff = (live: string, setup: string): TextDiff => {
  if (live === setup) return { lines: 0, diff: "" };
  const patch = structuredPatch("live", "setup", live, setup, "", "", { context: 3 });
  let added = 0;
  let removed = 0;
  const out: string[] = [];
  for (const hunk of patch.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
      out.push(line);
    }
  }
  return { lines: Math.max(added, removed), diff: out.join("\n") };
};

/** "1 line differs", "3 lines differ". */
export const differ = (lines: number): string =>
  `${lines} ${lines === 1 ? "line differs" : "lines differ"}`;

/** A value, cut to 70 characters for one line of output. */
export const preview = (text: string): string =>
  text.length > 70 ? `${text.slice(0, 70)}…` : text;

/** Code points, as Multica counts them. */
export const length = (text: string): number => Array.from(text).length;
