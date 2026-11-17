# @10xagents/connector-multica

## 0.2.1

### Patch Changes

- Updated dependencies [797226e]
  - 10xagents@0.4.0

## 0.2.0

### Minor Changes

- 53711e6: A workflow can set a `prefix`, the text a connector that merges workflows puts before a later workflow's column names in place of its id. With `prefix: In Parts /`, the Multica connector names a later workflow's `planning` column In Parts / Planning, where it would otherwise be Part Planning. A `prefix` can't be empty or start or end with a space. To rename a live workspace's columns, rename each status with `multica issue-status update` before you sync, so it keeps its key and its issues.

### Patch Changes

- e8e3e77: The CLI now asks its questions on standard error, so standard output carries only the command's output. Before, when several Multica profiles were logged in, `10xagents bench --format json > bench.json` wrote the profile question into the JSON file, and you never saw it. The numbered list of profiles is now part of the question, so it goes to standard error with it.
- Updated dependencies [53711e6]
- Updated dependencies [e8e3e77]
- Updated dependencies [e8e3e77]
  - 10xagents@0.3.0

## 0.1.1

### Patch Changes

- 560c8a0: `10xagents` now bundles `starter`, a lead, a builder and a reviewer on one `request` workflow, in place of Ultracode, and `init` extends `starter` by default. The `@10xagents/connector-multica` README's examples use the starter.

  **Breaking:** the bundled setup `ultracode` is gone, so `extends: ["ultracode"]` and `--from ultracode` fail. Extend `starter`, or a setup of your own.

- Updated dependencies [560c8a0]
  - 10xagents@0.2.0

## 0.1.0

### Minor Changes

- 5ead209: Add `10xagents bench`, which measures how a setup works on its platform over a window, and shows every metric it can't measure as `n/a`, never as 0. It reports the metrics of a shared catalogue (`METRICS`), in four groups: outcome, review, cost and time, and context. The Multica connector measures requests, from their first run to Done, the time each seat's runs wait and run, what they cost, why they fail, QA's review cycles and the old setup's verdicts. The Claude Code collector (`claudeCodeCollector`) reads the transcripts in `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects`, for the context at a run's start, compactions, subagents, skill loads and the tool output that fills the context. `bench` takes `--since` and `--until`, as days back or a local date and time, `--cutover`, which splits requests into `before`, `across` and `after`, `--compare <hashA> <hashB>`, `--review-step` and `--plan-step` (both repeatable), `--profile` and `--format json`, whose rows hold counts, times and costs, never titles or comment text. It reads only the target's `id`, `workspace` and `connector`, so a setup with one `target.yaml` is enough.

  `sync` now appends `{ target, setupHash, sources, time }` to `sync-log.jsonl` after it applies changes, so `bench --compare` can tell which setup was live when each run started. The `Connector` contract changes with it: `bench` takes a `BenchQuery` with the window, a `BenchSplit` and the review and plan steps, and returns a `BenchResult` with rows and notes beside the metrics, a connector can name its agents' Claude Code folders with `runFolders`, and the library exports `runCli` to run the command line from code.

- 8dadd15: Add `10xagents validate` and `10xagents build`. `validate` checks a setup's agents, templates, traits, workflows and targets, and prints each error as `<file>: <field>: <message>`. `build --target <slug>` renders each agent's prompt, each workflow's steps, the shared context and the squad into `dist/`, and gives the same bytes for the same setup. `connectors` lists the installed connectors and what each one can do. `init`, `install`, `plan`, `sync` and `bench` are listed, and exit 1 until a later release adds them.

  The package also exports the `Connector` contract, the loader and the renderer. `@10xagents/connector-multica` now exports its connector with Multica's capabilities, so `build` renders for Multica: its sync comes in a later release.

- 579a717: Add `10xagents plan` and `10xagents sync`, and the Multica connector's sync. `plan` reads the target's workspace and lists what differs: each agent's instructions and settings, the skills under `skills/` and `targets/<slug>/skills/`, the squad, the Default workflow and the Agent context. `sync` applies only what differs, after you confirm or with `--yes`, then checks again and exits 1 on anything left. Both take `--profile`, `--workspace` and `--diff`, and `sync` takes `--dry-run`. A `!` line names what only a person can set up, like a missing agent or a disabled skill, and makes the command exit 1. A target's workflows merge into one Multica workflow: the first keeps its column names, and every later one's custom columns are prefixed with the workflow's name, like `Part Planning`. The connector also checks what Multica would refuse before it reads anything: a step over 8000 characters, a description over 255, fixed columns out of place, a skill whose `SKILL.md` names another skill, a squad with no instructions, and two workflows that disagree about a shared column.

  The `Connector` contract grows to match: `pull` takes `PullOptions`, `apply` can return the changes that failed, a `Change` can be a `note` and carry the connector's own `data`, and a connector can declare `validate`, and `place`, which names where `pull` read so `sync` confirms that workspace and re-checks it through the same profile. `RenderedSetup` now lists the target's `skills`.

- dfa7e8f: Start `10xagents` and `@10xagents/connector-multica`. The `10xagents` command prints its help and version, and the package bundles the setups from the repository's `setups/` folder. The connector exports only its `platform` name for now.

### Patch Changes

- da37eec: Add a README to each package. The `10xagents` README covers every command and its flags, including the `--review-step` and `--plan-step` a setup with Ultracode's `part` workflow passes to `bench`, and Ultracode gets a README of its own: its seats, how the work moves on the `request` and `part` workflows, what keeps it cheap and how to measure it. The `@10xagents/connector-multica` README covers what it syncs, how it merges a target's workflows into Multica's Default workflow, what it leaves to you and how it benchmarks.
- Updated dependencies [5ead209]
- Updated dependencies [8dadd15]
- Updated dependencies [579a717]
- Updated dependencies [da37eec]
- Updated dependencies [1bafe37]
- Updated dependencies [dfa7e8f]
- Updated dependencies [9190f56]
- Updated dependencies [b98d332]
  - 10xagents@0.1.0
