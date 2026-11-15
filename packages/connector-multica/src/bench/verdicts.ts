// Why reviews fail, from QA's `VERDICT:` comments and their findings ledgers, and each FIX's answer
// to each finding. Only the squad protocol wrote these comments, so in a window without them every
// review metric here is `n/a`. Ported from uxfront's `.multica/squad-verdicts.mjs`, without the
// text: the rows hold results, rounds, ids and counts, never a finding's or a comment's words.

import type { BenchQuery, MetricResult } from "10xagents";

import type { BenchSource, Comment } from "./read.ts";
import { collector, count, heading, ms } from "./shared.ts";

export const VERDICT_METRICS = [
  "first-verdicts",
  "first-fail-blockers",
  "blockers-per-first-fail",
  "first-fails-only-mechanical",
  "blocker-outcomes",
  "fix-answers",
  "issues-by-pass-round",
];

export interface Finding {
  id: string;
  origin: string | null;
  state: string | null;
  raisedRound: number | null;
}

export interface VerdictEvent {
  type: "verdict";
  at: string;
  author: string;
  result: string;
  round: number | null;
  report: string | null;
  blocking: Finding[];
  settled: Finding[];
  nits: number;
  needsDecision: number;
}

export interface HandoffEvent {
  type: string;
  variant: string | null;
  at: string;
  author: string;
  answers: { id: string; answer: string }[];
}

/** One work issue with a verdict in the window, and what happened on it up to `--until`. */
export interface VerdictRow {
  issue: string;
  parent: string | null;
  repository: string | null;
  segment: string | null;
  events: (VerdictEvent | HandoffEvent)[];
}

// The lines of one `## Section` of a comment or report.
const section = (text: string | null | undefined, name: string): string[] => {
  const lines = (text ?? "").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\b`, "i").test(l));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => l.trim());
};
// A ledger line: "1. B3 · `file:line` · raised r1 as `regression` · `carried` · open · …"
const ledger = (line: string): (Finding & { text: string }) | null => {
  const m = /^\s*(?:\d+\.|-)\s*(B\d+)\s*[·—-]?\s*(.*)$/.exec(line);
  if (!m) return null;
  const rest = m[2] ?? "";
  const raised = /raised r(\d+) as `?([a-z]+)`?/.exec(rest);
  const state = /\b(open|fixed r\d+|withdrawn r\d+|nit r\d+)\b/.exec(rest);
  return {
    id: m[1] ?? "",
    raisedRound: raised ? Number(raised[1]) : null,
    origin: raised?.[2] ?? null,
    state: state?.[1]?.replace(/ r\d+$/, "") ?? null,
    text: rest,
  };
};
// A FIX answer: "1. B3 → fixed at `file:line` | rebutted: … | reading: … | not fixed: …"
const answer = (line: string) => {
  const m =
    /^\s*\d+\.\s*(B\d+)\s*(?:→|->)\s*(fixed|rebutted|reading|not mechanical|not fixed)\b[:\s]*(.*)$/i.exec(
      line,
    );
  return m ? { id: m[1] ?? "", answer: (m[2] ?? "").toLowerCase() } : null;
};
const finding = ({ id, origin, state, raisedRound }: Finding): Finding => ({
  id,
  origin,
  state,
  raisedRound,
});

const isVerdict = (e: VerdictEvent | HandoffEvent): e is VerdictEvent => e.type === "verdict";

/** Measures the work issues with a verdict in the window. */
export const measureVerdicts = (
  source: BenchSource,
  query: BenchQuery,
): { metrics: MetricResult[]; rows: VerdictRow[]; notes: string[] } => {
  const { since, until, split } = query;
  const log = query.log ?? (() => {});
  const inWindow = (at: string) => ms(at) >= since && ms(at) < until;
  const recent = source.issues.filter(
    (i) =>
      ms(i.last_activity_at ?? i.updated_at ?? i.created_at) >= since && ms(i.created_at) < until,
  );
  log(`${recent.length} issues touched in the window; reading their verdicts…`);

  const results: VerdictRow[] = [];
  for (const issue of recent) {
    let comments: Comment[];
    try {
      comments = source.comments(issue.id);
    } catch (error) {
      log(
        `  skipped ${issue.identifier ?? issue.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const events: (VerdictEvent | HandoffEvent)[] = [];
    for (const c of comments.toSorted((a, b) => ms(a.created_at) - ms(b.created_at))) {
      const head = heading((c.content ?? "").split("\n")[0]);
      const author = source.agentNames.get(c.author_id ?? "") ?? c.author_type ?? "";
      if (head.startsWith("VERDICT:")) {
        const result =
          /^VERDICT:\s*(PASS|FAIL|PLAN WRONG|CONFLICT|ESCALATE|PENDING CI)\b/
            .exec(head)?.[1]
            ?.toUpperCase() ?? "?";
        const report = (c.attachments ?? []).find((a) =>
          /^(verdict-r\d+|integration-review-.+|escalate)\.md$/.test(a.filename ?? ""),
        );
        const text = report ? source.attachment(report) : null;
        const reasons = new Set(
          section(c.content, "Blocking")
            .map(ledger)
            .filter((f) => f !== null)
            .map((f) => f.id),
        );
        const blocking: Finding[] = section(text, "Blocking")
          .map(ledger)
          .filter((f) => f !== null)
          .map(finding);
        // A report that didn't parse still has the comment's own list.
        for (const id of reasons) {
          if (!blocking.some((f) => f.id === id)) {
            blocking.push({ id, origin: null, state: null, raisedRound: null });
          }
        }
        events.push({
          type: "verdict",
          at: c.created_at,
          author,
          result,
          round: Number(/\(round (\d+)\)/.exec(head)?.[1]) || null,
          report: report?.filename ?? null,
          blocking,
          settled: section(text, "Settled")
            .map(ledger)
            .filter((f) => f !== null)
            .map(finding),
          nits: section(text, "Nits").length,
          needsDecision: section(c.content, "Needs a decision").length,
        });
      } else if (/^(FIX|DELIVERY|RESTACK)\b/.test(head)) {
        events.push({
          type: (head.split(/\s/)[0] ?? "").toUpperCase(),
          variant:
            /^FIX\s+[—-]\s+(mechanical|owner|conflict|PLAN)\b/i.exec(head)?.[1]?.toLowerCase() ??
            null,
          at: c.created_at,
          author,
          answers: (c.content ?? "")
            .split("\n")
            .map(answer)
            .filter((a) => a !== null),
        });
      }
    }
    // What happened after the window stays out, so a period reads as it stood.
    const before = events.filter((e) => ms(e.at) < until);
    const firstInWindow = before.find((e) => e.type === "verdict" && ms(e.at) >= since);
    if (!firstInWindow) continue;
    results.push({
      issue: issue.identifier ?? issue.id,
      parent: issue.parent_issue_id ?? null,
      repository: /github\.com\/([^/]+\/[^/]+)\//.exec(issue.metadata?.pr_url ?? "")?.[1] ?? null,
      segment: split.segmentOf(ms(firstInWindow.at)) ?? null,
      events: before,
    });
  }

  // The first verdict on each work issue that judged a delivery.
  const firsts = results
    .map((r) => ({
      r,
      v: r.events.filter(isVerdict).find((e) => !["PENDING CI", "?"].includes(e.result)),
    }))
    .filter((x): x is { r: VerdictRow; v: VerdictEvent } => !!x.v && inWindow(x.v.at));
  // How a blocker ended, from the last verdict that lists it.
  const endOf = (r: VerdictRow, id: string): string => {
    for (const e of r.events.toReversed()) {
      if (!isVerdict(e)) continue;
      const f = [...e.blocking, ...e.settled].find((x) => x.id === id);
      if (f) return f.state ?? (e.blocking.includes(f) ? "open" : "settled");
    }
    return "unknown";
  };

  const metrics: MetricResult[] = [];
  for (const segment of split.segments) {
    const issues = results.filter((r) => r.segment === segment);
    const segmentFirsts = firsts.filter(({ v }) => split.segmentOf(ms(v.at)) === segment);
    const answers = results
      .flatMap((r) =>
        r.events.filter((e) => ms(e.at) >= since && split.segmentOf(ms(e.at)) === segment),
      )
      .flatMap((e) => ("answers" in e ? e.answers : []));
    // No verdict in the segment: these comments aren't written there, so every metric is n/a.
    if (issues.length === 0 && segmentFirsts.length === 0) continue;
    const { results: out, add } = collector(segment);
    add("first-verdicts", segmentFirsts.length);
    for (const [result, n] of count(segmentFirsts.map(({ v }) => v.result))) {
      add("first-verdicts", n, { result });
    }
    const failed = segmentFirsts.filter(({ v }) => v.result === "FAIL");
    const blockers = failed.flatMap(({ r, v }) => v.blocking.map((f) => ({ r, f })));
    add("first-fail-blockers", blockers.length);
    for (const [origin, n] of count(blockers.map(({ f }) => f.origin ?? "not in a report"))) {
      add("first-fail-blockers", n, { origin });
    }
    add("blockers-per-first-fail", blockers.length / Math.max(1, failed.length));
    add(
      "first-fails-only-mechanical",
      failed.filter(
        ({ v }) => v.blocking.length && v.blocking.every((f) => f.origin === "mechanical"),
      ).length,
    );
    for (const [state, n] of count(blockers.map(({ r, f }) => endOf(r, f.id)))) {
      add("blocker-outcomes", n, { state });
    }
    add("fix-answers", answers.length);
    for (const [kind, n] of count(answers.map((a) => a.answer)))
      add("fix-answers", n, { answer: kind });
    const rounds = issues.map((r) => {
      const pass = r.events.filter(isVerdict).find((e) => e.result === "PASS");
      return pass ? `PASS at round ${pass.round ?? "?"}` : "no PASS yet";
    });
    for (const [round, n] of count(rounds)) add("issues-by-pass-round", n, { round });
    metrics.push(...out);
  }
  return { metrics, rows: results, notes: [] };
};
