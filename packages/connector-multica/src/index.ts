// The Multica connector. Its sync and bench come in later releases: for now it declares what
// Multica can do, so `10xagents build` renders for it and `10xagents connectors` lists it.

import type { Connector } from "10xagents";

const notYet = (): Promise<never> =>
  Promise.reject(new Error("The Multica connector can't read or write Multica yet."));

/** The platform this connector syncs to. */
export const platform = "multica";

export const connector: Connector = {
  id: platform,
  capabilities: {
    // The workspace's Agent context, which Multica writes into every agent's brief.
    sharedContext: true,
    // Multica attaches workflows to projects, not to issues.
    workflowPerIssue: false,
    squads: true,
    skills: true,
    metrics: [],
  },
  pull: notYet,
  plan: notYet,
  apply: notYet,
};

export default connector;
