# @10xagents/connector-multica

The Multica connector lets `10xagents` keep a [Multica](https://multica.ai) workspace in line with your setup: its agents, skills, squad, Default workflow and Agent context. It also measures how the team does there, from Multica's own records of requests, runs and reviews. It changes only what differs, and leaves what only a person can do, like creating an agent, to you.

## Install

Install it beside the CLI, since `10xagents` loads the connector a target names as `connector: multica` from this package:

```bash
npm install --save-dev 10xagents @10xagents/connector-multica
```

The connector works through the `multica` CLI, logged in to the workspace you sync. It looks for it in this order:

1. `$MULTICA`.
2. `$MULTICA_CLI_PATH`.
3. `multica` on `PATH`.
4. The macOS Desktop app's copy, in `/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica`.

## Usage

Point a target at the workspace, by its slug, name or id, and set `vars.owner` to the member who takes the owner's steps:

```yaml
id: my-team
workspace: my-workspace
connector: multica
workflows: [request, part]
agents: [dispatcher, planner, designer, builder, qa, writer, ops]
vars:
  owner: Sam Lee
squad:
  name: Ultracode
  leader: dispatcher
```

Then compare and sync:

```bash
npx 10xagents plan --profile my-profile --diff
npx 10xagents sync --profile my-profile
```

Each command uses one Multica CLI profile: the one `--profile` names, the only one that's logged in, or the one you pick from a list. Without a terminal to ask in and with several profiles logged in, pass `--profile`. The connector runs `multica` from your home folder, without any `MULTICA_*` variables of its own environment, since the CLI prefers them to the profile's token and server. That way an agent run that syncs uses the profile you named, not the run's own account.

## Capabilities

| Capability         | Value | Why                                                                                                    |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------ |
| `sharedContext`    | yes   | The global traits go into the workspace's Agent context, which Multica writes into every agent's brief |
| `workflowPerIssue` | no    | Multica attaches workflows to projects, so an issue can't pick its own                                 |
| `squads`           | yes   | The target's squad becomes a Multica squad, with its leader and each member's role                     |
| `skills`           | yes   | The setup's and the target's skills are imported into the workspace and attached to agents             |
| `metrics`          | 48    | Every metric in the Outcome, Review and Cost and time groups of the catalogue                          |

## What it syncs

`plan` compares each of these with the workspace, and `sync` applies what differs, in this order:

| Item          | How it's matched             | What changes                                                                                 |
| ------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| Skills        | By name                      | A skill that's missing, or whose files differ, is imported whole, replacing the live one     |
| Agents        | By `name`                    | Instructions, description, model, thinking level and concurrency. Skills are only ever added |
| Squad         | By the target's `squad.name` | Its instructions, members, their roles and its leader                                        |
| Workflow      | The workspace's Default      | Every column, with its name, handoff, step text and moves                                    |
| Agent context | The workspace's own          | The global traits                                                                            |

A few things it leaves to you, and says so with a `!` line:

- **Agents and squads.** It never creates one, so create each agent and the squad with the names the setup gives, then run `sync` again.
- **Disabled skills.** A run loads only enabled skills, so a skill that's attached but switched off has to be switched on in the agent's Skills tab.
- **The owner.** `handoff: owner` goes to the workspace member whose full name is `vars.owner`, or whose first name is, when only one member matches. A name that matches nobody, or several people, stops the workflow's sync until you fix it.

It also never removes a skill from an agent, since one you attached by hand stays, and never moves a project to another workflow: a project on another one shows as a `·` line with the command that switches it back. The Agent context describes the workflow, so while the workflow can't sync, the context waits too.

Skills are checked before anything is read. Each one needs a `SKILL.md` whose `name` matches its folder, and none can hold a file Multica's import leaves out, like a dotfile, a licence or a binary, since that file would show as a change on every run.

## Workflows on Multica

Multica gives each workspace one Default workflow, so the connector merges a target's workflows into it, in the order the target lists them:

- **Built-in columns are shared.** Backlog, Todo, In Progress, In Review, Blocked, Done and Cancelled keep Multica's names, and every workflow that has one uses the same column. Two workflows have to agree on its handoff, step and moves.
- **The first workflow keeps its column names.** A custom column takes its `name`, or its key in title case, so `plan_review` becomes Plan Review.
- **Every later workflow's columns are prefixed** with its id in title case, so `part`'s `planning` becomes Part Planning.

Multica makes a custom status's key from its first name and keeps it when you rename the status, so Part Planning gets the key `part_planning`. `{{workflows.<id>.columns.<key>}}` renders these names, so the texts name the columns as the workspace shows them.

`build`, `plan` and `sync` stop on what Multica would refuse or put back another way:

- A workflow lists `backlog` and `todo` first, and `blocked`, `done` and `cancelled` last.
- Backlog, Done and Cancelled hand nothing off, so their `handoff` is `none`.
- Some workflow has a `todo`, a `done` and a `cancelled` column.
- A step's text is at most 8000 characters, and an agent's description at most 255.
- No custom column takes a built-in status's name, or another column's.

## Benchmarking

`10xagents bench` reads the workspace's agents and issues, and each issue's runs, timeline and comments, and writes nothing. A request is an issue a person created with no parent, together with its sub-issues. The connector reports the Outcome, Review and Cost and time metrics of the catalogue, and the Claude Code collector in `10xagents` reports the Context ones.

The review metrics need to know which statuses are review steps. The defaults are `quality_assurance` and `plan_review`, so a setup with Ultracode's `part` workflow passes its columns too:

```bash
npx 10xagents bench --review-step quality_assurance --review-step part_quality_assurance --plan-step plan_review --plan-step part_plan_review
```

The verdict metrics, like `first-verdicts` and `fix-answers`, read `VERDICT:` comments with a findings ledger, which an older squad protocol wrote. In a window without them, they're `n/a`.

A `multica` CLI from before 20 August 2026 has no `issue timeline`, so the connector then reads each timeline from the server, with the address and token in the profile's config. The token travels in a header, never on a command line.

## Library

The package exports the connector as `connector` and as its default export, and `createConnector(options)` for one that reads another environment. It also exports the helpers `10xagents` doesn't need, like `columnNames`, `mergeWorkflows`, `findMultica`, `listProfiles` and `MULTICA_METRICS`.
