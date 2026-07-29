/**
 * Compact line diff for write/patch approval previews (COW-2460).
 *
 * When the agent proposes a `local_write_file` / `local_patch_file`, the
 * approval prompt renders a before→after diff so the user sees exactly what
 * changes before approving — not just the new content. Pure and bounded: the
 * LCS is computed over at most `MAX_INPUT_LINES` per side (a preview needn't
 * diff a whole huge file), output is capped and long unchanged runs collapse.
 */

/** Per-side line budget for the LCS (keeps the DP small and the preview quick). */
const MAX_INPUT_LINES = 800;
/** Cap on rendered diff lines. */
const MAX_OUTPUT_LINES = 200;
/** Context lines kept around each change; larger unchanged runs collapse. */
const CONTEXT = 3;
/** Any rendered line is clamped to this width. */
const LINE_CLAMP = 200;

export interface LineDiff {
  /** Rendered unified-ish diff (`+`/`-`/` ` prefixes), or a no-change note. */
  text: string;
  added: number;
  removed: number;
  /** True when either side was truncated to MAX_INPUT_LINES before diffing. */
  truncated: boolean;
}

function clamp(s: string): string {
  return s.length > LINE_CLAMP ? s.slice(0, LINE_CLAMP) + "…" : s;
}

/** Longest-common-subsequence over two line arrays → the aligned edit script. */
function lcsOps(a: string[], b: string[]): Array<{ t: " " | "-" | "+"; line: string }> {
  const n = a.length;
  const m = b.length;
  // DP table of LCS lengths.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Array<{ t: " " | "-" | "+"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "-", line: a[i] });
      i++;
    } else {
      ops.push({ t: "+", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: "-", line: a[i++] });
  while (j < m) ops.push({ t: "+", line: b[j++] });
  return ops;
}

/** Render a compact before→after line diff. Windows around the ACTUAL change:
 *  the common leading/trailing lines are found first (linear), then only the
 *  changed middle is diffed — so a change anywhere in a long file is shown, and
 *  the LCS input stays bounded regardless of file length. */
export function diffLines(before: string, after: string): LineDiff {
  if (before === after) return { text: "(no changes)", added: 0, removed: 0, truncated: false };

  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  // Common prefix / suffix (the unchanged head and tail).
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  // The changed middle. Its FULL sizes drive the +/- totals so the header isn't
  // under-reported; the LCS runs on a bounded slice so a huge change can't blow
  // up the DP.
  const fullMidA = a.slice(prefix, a.length - suffix);
  const fullMidB = b.slice(prefix, b.length - suffix);
  const truncated = fullMidA.length > MAX_INPUT_LINES || fullMidB.length > MAX_INPUT_LINES;
  const midA = fullMidA.slice(0, MAX_INPUT_LINES);
  const midB = fullMidB.slice(0, MAX_INPUT_LINES);

  const ops = lcsOps(midA, midB);
  // When truncated we can't cheaply LCS the whole region, so report the region
  // sizes as an upper bound (better to over- than under-state a change size in
  // an approval); otherwise the exact op counts.
  const added = truncated ? fullMidB.length : ops.filter((o) => o.t === "+").length;
  const removed = truncated ? fullMidA.length : ops.filter((o) => o.t === "-").length;

  const out: string[] = [];
  // leading context (collapse the earlier unchanged head)
  if (prefix > CONTEXT) out.push(`  … ${prefix - CONTEXT} unchanged …`);
  for (let x = Math.max(0, prefix - CONTEXT); x < prefix; x++) out.push(`  ${clamp(a[x])}`);
  // the changed region
  for (const op of ops) out.push(`${op.t} ${clamp(op.line)}`);
  // trailing context (collapse the later unchanged tail)
  const tailStart = a.length - suffix;
  for (let x = 0; x < Math.min(CONTEXT, suffix); x++) out.push(`  ${clamp(a[tailStart + x])}`);
  if (suffix > CONTEXT) out.push(`  … ${suffix - CONTEXT} unchanged …`);

  // Notes are appended AFTER the output cap, so a capped-away diff still tells
  // the user that lines / a changed tail were omitted.
  const notes: string[] = [];
  if (out.length > MAX_OUTPUT_LINES) notes.push(`  … diff truncated (${out.length - MAX_OUTPUT_LINES} more lines) …`);
  if (truncated) notes.push(`  … change region longer than ${MAX_INPUT_LINES} lines; tail not shown …`);

  const text = [out.slice(0, MAX_OUTPUT_LINES).join("\n"), ...notes].join("\n");
  return { text, added, removed, truncated };
}
