// The Multica connector: syncs a target's agents, skills, squad, workflows and Agent context to
// a Multica workspace through the `multica` CLI.

import type {
  BenchQuery,
  BenchResult,
  Change,
  Connector,
  ConnectorIssue,
  LiveState,
  Place,
  PullOptions,
  RenderedSetup,
  RenderedTarget,
} from "10xagents";

import { applyChanges } from "./apply.ts";
import { bench, MULTICA_METRICS } from "./bench/index.ts";
import type { Env } from "./multica.ts";
import { planChanges } from "./plan.ts";
import type { MulticaLive } from "./pull.ts";
import { pull } from "./pull.ts";
import { checkSkill } from "./skills.ts";
import { length } from "./text.ts";
import { checkWorkflows, columnNames, MAX_DESCRIPTION, mergeWorkflows } from "./workflow.ts";

export { BUILT_IN, columnNames, MAX_DESCRIPTION, MAX_STEP, mergeWorkflows } from "./workflow.ts";
export { childEnv, DESKTOP_CLI, findMultica } from "./multica.ts";
export { listProfiles } from "./profiles.ts";
export { benchFrom, MULTICA_METRICS } from "./bench/index.ts";
export type { BenchSource, CycleRow, RequestRow, RunRow, VerdictRow } from "./bench/index.ts";
export type { MulticaLive } from "./pull.ts";

/** The platform this connector syncs to. */
export const platform = "multica";

export interface MulticaConnectorOptions {
  /** The environment to read `MULTICA`, `PATH` and `HOME` from. The default is `process.env`. */
  env?: Env;
  /** Where the macOS Desktop app keeps its CLI. */
  desktop?: string;
}

const isLive = (live: LiveState): live is MulticaLive => live.connector === platform;

/** What Multica would refuse in `rendered`, checked before anything is read. */
export const validate = (rendered: RenderedSetup): ConnectorIssue[] => {
  const issues: ConnectorIssue[] = [];
  for (const agent of rendered.agents) {
    const size = length(agent.description);
    if (size > MAX_DESCRIPTION) {
      issues.push({
        field: `agents.${agent.id}.description`,
        message: `is ${size} characters, over Multica's ${MAX_DESCRIPTION}`,
      });
    }
  }
  for (const skill of rendered.skills) issues.push(...checkSkill(skill));
  // Multica would keep the squad's instructions only if they're there to write.
  if (rendered.squad && !rendered.squad.instructions.trim()) {
    issues.push({
      field: "squad.instructions",
      message:
        "renders empty: add squad.md to the setup or the target, or point squad.instructions at a file",
    });
  }
  issues.push(...checkWorkflows(rendered, mergeWorkflows(rendered)));
  return issues;
};

/** A Multica connector that reads its environment from `options`. */
export const createConnector = (options: MulticaConnectorOptions = {}): Connector => ({
  id: platform,
  capabilities: {
    // The workspace's Agent context, which Multica writes into every agent's brief.
    sharedContext: true,
    // Multica attaches workflows to projects, not to issues.
    workflowPerIssue: false,
    squads: true,
    skills: true,
    metrics: MULTICA_METRICS,
  },
  // Multica's daemon runs each agent in a folder under its `multica_workspaces…` directory.
  runFolders: /multica.workspaces/i,
  columnNames,
  validate,
  place: (live: LiveState): Place => {
    if (!isLive(live)) throw new Error("not a Multica connector's live state");
    return {
      name: live.workspace.name,
      // The profile and workspace this pull resolved, so a re-check reads the same place.
      pull: { profile: live.profile, workspace: live.workspace.id },
    };
  },
  pull: (target: RenderedTarget, pullOptions: PullOptions = {}): Promise<LiveState> =>
    pull(target, pullOptions, {
      env: options.env ?? process.env,
      ...(options.desktop === undefined ? {} : { desktop: options.desktop }),
    }),
  plan: (rendered: RenderedSetup, live: LiveState): Promise<Change[]> => {
    if (!isLive(live)) return Promise.reject(new Error("not a Multica connector's live state"));
    try {
      return Promise.resolve(planChanges(rendered, live));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  },
  bench: (query: BenchQuery): Promise<BenchResult> =>
    bench(query, {
      env: options.env ?? process.env,
      ...(options.desktop === undefined ? {} : { desktop: options.desktop }),
    }),
  apply: (changes: Change[]) => {
    try {
      return Promise.resolve(applyChanges(changes));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  },
});

export const connector: Connector = createConnector();

export default connector;
