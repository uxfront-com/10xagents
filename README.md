# 10xagents

10xagents lets you describe a team of AI agents once, in YAML and Markdown, and keep the platform they run on in line with it. Think of prompts edited by hand in a web app until nobody knows which copy is current, two workspaces whose instructions differ in one paragraph nobody remembers writing, or a change to a prompt you can't tell paid off.

A setup holds the agents, the templates their prompts render from, the traits they share and the workflows that move work between them. The `10xagents` CLI checks a setup and renders every prompt, and a connector syncs it to a platform and measures how the team does there. [Multica](https://multica.ai) is the first connector, and a starter setup of three agents comes bundled to start from.

| Package                                                      | What it is                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| [`10xagents`](packages/cli)                                  | The CLI (bin `10xagents`), the schemas, the renderer, the built-in `default` template, the connector contract and `bench` |
| [`@10xagents/connector-multica`](packages/connector-multica) | The Multica connector: `plan`, `sync` and `bench` against a Multica workspace                                             |
| [`setups/starter`](setups/starter)                           | The starter, bundled inside `10xagents` as the setup named `starter`                                                      |

## Install

You'll need Node 24 or later. Install the CLI with the connector for your platform:

```bash
npm install --save-dev 10xagents @10xagents/connector-multica
```

To run it without adding a dependency, give `pnpm dlx` both packages:

```bash
pnpm dlx --package 10xagents --package @10xagents/connector-multica 10xagents --help
```

The connector has to be installed beside the CLI, since `10xagents` finds connector `<id>` as the package `@10xagents/connector-<id>`.

## Usage

Start a setup that extends the starter, check it and look at what it renders:

```bash
npx 10xagents init        # writes .10xagents/ with a config, a starter target and a lock
npx 10xagents validate    # Valid: 3 agents, 1 workflows, 2 targets.
npx 10xagents build       # renders the starter target into dist/
```

`init` names the starter target after the current folder. Set `vars.owner` in its `targets/<slug>/target.yaml` to the workspace member who owns the work, then compare the setup with your workspace and sync it:

```bash
npx 10xagents plan --diff   # what would change, with each text's diff
npx 10xagents sync          # asks before it applies anything
npx 10xagents bench         # how the team did over the last 30 days
```

Every command reads `.10xagents` unless you pass `--dir`. The [CLI's README](packages/cli/README.md) covers each command and its flags.

## The model

Let's start with what a setup is made of. Each piece is a file, and each has an id: the file or folder name.

| Piece        | File                               | What it does                                                                                      |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| Template     | `templates/<id>.md`                | The shape of a prompt: named slots, each with an optional heading, and where the global traits go |
| Agent        | `agents/<id>.yaml`                 | One agent: its name, model, concurrency, skills, squad role and the text of each slot             |
| Opt-in trait | `traits/<id>.md`                   | A piece of text that fills one slot, in the agents that list it, with optional params             |
| Global trait | `traits/global/<id>.md`            | A piece of text every agent of every target gets, in file-name order                              |
| Workflow     | `workflows/<id>/workflow.yaml`     | The columns work moves through, who each one hands off to, and where it moves next                |
| Step         | `workflows/<id>/steps/<column>.md` | The instructions for one column that hands off to an agent                                        |
| Skill        | `skills/<name>/SKILL.md`           | A skill every target gets, with the rest of its folder                                            |
| Squad        | `squad.md`                         | The squad's instructions                                                                          |
| Target       | `targets/<slug>/target.yaml`       | One place to sync to: its connector, workflows, agents, vars, squad and overrides                 |
| Config       | `10xagents.config.ts`              | The setups this one extends, and the target to use when `--target` is left out                    |

A target folder can also hold `templates/`, `traits/`, `traits/global/`, `skills/` and a `squad.md` of its own, which only that target gets. A full setup looks like this:

```text
my-setup/
  10xagents.config.ts
  10xagents.lock
  squad.md
  templates/default.md         # optional: replaces the built-in default
  traits/
    global/01-owner.md
    plan-from-code.md
  agents/planner.yaml
  workflows/
    request/
      workflow.yaml
      steps/planning.md
  skills/workspace/SKILL.md
  targets/
    example/
      target.yaml
      overrides/planning.md
```

### Agents

An agent file is YAML, and its `id` matches its file name:

```yaml
id: planner
name: Planner
description: Turns a chosen piece of work into a plan someone else can build and verify.
model:
  id: claude-opus-5-5
  thinking: high
concurrency: 2
skills: [workspace]
squad:
  role: Turns chosen work into a plan someone else can build and verify.
sections:
  role: You're the Planner.
  handback: A plan a stranger could pick up cold.
traits:
  - plan-from-code
  - { id: tone, params: { formal: false } }
```

| Field         | Required | What it holds                                                                     |
| ------------- | -------- | --------------------------------------------------------------------------------- |
| `id`          | yes      | Lower case letters, digits, `-` and `_`, matching the file name                   |
| `name`        | yes      | The agent's display name. The Multica connector matches live agents by it         |
| `description` | yes      | At most 255 characters, counted as code points                                    |
| `model`       | yes      | `id` and `thinking`, passed to the platform as they are                           |
| `concurrency` | yes      | A whole number, 1 or more: how many runs the agent may have at once               |
| `template`    | no       | The template to render with (see [Template resolution](#template-resolution))     |
| `skills`      | no       | The skills to attach. The Multica connector attaches only the ones the target has |
| `squad.role`  | no       | The agent's role in the squad. The default is `member`                            |
| `sections`    | no       | The text of each slot, by slot id                                                 |
| `traits`      | no       | Opt-in traits, as an id or `{ id, params }`                                       |

### Traits

An opt-in trait is Markdown whose frontmatter names the slot it fills and declares its params. An agent that lists it gets its text in that slot, after the agent's own `sections` text and any trait listed before it:

```md
---
section: how-you-work
params:
  formal: boolean
  greeting: { type: string, default: Hello }
---

Open every reply with "{{params.greeting}}".
```

A param's type is `string`, `number` or `boolean`. A param without a default has to be given by every agent that lists the trait.

A global trait has no frontmatter. The setup's global traits come first, then the target's own, each in file-name order, so a numbered prefix like `01-owner.md` sets the order. They're joined with one blank line.

Where the connector's platform has one context every agent reads, like Multica's Agent context, they go there once. Otherwise each prompt gets them where its template puts `{{global}}`, or at its end.

### Workflows

A workflow lists its columns in order, and names the column new work enters at:

```yaml
id: request
entry: todo
columns:
  - { key: backlog, handoff: none }
  - { key: todo, handoff: agent:dispatcher, next: planning }
  - { key: planning, category: started, handoff: agent:planner, next: plan_review, back: todo }
  - { key: plan_review, handoff: agent:qa, next: in_progress, back: planning }
  - { key: in_progress, handoff: none, builders: [builder] }
  - { key: done, handoff: none }
  - { key: cancelled, handoff: none }
```

| Field      | What it holds                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `key`      | The column's id, which steps, moves and references use                                                |
| `name`     | The column's display name, where the connector doesn't name it itself                                 |
| `category` | The platform's category for the column, like Multica's `started`                                      |
| `handoff`  | `agent:<id>` hands the column to an agent, `owner` to the target's owner, and `none` to nobody        |
| `next`     | The column the work moves to when the step is done. Every column that hands off to an agent needs one |
| `back`     | The column the work moves back to                                                                     |
| `builders` | The agents who may build in a column with no handoff. It's metadata, and nothing renders it           |

Every column that hands off to an agent needs its `steps/<key>.md`, and a column with `handoff: none` takes no step.

Beside `id`, `entry` and `columns`, a workflow can set a `prefix`. A connector that merges a target's workflows into one, like Multica's, puts it before a later workflow's column names in place of its id, so `prefix: In Parts /` turns `planning` into In Parts / Planning. A connector that keeps workflows apart ignores it.

### Targets

A target is one place the setup syncs to, like a workspace:

```yaml
id: example
workspace: my-workspace
connector: multica
workflows: [request]
agents: [dispatcher, planner, builder, qa]
vars:
  owner: Sam Lee
squad:
  name: My squad
  leader: dispatcher
overrides:
  workflows.request.steps.planning: { replace: overrides/planning.md }
  traits.global.01-owner: { append: overrides/owner-extra.md }
```

| Field       | What it holds                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `id`        | The target's slug, matching its folder name                                                                    |
| `workspace` | The platform's workspace. The default is the target's `id`                                                     |
| `connector` | The connector's id, like `multica`                                                                             |
| `template`  | The template for every agent that names none                                                                   |
| `workflows` | The workflows the target uses, in order                                                                        |
| `agents`    | The agents the target syncs. Every agent a column hands off to has to be listed                                |
| `vars`      | Values the texts reference as `{{vars.<name>}}`. The Multica connector reads `vars.owner` for `handoff: owner` |
| `squad`     | `name`, `leader` and an optional `instructions` file, which replaces `squad.md`                                |
| `overrides` | Text that replaces or extends a step or a trait for this target only                                           |

An override's key is `workflows.<id>.steps.<column>`, `traits.<id>` or `traits.global.<id>`, and its value is `{ replace: <file> }` or `{ append: <file> }`, with a path from the target's folder that stays inside the setup. `append` adds the file's text after the original, with a blank line between them. Each override must change something that exists, so a typo in a key fails `validate` instead of doing nothing.

### References in text

Steps, traits, sections, templates and the squad's instructions can reference values, which render when the target does:

| Reference                          | Renders                                                        | Works in                                 |
| ---------------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| `{{vars.<name>}}`                  | The target's var                                               | Every text                               |
| `{{workflows.<id>.entry}}`         | The name of the column the workflow starts at                  | Every text                               |
| `{{workflows.<id>.columns.<key>}}` | A column's name, as the connector names it on its platform     | Every text                               |
| `{{agent.<field>}}`                | A field of the agent, like `{{agent.name}}`                    | An agent's sections, traits and template |
| `{{params.<name>}}`                | A param of the opt-in trait                                    | That opt-in trait                        |
| `{{slot:<id>}}`                    | A slot's text, under its heading                               | A template                               |
| `{{global}}`                       | The global traits, or nothing when they go to a shared context | A template                               |

A reference that doesn't resolve is an error, and `validate` reports every one at once with its file and field.

## Sources and layering

A setup can build on others: the starter as it ships, a team's shared setup on GitHub, or a folder beside it. List them under `extends` in `10xagents.config.ts`:

```ts
export default {
  extends: ["starter", "github:my-org/agents/setups/shared#main"],
  target: "example",
};
```

The config is a plain object, so it loads with nothing installed. The CLI reads `10xagents.config.ts`, `.mts`, `.js` or `.mjs`, and `10xagents` exports `defineConfig` if you'd like it typed.

| Source  | Written as                                 | Resolves to                                                          |
| ------- | ------------------------------------------ | -------------------------------------------------------------------- |
| Local   | `./shared`, `../agents` or `/abs/path`     | A folder, from the folder of the config that lists it                |
| Bundled | `starter`                                  | A setup that ships inside `10xagents`                                |
| GitHub  | `github:<owner>/<repo>[/<subdir>][#<ref>]` | A folder of a repository at a branch, tag or commit. `gh:` works too |

`--dir` takes the same sources, and there a relative path needs no `./`. A bare name is the folder of that name when one exists, and the bundled setup otherwise.

The setup itself is the top layer, and each setup it extends sits below it. Of the setups in one `extends`, the last one listed wins. A layer that two others extend keeps its lowest place, so it stays under both. A layer that extends itself, directly or not, is an error, and so is a setup of more than 64 layers.

Layers merge by id:

- **An item replaces the same item below it whole.** Agents, templates, opt-in traits, global traits, targets and skills each resolve in the highest layer that has them.
- **Steps change one at a time.** The highest layer with a `workflow.yaml` owns a workflow. A layer above it with only `workflows/<id>/steps/` replaces those steps and keeps the rest.
- **The squad's instructions** come from the highest layer with a `squad.md`, unless a target has its own.

`10xagents install` pins every GitHub source to a commit in `10xagents.lock`, with a hash of its files, so the same setup renders the same prompts on every machine. `validate`, `build`, `plan` and `sync` on a local setup read GitHub sources only from the lock, and stop with "run 10xagents install" for one that isn't in it. `install --update` moves each source to its ref's latest commit, and a source written with a full commit SHA keeps it. A setup opened straight from GitHub or by a bundled name uses its own lock where it has one, and resolves the rest when it runs.

Fetched sources are cached by commit in `$XDG_CACHE_HOME/10xagents`, or `~/.cache/10xagents`. For a private repository, set `GITHUB_TOKEN`. A relative `extends` inside a setup from GitHub stays in the same repository, at the same commit.

## Template resolution

Every agent's prompt renders from one template. The CLI picks its id in this order:

1. The agent's `template`.
2. The target's `template`.
3. `default`.

It then looks the id up in the target's `templates/<id>.md`, in the setup's `templates/<id>.md` (the highest layer that has it), and in the built-in templates, in that order. So a setup's `templates/default.md` replaces the built-in default, and a target's replaces both.

A template is Markdown whose frontmatter declares its slots, in order:

```md
---
slots:
  role: { heading: Role, required: true }
  notes: {}
---

# {{agent.name}}

{{slot:role}}

{{slot:notes}}

{{global}}
```

A slot's text is the agent's `sections` text for it, then each opt-in trait that fills it, in the order the agent lists them, joined with one blank line. A slot with a heading renders `## <heading>` above its text, and an empty slot renders nothing, heading included. A required slot that renders empty is an error.

Every slot a template declares has to appear in its body, so a slot can't go missing by accident. The body's blocks are separated by blank lines, and a block that renders empty is dropped, so the prompt has no gaps. The rendered prompt has no trailing newline.

## The built-in default template

The built-in `default` template has six slots, in this order:

| Slot              | Heading              | Required |
| ----------------- | -------------------- | -------- |
| `role`            | Role                 | yes      |
| `how-you-work`    | How you work         | no       |
| `boundaries`      | Boundaries           | no       |
| `ask-or-stop`     | When to ask or stop  | no       |
| `before-handback` | Before you hand back | no       |
| `handback`        | What you hand back   | yes      |

Its body is the agent's name as a heading, each slot in turn, then the global traits:

```md
# {{agent.name}}

{{slot:role}}

{{slot:how-you-work}}

{{slot:boundaries}}

{{slot:ask-or-stop}}

{{slot:before-handback}}

{{slot:handback}}

{{global}}
```

## Connector contract

A connector maps the setup onto one platform. The CLI loads connector `<id>` from the package `@10xagents/connector-<id>`, which exports it as `connector` or as its default export. It looks in the `node_modules` above the current folder first, then above the CLI itself, and `10xagents connectors` lists the ones it finds with their capabilities.

A connector is an object of this shape. Its types come from `10xagents`, so a connector imports them with `import type` and needs the CLI only as a peer dependency:

| Member                   | Required | What it does                                                                                                      |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`                     | yes      | The connector's id, which a target's `connector` names                                                            |
| `capabilities`           | yes      | What the platform can do (below)                                                                                  |
| `pull(target, options)`  | yes      | Reads the platform's state for the target, with the `--profile` and `--workspace` given                           |
| `plan(rendered, live)`   | yes      | Compares the rendered setup with that state, and returns the changes                                              |
| `apply(changes)`         | yes      | Makes the changes in order. One that fails doesn't stop the others, and comes back in `failed`                    |
| `validate(rendered)`     | no       | Reports what the platform would refuse, before anything is read. `build`, `plan` and `sync` run it                |
| `place(live)`            | no       | Names where `pull` read from, so `sync` can ask "Apply 3 changes to My workspace?" and check the same place again |
| `columnNames(workflows)` | no       | The platform's name for each column, which `{{workflows.<id>.columns.<key>}}` renders                             |
| `bench(query)`           | no       | Measures the metrics in `capabilities.metrics` over a window                                                      |
| `runFolders`             | no       | A pattern for the Claude Code project folders that hold the platform's runs                                       |

| Capability         | When it's `true`                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `sharedContext`    | The platform has one context every agent reads, so the global traits go there once, not in each prompt |
| `workflowPerIssue` | An issue picks its own workflow, rather than taking its project's                                      |
| `squads`           | The platform has squads, with a leader and member roles                                                |
| `skills`           | The platform attaches skills to agents                                                                 |
| `metrics`          | Not a flag: the ids of the metrics `bench` can report through the connector                            |

Each change `plan` returns has a `kind`, an `id`, a one-line `summary` and, for text, a unified `diff`. A change only a person can make, like creating an agent, is `manual`, and one that's only something to know is a `note`. The CLI prints both before the rest and applies neither, and `plan` and `sync` exit 1 when there's a `manual` one.

The Multica connector starts their summaries with `!` and `·`. `data` carries what `apply` needs, and only the connector reads it.

## Metrics

`10xagents bench` measures how the team did over a window, from two kinds of source: the target's connector, which reads the platform's records, and collectors, which read what the platform can't show. `10xagents` ships one collector, for the Claude Code transcripts on the machine that runs the agents. Every metric in the catalogue below shows in the report, and the ones no source supports show as `n/a`, so two platforms' reports line up row for row.

The window is the last 30 days unless you pass `--since` and `--until`. `--cutover` splits it at the moment you changed the setup, into `before`, `across` and `after`, and `--compare` splits it by the setup hashes that `sync` logs. The [CLI's README](packages/cli/README.md#bench) has every flag.

A share is a ratio from 0 to 1, and a cost is in US dollars at list prices. A p50 is the median.

### Outcome

| Metric                    | Unit  | What it measures                                                             | Reported by |
| ------------------------- | ----- | ---------------------------------------------------------------------------- | ----------- |
| `requests-touched`        | count | Requests a person made that someone worked on in the window                  | Multica     |
| `requests`                | count | Requests whose first run falls in the window                                 | Multica     |
| `requests-done`           | count | Requests that are done: they and every sub-issue closed                      | Multica     |
| `requests-stopped`        | count | Requests cancelled, or sent back to Backlog after they ran                   | Multica     |
| `requests-open`           | count | Requests neither done nor stopped                                            | Multica     |
| `requests-left-out`       | count | Requests touched in the window but not counted, by reason                    | Multica     |
| `lead-time-p50`           | hours | From a done request's first run to done, less the time it sat parked: median | Multica     |
| `lead-time-p90`           | hours | From a done request's first run to done, less the time it sat parked: p90    | Multica     |
| `people-actions-p50`      | count | People's comments, moves, assignments and merges on a done request: median   | Multica     |
| `people-actions-p90`      | count | People's comments, moves, assignments and merges on a done request: p90      | Multica     |
| `waiting-on-people-p50`   | hours | Time a done request waited on people: median                                 | Multica     |
| `waiting-on-people-p90`   | hours | Time a done request waited on people: p90                                    | Multica     |
| `waiting-on-people-share` | ratio | The waiting on people, as a share of the done requests' lead time            | Multica     |

### Review

| Metric                        | Unit  | What it measures                                                        | Reported by |
| ----------------------------- | ----- | ----------------------------------------------------------------------- | ----------- |
| `review-rounds-mean`          | count | Review rounds per done request, on average                              | Multica     |
| `plan-reviews-mean`           | count | Plan reviews per done request, on average                               | Multica     |
| `first-verdicts`              | count | Work issues whose first verdict falls in the window, by result          | Multica     |
| `first-fail-blockers`         | count | Blocking findings on those first FAILs, by why they block               | Multica     |
| `blockers-per-first-fail`     | count | Blocking findings per first FAIL, on average                            | Multica     |
| `first-fails-only-mechanical` | count | First FAILs whose blockers are all mechanical                           | Multica     |
| `blocker-outcomes`            | count | How the blockers on first FAILs ended, by state                         | Multica     |
| `fix-answers`                 | count | The builders' answers to findings in every FIX in the window, by answer | Multica     |
| `issues-by-pass-round`        | count | Work issues by the round of their first PASS                            | Multica     |

### Cost and time

| Metric                       | Unit    | What it measures                                                        | Reported by |
| ---------------------------- | ------- | ----------------------------------------------------------------------- | ----------- |
| `runs-per-request-p50`       | count   | Runs on a done request and its sub-issues: median                       | Multica     |
| `runs-per-request-p90`       | count   | Runs on a done request and its sub-issues: p90                          | Multica     |
| `agent-time-per-request-p50` | hours   | Running time of a done request's runs: median                           | Multica     |
| `agent-time-per-request-p90` | hours   | Running time of a done request's runs: p90                              | Multica     |
| `cost-per-request-p50`       | usd     | Cost of a done request whose cost is known: median                      | Multica     |
| `cost-per-request-p90`       | usd     | Cost of a done request whose cost is known: p90                         | Multica     |
| `requests-cost-known`        | count   | Done requests whose cost is known                                       | Multica     |
| `requests-cost`              | usd     | The known cost of every request counted                                 | Multica     |
| `requests-failed-runs`       | count   | Failed runs on every request counted                                    | Multica     |
| `runs`                       | count   | Runs created in the window, by seat, and by seat and what started them  | Multica     |
| `failed-runs`                | count   | Failed runs, by seat, and by seat and what started them                 | Multica     |
| `queue-wait-p50`             | minutes | Time a run waited for a slot: median                                    | Multica     |
| `queue-wait-p90`             | minutes | Time a run waited for a slot: p90                                       | Multica     |
| `run-time-p50`               | minutes | Time a run ran: median                                                  | Multica     |
| `run-time-p90`               | minutes | Time a run ran: p90                                                     | Multica     |
| `queue-hours`                | hours   | Time runs waited for a slot, in all                                     | Multica     |
| `run-hours`                  | hours   | Time runs ran, in all                                                   | Multica     |
| `run-cost-p50`               | usd     | Cost of a run that started, where it's known: median                    | Multica     |
| `run-cost`                   | usd     | Known cost of the runs that started, in all                             | Multica     |
| `failure-causes`             | count   | Failed runs, by seat and reason                                         | Multica     |
| `peak-concurrent-runs`       | count   | The most runs of one seat running at once                               | Multica     |
| `review-cycles`              | count   | Review cycles, from a delivery to its verdict, that start in the window | Multica     |
| `review-cycles-with-wakeup`  | count   | Review cycles that needed a CI wakeup                                   | Multica     |
| `review-cycle-p50`           | minutes | A review cycle's time, by part: total, queue, work and CI gap: median   | Multica     |
| `review-cycle-p90`           | minutes | A review cycle's time, by part: total, queue, work and CI gap: p90      | Multica     |
| `review-cycle-share`         | ratio   | Each part of the review cycles' time, as a share of their total         | Multica     |

### Context

| Metric                        | Unit   | What it measures                                                               | Reported by |
| ----------------------------- | ------ | ------------------------------------------------------------------------------ | ----------- |
| `sessions`                    | count  | Agent sessions with a run that starts in the window                            | Claude Code |
| `session-runs`                | count  | Runs that start in the window, by seat                                         | Claude Code |
| `calls-per-run-p50`           | count  | Model calls per run: median                                                    | Claude Code |
| `calls-per-run-p90`           | count  | Model calls per run: p90                                                       | Claude Code |
| `context-at-start-p50`        | tokens | Context size at a run's first call: median                                     | Claude Code |
| `context-at-start-p90`        | tokens | Context size at a run's first call: p90                                        | Claude Code |
| `context-peak`                | tokens | The largest context of any call in a run                                       | Claude Code |
| `compactions`                 | count  | Compactions in the runs, by seat                                               | Claude Code |
| `cache-write-1h-share`        | ratio  | The share of cache writes with the one-hour lifetime                           | Claude Code |
| `session-cost`                | usd    | Cost of the runs, subagents included, from the transcripts                     | Claude Code |
| `subagent-cost-share`         | ratio  | The subagents' share of that cost                                              | Claude Code |
| `forks`                       | count  | Subagents started as forks of the session                                      | Claude Code |
| `agents-md-reads-per-run`     | count  | Reads of an AGENTS.md per run                                                  | Claude Code |
| `skill-loads-per-run`         | count  | Skill loads per run                                                            | Claude Code |
| `tool-output-calls`           | count  | Tool results that entered the context, by tool                                 | Claude Code |
| `tool-output-tokens`          | tokens | Tokens of tool output that entered the context, by tool (4 characters a token) | Claude Code |
| `tool-output-tokens-per-call` | tokens | Tokens of tool output per call, by tool                                        | Claude Code |
| `tool-output-largest`         | tokens | The largest tool output, by tool                                               | Claude Code |
| `tool-output-images`          | count  | Images in tool output, by tool                                                 | Claude Code |

A connector or collector that reports an id the catalogue doesn't know gets a note in the report, rather than a row.

## Developing

[`AGENTS.md`](AGENTS.md) has the commands, the rules for commits and changesets, and what catches people out.
