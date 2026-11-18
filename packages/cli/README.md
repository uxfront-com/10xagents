# 10xagents

The `10xagents` CLI keeps a team of AI agents in one place you can review: a setup of agents, templates, traits and workflows in YAML and Markdown. It checks the setup, renders every prompt, syncs it to a platform through a connector and measures how the team does there.

It ships the bundled setup `starter`, a lead, a builder and a reviewer on one workflow, so `10xagents init` gives you a working team to start from. The [repository's README](https://github.com/uxfront-com/10xagents#readme) explains the model: setups, layering, templates, the connector contract and the metric catalogue.

## Install

You'll need Node 24 or later. Install the CLI with the connector for your platform, since the CLI loads connector `<id>` from the package `@10xagents/connector-<id>`:

```bash
npm install --save-dev 10xagents @10xagents/connector-multica
```

Or run it without adding a dependency:

```bash
pnpm dlx --package 10xagents --package @10xagents/connector-multica 10xagents --help
```

## Usage

```bash
npx 10xagents init        # a setup in .10xagents/ that extends the starter
npx 10xagents validate    # checks it
npx 10xagents build       # renders the prompts into dist/
npx 10xagents plan        # compares it with the live workspace
npx 10xagents sync        # applies the difference, after you confirm
npx 10xagents bench       # measures the last 30 days
```

## Commands

Every command reads the setup in `.10xagents` unless you pass `--dir`, which takes a folder, a bundled setup's name like `starter`, or `github:<owner>/<repo>[/<subdir>][#<ref>]`. A command that works on one target, like `build`, takes `--target`, then the config's `target`, then the setup's only target, and otherwise stops and lists the targets to choose from. `plan` and `sync` go through every target of the setup instead, as [plan](#plan) says.

When something's wrong, a command prints one line per error, as `<file>: <field>: <message>`, then the count, and exits 1. A file fetched from GitHub shows as its source at its commit, rather than a path into the cache.

| Command      | What it does                                                                |
| ------------ | --------------------------------------------------------------------------- |
| `init`       | Writes a new setup that extends another, with a starter target and a lock   |
| `install`    | Pins every GitHub source to a commit in `10xagents.lock`                    |
| `validate`   | Checks the schemas, every reference and every workflow's graph              |
| `build`      | Renders a target's prompts, workflows, shared context and squad to a folder |
| `plan`       | Shows what differs between a target and its live workspace                  |
| `sync`       | Applies that difference after you confirm, and logs the setup's hash        |
| `bench`      | Measures how the team did over a window                                     |
| `connectors` | Lists the installed connectors and what each can do                         |

### init

`init` writes `10xagents.config.ts`, a starter target and `10xagents.lock` into a new local folder. The config extends `--from` and is a plain object with no import, so it loads where `10xagents` isn't installed. The starter target copies the first target of the setup it extends, under the new slug, without that target's overrides and files.

```bash
npx 10xagents init --from starter --target my-team
```

| Flag       | Default         | What it sets                                                              |
| ---------- | --------------- | ------------------------------------------------------------------------- |
| `--dir`    | `.10xagents`    | The new setup's folder                                                    |
| `--from`   | `starter`       | The setup to extend: a folder, a bundled setup's name, or `github:…`      |
| `--target` | the folder name | The starter target's slug: the current folder's name as a slug, or `main` |

It stops, and writes nothing, when the folder already has a config or a target with that slug.

### install

`install` resolves every GitHub source the setup reaches and writes each one's commit and file hash to `10xagents.lock`. A source already in the lock keeps its commit, so running it again changes nothing.

| Flag       | Default      | What it does                                  |
| ---------- | ------------ | --------------------------------------------- |
| `--dir`    | `.10xagents` | The setup's folder                            |
| `--update` | off          | Moves every source to its ref's latest commit |

A source written with a full commit SHA keeps that commit. For a private repository, set `GITHUB_TOKEN` or `GH_TOKEN`, or sign in with `gh auth login`. The CLI reads the gh CLI's token only after GitHub refuses a request, with no token or with one it rejects as invalid or expired.

### validate

`validate` checks every file of the setup against its schema, every reference (traits, params, vars, workflows, slots and templates), every override and every workflow's graph, and prints `Valid: 3 agents, 1 workflows, 2 targets.` when nothing's wrong.

| Flag       | Default      | What it does                                                  |
| ---------- | ------------ | ------------------------------------------------------------- |
| `--dir`    | `.10xagents` | The setup                                                     |
| `--target` | every target | Checks only this target: its references and its own templates |

### build

`build` renders one target and writes what a connector would sync, so you can read the prompts or diff them in review:

- `agents/<id>.md`: the agent's settings as frontmatter, then its prompt.
- `workflows/<id>.json`: the columns, with each step's rendered text.
- `shared-context.md`: the global traits, when the connector's platform has a shared context.
- `squad.md`: the squad's name, leader and member roles as frontmatter, then its instructions.

The same setup always gives the same bytes. `build` loads the target's connector, so the column names and the shared context match what `sync` would write, and runs the connector's own checks.

| Flag       | Default      | What it does                                          |
| ---------- | ------------ | ----------------------------------------------------- |
| `--dir`    | `.10xagents` | The setup                                             |
| `--target` | (see above)  | The target to render                                  |
| `--out`    | `dist`       | Where to write. It must not be the setup's own folder |

`build` overwrites the files it writes and never deletes anything, so use a fresh folder when a target has lost an agent or a workflow.

### plan

`plan` reads the target's live workspace through its connector, and prints each change that would bring it in line, or `Up to date.`. Changes only a person can make, like creating an agent the workspace doesn't have yet, print first, and `plan` exits 1 while there are any.

Without `--target`, `plan` goes through every target of the setup's own, the ones in its own `targets/` folder, in slug order. A target from a setup it extends, like the starter's `example`, is left out, and `--target example` still reaches it. The config's `target` doesn't narrow `plan`, and counts only for a setup with no targets of its own, which picks one target as `build` does.

With two or more targets, each one starts with `Target web (1 of 2)`, after a blank line from the one before. An error in a target's own templates, its render, its connector or its workspace prints under that target, and the next target still runs. `plan` exits 1 when any target fails or needs a person to act. An error in a file of the setup, like a `target.yaml` that doesn't load, stops `plan` before the first target.

| Flag          | Default                   | What it does                                                                     |
| ------------- | ------------------------- | -------------------------------------------------------------------------------- |
| `--dir`       | `.10xagents`              | The setup                                                                        |
| `--target`    | every target of the setup | Compares only this target                                                        |
| `--profile`   | the connector's choice    | The platform profile or account to use, for every target                         |
| `--workspace` | the target's `workspace`  | Another workspace to compare with. With two or more targets, it needs `--target` |
| `--diff`      | off                       | Prints each text change as a unified diff                                        |

### sync

`sync` plans as `plan` does, asks `Apply 3 changes to My workspace? [y/N]` and applies them. It then reads the workspace again, through the same profile, and says whether anything still differs.

| Flag        | Default | What it does                       |
| ----------- | ------- | ---------------------------------- |
| `--dry-run` | off     | Shows what would change, and stops |
| `--yes`     | off     | Applies without asking             |

It also takes every flag of `plan`, and goes through the same targets, one after another, asking once for each. A target that's up to date, skipped or failed doesn't stop the ones after it. `sync` exits 1 when any target failed, still differs or needs a person to act. Without a terminal to ask in, pass `--yes` to apply or `--dry-run` to only look.

Each target that a sync changes appends a line to `sync-log.jsonl`: the target, the hash of everything it rendered, the setup's layers and the time. It goes in the setup's folder, or in `./.10xagents` for a setup from GitHub or a bundled name. Commit it, since `bench --compare` reads it to tell which setup was live when each run started. Local layers are written relative to the setup, so the log holds no paths of your machine.

### bench

`bench` measures every metric in the catalogue that the target's connector and the collectors support, over a window, and prints one table per group, with `n/a` for the rest:

```bash
npx 10xagents bench --since 2026-10-25T12:00 --cutover 2026-11-08T12:00 --until 2026-11-22T12:00
```

| Flag            | Default                | What it does                                                                                          |
| --------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `--dir`         | `.10xagents`           | The setup's folder on this machine. `bench` reads only the target's `id`, `workspace` and `connector` |
| `--target`      | the only target        | The target to measure. `bench` doesn't read the config's `target`                                     |
| `--since`       | `30`                   | Where the window starts: a number of days back, or a local date and time                              |
| `--until`       | now                    | Where the window ends, the same way                                                                   |
| `--cutover`     | none                   | Splits the window at this moment, into `before`, `across` and `after`                                 |
| `--compare`     | none                   | Splits it by two setup hashes from `sync-log.jsonl`: `--compare <hashA> <hashB>`                      |
| `--review-step` | `quality_assurance`    | A status key where reviewers review delivered work. Repeat it for several                             |
| `--plan-step`   | `plan_review`          | A status key where reviewers review plans. Repeat it for several                                      |
| `--profile`     | the connector's choice | The platform profile or account to use                                                                |
| `--format`      | `text`                 | `text`, or `json` for the full report with each source's rows                                         |

A date and time without a zone is local time, and a date alone is local midnight.

With `--cutover`, a request that started before the cutover and was done or stopped by it goes to `before`, judged at the cutover. One still open there goes to `across`, judged at `--until`, since both setups worked on it, and one that started after it goes to `after`. Compare `before` with `after`, over windows of the same length on each side.

With `--compare`, each run and request counts under the setup hash that was live for the target when it started, and the rest are left out. A unique prefix of a hash is enough.

`--review-step` and `--plan-step` replace their default when you give them, so list every step you mean. A setup whose second workflow has review columns of its own, like a `part` workflow, which Multica keys from their names, passes both workflows' steps:

```bash
npx 10xagents bench --review-step quality_assurance --review-step part_quality_assurance --plan-step plan_review --plan-step part_plan_review
```

The Claude Code collector reads the transcripts in `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects`, so run `bench` on the machine that runs the agents to get the context metrics. A collector that fails leaves its metrics `n/a` with a note, and the connector's results stand. With `--format json`, the report goes to standard output alone and progress goes to standard error. The rows hold counts, times and costs, never titles, prompts or comment text.

### connectors

`connectors` lists every connector installed where the CLI can load it, with its capabilities:

```text
multica: sharedContext: yes, workflowPerIssue: no, squads: yes, skills: yes, metrics: requests-touched, requests, …
```

## Library

The package also exports what the CLI is built from, for connectors and tools: the connector contract's types (`Connector`, `Capabilities`, `Change`, `BenchQuery` and the rest), the renderer (`openSetup`, `renderTarget`, `validateSetup`), the metric catalogue (`METRICS`) and `defineConfig`. A connector imports the contract with `import type` and takes `10xagents` as a peer dependency, as `@10xagents/connector-multica` does.

```ts
import type { Connector } from "10xagents";
```
