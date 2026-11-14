// How the squad handled whole requests. A request is an issue a person created with no parent,
// together with its sub-issues. For each one, this reads what any setup records alike: the runs and
// their cost, and the status changes and comments, with who made each one. It measures how long a
// request took from its first run to Done, how many runs it took and what they cost, how many review
// rounds and plan reviews it needed, how often people acted on it, and how long it waited on them.
// Ported from uxfront's `.multica/squad-requests.mjs`.

import type { BenchQuery, MetricResult } from "10xagents";

import type { BenchSource, Issue, Run, TimelineEntry } from "./read.ts";
import {
  BUILT_IN_STEPS,
  collector,
  finite,
  heading,
  mean,
  ms,
  pct,
  pricer,
  runCost,
  sum,
} from "./shared.ts";

export const REQUEST_METRICS = [
  "requests-touched",
  "requests",
  "requests-done",
  "requests-stopped",
  "requests-open",
  "requests-left-out",
  "lead-time-p50",
  "lead-time-p90",
  "people-actions-p50",
  "people-actions-p90",
  "waiting-on-people-p50",
  "waiting-on-people-p90",
  "waiting-on-people-share",
  "review-rounds-mean",
  "plan-reviews-mean",
  "runs-per-request-p50",
  "runs-per-request-p90",
  "agent-time-per-request-p50",
  "agent-time-per-request-p90",
  "cost-per-request-p50",
  "cost-per-request-p90",
  "requests-cost-known",
  "requests-cost",
  "requests-failed-runs",
];

/** One request's numbers. Identifiers, dates, counts and costs only. */
export interface RequestRow {
  request: string;
  segment: string;
  created: string;
  firstRun: string;
  outcome: "done" | "stopped" | "open";
  leadHours: number;
  issues: number;
  linkedIssues: string[];
  runs: number;
  failedRuns: number;
  agentHours: number;
  cost: number | null;
  costKnown: number;
  reviewRounds: number;
  planReviews: number;
  peopleActions: number;
  waitedHours: number;
}

// What started a run, from the first line of the comment that triggered it. The squad protocol put a
// keyword in capitals at the head of each one, so a reply that starts "Fix the heading" stays a
// comment. A workflow starts a step's run with the move into it, which leaves no summary, so the
// step comes from the issue's status changes.
const commentKind = (summary: string | null | undefined): string => {
  const s = heading(summary);
  if (!s) return "assignment or status";
  if (/^Wakeup: sub-issues closed/i.test(s)) return "stage barrier";
  if (/^Wakeup:/i.test(s)) return "wakeup";
  // A DELIVERY, FIX or RESTACK asked QA to review a part, and a SYNTHESIS or STAGE REVIEW asked it
  // to review an integration branch.
  if (/^(FIX|DELIVERY|RESTACK|SYNTHESIS|STAGE REVIEW)\b/.test(s)) return "review request";
  if (/^PLAN v\d+.*in review/.test(s)) return "plan";
  return "comment";
};

interface ReadRun {
  issue: string;
  agent: string;
  status: string;
  attempt: number;
  kind: string;
  step: string;
  created: number;
  started: number;
  completed: number;
  end: number;
  cost: number | null;
  linked?: boolean;
}

interface Entry extends TimelineEntry {
  issue: string;
}

interface ReadIssue {
  issue: Issue;
  entries: Entry[];
  changes: Entry[];
  statusAt: (t: number) => string | undefined;
  runs: ReadRun[];
  truncated: boolean;
}

const LIVE = new Set(["queued", "dispatched", "claimed", "running"]);
const CLOSED = new Set(["done", "cancelled"]);
// One reply often lands as a comment, a move and an assignment within seconds, so actions within
// this of the first one count as one.
const SAME_ACTION = 2 * 60000;
// QA lands parts on an integration branch inside its run, and the merge's move to Done can trail
// the run's end by a moment.
const RUN_GRACE = 60000;
const hours = (x: number): number => x / 3600000;

const lastTouch = (i: Issue) => ms(i.last_activity_at ?? i.updated_at ?? i.created_at);

const isReview = (run: ReadRun) => /^QA$/i.test(run.agent);

const during = (r: ReadRun, t: number) => r.started <= t && t <= r.end + RUN_GRACE;

// A person's move or assignment queues its run in the same write, and a merge that closes a stage
// queues the parent's stage barrier, and Multica can write the run's record first, so that run is
// the action's, not the squad's.
const causedBy = (r: ReadRun, t: number) =>
  ["assignment or status", "stage barrier"].includes(r.kind) &&
  r.created >= t - 1000 &&
  r.created <= t;

// The time in [a, b) when holds(t) is true, for a holds that only changes at the given moments.
const timeWhen = (a: number, b: number, moments: number[], holds: (t: number) => boolean) => {
  const cuts = [a, ...moments.filter((m) => m > a && m < b).toSorted((x, y) => x - y), b];
  let total = 0;
  for (let i = 1; i < cuts.length; i++) {
    const from = cuts[i - 1] ?? 0;
    const to = cuts[i] ?? 0;
    if (to > from && holds((from + to) / 2)) total += to - from;
  }
  return total;
};

const escape = (x: string) => x.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A run that reviews: QA's first attempt, unless it was cancelled before it started.
const reviews = (run: ReadRun) =>
  isReview(run) && run.attempt <= 1 && !(run.status === "cancelled" && !(run.started > 0));

/** Measures the requests whose first run falls in the window. */
export const measureRequests = async (
  source: BenchSource,
  query: BenchQuery,
): Promise<{ metrics: MetricResult[]; rows: RequestRow[]; notes: string[] }> => {
  const { since, until, split } = query;
  const { costOf, unpriced } = pricer();
  const notes: string[] = [];
  const log = query.log ?? (() => {});

  const children = new Map<string, Issue[]>();
  for (const issue of source.issues) {
    if (!issue.parent_issue_id) continue;
    children.set(issue.parent_issue_id, [...(children.get(issue.parent_issue_id) ?? []), issue]);
  }
  const treeOf = (issue: Issue): Issue[] => [
    issue,
    ...(children.get(issue.id) ?? []).flatMap(treeOf),
  ];
  // A request whose tree was last touched before the window, or that was created after it, can't
  // have its first run in it, so its runs aren't read.
  const candidates = source.issues
    .filter((i) => !i.parent_issue_id && ms(i.created_at) < until)
    .map((i) => ({ request: i, tree: treeOf(i) }))
    .filter(({ tree }) => Math.max(...tree.map(lastTouch)) >= since);
  log(`${candidates.length} requests touched in the window; reading their runs…`);

  const readIssue = async (issue: Issue): Promise<ReadIssue> => {
    const { data, warnings } = await source.timeline(issue.id, false);
    const entries: Entry[] = data
      .toSorted((a, b) => ms(a.created_at) - ms(b.created_at))
      .map((e) => ({ ...e, issue: issue.id }));
    const changes = entries.filter((e) => e.type === "activity" && e.action === "status_changed");
    // The status the issue was at a moment: the last change before it, or where the first one
    // started from.
    const statusAt = (t: number): string | undefined => {
      let status = changes[0]?.details?.from ?? issue.status;
      for (const c of changes) {
        if (ms(c.created_at) > t) break;
        status = c.details?.to ?? status;
      }
      return status;
    };
    const runs = source.runs(issue.id).map((r: Run): ReadRun => {
      const kind = commentKind(r.trigger_summary);
      const created = ms(r.created_at);
      const started = ms(r.started_at);
      const completed = ms(r.completed_at);
      return {
        issue: issue.id,
        agent: source.agentNames.get(r.agent_id) ?? r.agent_id,
        status: r.status,
        attempt: r.attempt ?? 1,
        kind,
        // Multica queues a step's run within the move's request, so a second's grace covers it.
        step: kind === "assignment or status" ? (statusAt(created + 1000) ?? "") : "",
        created,
        started,
        completed,
        // A live run goes on past now. A finished one without an end, which Multica doesn't
        // write, ends where it was last seen.
        end:
          completed > 0
            ? completed
            : LIVE.has(r.status)
              ? Infinity
              : Math.max(created, started || 0),
        cost: runCost(r.usage, started > 0, costOf),
      };
    });
    return { issue, entries, changes, statusAt, runs, truncated: /truncated/i.test(warnings) };
  };

  // A review round: a QA run that starts reviewing delivered work, from a review request under the
  // protocol, or from a move or an assignment at the review step in a workflow. CI wakeups and
  // Multica's retries continue the round they belong to, and a run cancelled before it started,
  // like the one an edited DELIVERY replaced, reviewed nothing.
  const startsReview = (run: ReadRun) =>
    reviews(run) && (run.kind === "review request" || query.reviewSteps.includes(run.step));
  const startsPlanReview = (run: ReadRun) =>
    reviews(run) && (run.kind === "plan" || query.planSteps.includes(run.step));

  // Every tree first, so an issue an agent filed can join the requests whose comments name it.
  const trees: { request: Issue; read: ReadIssue[] }[] = [];
  const unreadable: string[] = [];
  for (const { request, tree } of candidates) {
    try {
      const read: ReadIssue[] = [];
      for (const issue of tree) read.push(await readIssue(issue));
      trees.push({ request, read });
    } catch (error) {
      unreadable.push(request.identifier ?? request.id);
      log(
        `  skipped ${request.identifier ?? request.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // When no request could be read, the problem is the CLI or the connection, not the data.
  if (candidates.length && !trees.length) {
    throw new Error(`couldn't read any of the ${candidates.length} requests`);
  }
  // In a workflow, agents file what they find outside a request's scope as issues of their own, so
  // only requests people made compare. When such an issue holds a request up, the squad's work on
  // it while the request is Blocked is work on that request, not time spent waiting on people. A
  // comment names an issue by its identifier, as a whole word so UXF-1 isn't UXF-12, or by its id.
  const filed = trees
    .filter((t) => t.request.creator_type === "agent")
    .map((t) => ({
      ...t,
      name: new RegExp(
        `(?<![\\w-])(${[t.request.identifier, t.request.id]
          .filter((x): x is string => !!x)
          .map(escape)
          .join("|")})(?![\\w-])`,
      ),
    }));
  const namedIn = (entries: readonly Entry[]) =>
    filed.filter((f) => entries.some((e) => e.type === "comment" && f.name.test(e.content ?? "")));

  const rows: RequestRow[] = [];
  const truncated: string[] = [];
  // Requests whose timeline lost the moment they closed, so their outcome can't be told.
  const unknown: string[] = [];
  let unstarted = 0;
  let agentMade = 0;
  let outside = 0;
  let unplaced = 0;
  // The steps QA's runs from a move or an assignment worked at, so a step key that isn't the
  // default shows up.
  const qaSteps = new Map<string, number>();
  for (const { request, read } of trees) {
    const root = read[0];
    if (!root) continue;
    const runsAll = read.flatMap((r) => r.runs).toSorted((a, b) => a.created - b.created);
    // The clock starts at the first run that started: one cancelled while it was queued did no work.
    const start = runsAll.find((r) => r.started > 0)?.created ?? Number.NaN;
    if (!Number.isFinite(start)) {
      unstarted++;
      continue;
    }
    if (!(start >= since && start < until)) {
      outside++;
      continue;
    }
    if (request.creator_type === "agent") {
      agentMade++;
      continue;
    }
    // The sub-issues that existed at a moment. A new one starts in Backlog, so one filed later
    // would read as open before it existed.
    const partsAt = (t: number) => read.slice(1).filter((o) => ms(o.issue.created_at) <= t);
    // How a request stood at a moment: done (it and every part closed), stopped (cancelled, or sent
    // back to Backlog after it ran) or open, and since when. A parent Multica closed early, while a
    // part is still open, is open.
    const standing = (t: number) => {
      const status = root.statusAt(t);
      const parts = partsAt(t);
      const outcome: RequestRow["outcome"] =
        status === "done" && parts.every((o) => CLOSED.has(o.statusAt(t) ?? ""))
          ? "done"
          : ["cancelled", "backlog"].includes(status ?? "")
            ? "stopped"
            : "open";
      const lastTo = (r: ReadIssue) =>
        r.changes.findLast((c) => ms(c.created_at) <= t && c.details?.to === r.statusAt(t));
      const closes = [root, ...(outcome === "done" ? parts : [])].map(lastTo);
      // Without the move that closed it, the moment can't be told.
      return {
        outcome,
        at: closes.every(Boolean) ? Math.max(...closes.map((c) => ms(c?.created_at))) : Number.NaN,
      };
    };
    // A request is judged at its horizon, so both sides of a cutover stop the same way.
    const placed = split.placeRequest(start, (t) => standing(t).outcome === "open");
    if (!placed) {
      unplaced++;
      continue;
    }
    const { segment, horizon } = placed;
    const { outcome, at } = standing(horizon);
    if (outcome !== "open" && !Number.isFinite(at)) {
      unknown.push(request.identifier ?? request.id);
      continue;
    }
    // Closed before any run did work: the squad never handled it.
    if (outcome !== "open" && at < start) {
      unstarted++;
      continue;
    }
    const end = outcome === "open" ? Number.NaN : at;
    const runs = runsAll.filter((r) => r.created < horizon);
    for (const r of runs) {
      if (isReview(r) && r.step) qaSteps.set(r.step, (qaSteps.get(r.step) ?? 0) + 1);
    }
    if (read.some((r) => r.truncated)) truncated.push(request.identifier ?? request.id);
    const entries = read.flatMap((r) => r.entries).filter((e) => ms(e.created_at) < horizon);
    // A filed issue's work counts only while the request or a part is Blocked.
    const linked = namedIn(entries).flatMap((f) => f.read);
    const blockedAt = (t: number) => read.some((x) => x.statusAt(t) === "blocked");
    const counts = (r: ReadRun, t: number) => !r.linked || blockedAt(t);
    const squadRuns: ReadRun[] = [
      ...runs,
      ...linked.flatMap((r) => r.runs).map((r) => ({ ...r, linked: true })),
    ];
    const squadEntries = [
      ...entries,
      ...linked
        .flatMap((r) => r.entries)
        .filter((e) => ms(e.created_at) < horizon && blockedAt(ms(e.created_at))),
    ];
    // A run a person queued, by a comment, a move or a merge, within a few seconds either way.
    const byPerson = (o: ReadRun) =>
      squadEntries.some(
        (e) =>
          e.actor_type !== "agent" &&
          ms(e.created_at) >= o.created - 5000 &&
          ms(e.created_at) <= o.created + 1000,
      );
    // A timer's run that moved nothing and started nothing isn't the squad handing work on. QA's
    // CI wakeups always are. Neither a run a person queued during it nor Multica's retry of it is
    // something it started.
    const idle = squadRuns.filter(
      (r) =>
        r.kind === "wakeup" &&
        !isReview(r) &&
        !squadEntries.some(
          (e) =>
            e.actor_type === "agent" &&
            e.action === "status_changed" &&
            during(r, ms(e.created_at)),
        ) &&
        !squadRuns.some(
          (o) =>
            o !== r &&
            during(r, o.created) &&
            !byPerson(o) &&
            !(o.attempt > 1 && o.agent === r.agent && o.issue === r.issue && o.kind === r.kind),
        ),
    );
    const working = squadRuns.filter((r) => !idle.includes(r));
    // The squad is busy while one of its runs is queued or going.
    const busy = (t: number) =>
      working.some((r) => r.created <= t && r.end > t && !causedBy(r, t) && counts(r, t));
    // QA lands a part on its integration branch inside its run on that part.
    const qaMerging = (e: Entry, t: number) =>
      runs.some(
        (r) => r.issue === e.issue && isReview(r) && r.started <= t && r.end + RUN_GRACE > t,
      );
    // Parked: the request sits in Backlog, or closed with all its parts closed, before someone
    // takes it up again, while no run goes on. That time is neither work nor waiting.
    const parked = (t: number) => {
      const status = root.statusAt(t);
      const closedAt = ms(root.changes.findLast((c) => ms(c.created_at) <= t)?.created_at);
      const takenUp =
        status !== "backlog" &&
        working.some(
          (r) =>
            r.issue === root.issue.id &&
            r.kind === "comment" &&
            r.created > closedAt &&
            r.created <= t,
        );
      const resting =
        status === "backlog" ||
        (CLOSED.has(status ?? "") &&
          !takenUp &&
          partsAt(t).every((o) => CLOSED.has(o.statusAt(t) ?? "")));
      return resting && !working.some((r) => r.created <= t && r.end > t && counts(r, t));
    };
    const moments = [
      ...read.flatMap((r) => [ms(r.issue.created_at), ...r.changes.map((c) => ms(c.created_at))]),
      ...working.flatMap((r) => [r.created, r.end]),
    ].filter(Number.isFinite);
    const parkedIn = (a: number, b: number) => (b > a ? timeWhen(a, b, moments, parked) : 0);
    // People act as members: a comment, a move or an assignment. A merged PR moves its issue to Done
    // as the system, which counts as a person's merge unless QA was landing that part. The move or
    // assignment that started the first run is the request itself, not an action on it.
    const last = outcome === "open" ? horizon : end;
    const byPeople = entries
      .filter((e) => {
        const t = ms(e.created_at);
        if (!(t > start + SAME_ACTION && t <= last)) return false;
        if (e.actor_type === "member") {
          return (
            e.type === "comment" || ["status_changed", "assignee_changed"].includes(e.action ?? "")
          );
        }
        return (
          e.type === "activity" &&
          e.action === "status_changed" &&
          e.details?.to === "done" &&
          e.actor_type !== "agent" &&
          !qaMerging(e, t)
        );
      })
      .map((e) => ms(e.created_at))
      .toSorted((a, b) => a - b);
    const actions: number[] = [];
    for (const t of byPeople) {
      if (!(t - (actions.at(-1) ?? -Infinity) <= SAME_ACTION)) actions.push(t);
    }
    // Waiting on people: before each action, the time since the squad's last move or the previous
    // action, unless the squad was busy, and less the time the request was parked.
    const idleEntry = (e: Entry) =>
      idle.some((r) => r.issue === e.issue && during(r, ms(e.created_at))) &&
      e.action !== "status_changed";
    const agentEntries = squadEntries
      .filter((e) => e.actor_type === "agent" && !idleEntry(e))
      .map((e) => ms(e.created_at));
    let waited = 0;
    let previous = start;
    for (const t of actions) {
      const lastSquad = Math.max(
        start,
        ...agentEntries.filter((m) => m < t),
        ...working
          .filter((r) => !causedBy(r, t))
          .flatMap((r) => [r.created, r.started, r.completed].filter((m) => counts(r, m)))
          .filter((m) => m < t),
      );
      const from = Math.max(lastSquad, previous);
      if (!busy(t)) waited += t - from - parkedIn(from, t);
      previous = t;
    }
    const costs = runs.map((r) => r.cost);
    rows.push({
      request: request.identifier ?? request.id,
      segment,
      created: request.created_at,
      firstRun: new Date(start).toISOString(),
      outcome,
      leadHours: hours(end - start - parkedIn(start, end)),
      issues: read.length,
      linkedIssues: namedIn(entries).map(({ request: f }) => f.identifier ?? f.id),
      runs: runs.length,
      failedRuns: runs.filter((r) => r.status === "failed").length,
      agentHours: hours(
        runs
          .filter((r) => r.started > 0 && r.completed > 0)
          .reduce((total, r) => total + Math.max(0, r.completed - r.started), 0),
      ),
      // Unknown when a run that started reported no usage, rather than free.
      cost: costs.includes(null) ? null : sum(costs.map((c) => c ?? 0)),
      costKnown: sum(costs.map((c) => c ?? 0)),
      reviewRounds: runs.filter(startsReview).length,
      planReviews: runs.filter(startsPlanReview).length,
      peopleActions: actions.length,
      waitedHours: hours(waited),
    });
  }

  const metrics: MetricResult[] = [];
  for (const segment of split.segments) {
    const { results, add } = collector(segment);
    const all = rows.filter((r) => r.segment === segment);
    const done = all.filter((r) => r.outcome === "done");
    const spread = (id: string, xs: (number | null)[]) => {
      const values = finite(xs);
      add(`${id}-p50`, pct(values, 0.5));
      add(`${id}-p90`, pct(values, 0.9));
    };
    add("requests", all.length);
    for (const outcome of ["done", "stopped", "open"] as const) {
      add(`requests-${outcome}`, all.filter((r) => r.outcome === outcome).length);
    }
    spread(
      "lead-time",
      done.map((r) => r.leadHours),
    );
    spread(
      "runs-per-request",
      done.map((r) => r.runs),
    );
    spread(
      "agent-time-per-request",
      done.map((r) => r.agentHours),
    );
    spread(
      "cost-per-request",
      done.map((r) => r.cost),
    );
    add("requests-cost-known", done.filter((r) => r.cost !== null).length);
    add("review-rounds-mean", mean(done.map((r) => r.reviewRounds)));
    add("plan-reviews-mean", mean(done.map((r) => r.planReviews)));
    spread(
      "people-actions",
      done.map((r) => r.peopleActions),
    );
    spread(
      "waiting-on-people",
      done.map((r) => r.waitedHours),
    );
    const lead = sum(finite(done.map((r) => r.leadHours)));
    add("waiting-on-people-share", lead ? sum(done.map((r) => r.waitedHours)) / lead : Number.NaN);
    add("requests-cost", sum(all.map((r) => r.costKnown)));
    add("requests-failed-runs", sum(all.map((r) => r.failedRuns)));
    metrics.push(...results);
  }
  // For the window as a whole: what was touched, and why each request left out was.
  metrics.push({ id: "requests-touched", value: candidates.length });
  const reasons: [string, number][] = [
    ["first run before --since or after --until", outside],
    ["no run worked on it yet", unstarted],
    ["an agent created it", agentMade],
    ["the timeline lost the move that closed it", unknown.length],
    ["the CLI couldn't read it", unreadable.length],
    ["started while neither compared setup was live", unplaced],
  ];
  for (const [reason, n] of reasons) {
    metrics.push({ id: "requests-left-out", by: { reason }, value: n });
  }

  if (unknown.length) notes.push(`The timeline lost the move that closed: ${unknown.join(", ")}.`);
  if (unreadable.length) notes.push(`The CLI couldn't read: ${unreadable.join(", ")}.`);
  if (qaSteps.size) {
    const stepsLine = [...qaSteps].map(([step, n]) => `${step} ${n}`).join(", ");
    notes.push(`QA's runs from a move or an assignment were at: ${stepsLine}.`);
  }
  const strange = [...qaSteps.keys()].filter(
    (step) =>
      !BUILT_IN_STEPS.has(step) &&
      !query.reviewSteps.includes(step) &&
      !query.planSteps.includes(step),
  );
  if (strange.length) {
    notes.push(
      `QA ran at ${strange.join(", ")}, which is neither a --review-step (${query.reviewSteps.join(", ")}) nor a --plan-step (${query.planSteps.join(", ")}): if one is your review or plan step, pass its key.`,
    );
  }
  if (truncated.length) {
    notes.push(
      `The server cut short a timeline in these requests, so their counts miss the oldest entries: ${truncated.join(", ")}.`,
    );
  }
  if (unpriced.size) notes.push(`Priced as Opus 5.5: ${[...unpriced].join(", ")}.`);
  return { metrics, rows, notes };
};
