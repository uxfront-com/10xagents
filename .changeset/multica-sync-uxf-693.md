---
"10xagents": minor
"@10xagents/connector-multica": minor
---

Add `10xagents plan` and `10xagents sync`, and the Multica connector's sync. `plan` reads the target's workspace and lists what differs: each agent's instructions and settings, the skills under `skills/` and `targets/<slug>/skills/`, the squad, the Default workflow and the Agent context. `sync` applies only what differs, after you confirm or with `--yes`, then checks again and exits 1 on anything left. Both take `--profile`, `--workspace` and `--diff`, and `sync` takes `--dry-run`. A `!` line names what only a person can set up, like a missing agent or a disabled skill, and makes the command exit 1. A target's workflows merge into one Multica workflow: the first keeps its column names, and every later one's custom columns are prefixed with the workflow's name, like `Part Planning`. The connector also checks what Multica would refuse before it reads anything: a step over 8000 characters, a description over 255, fixed columns out of place, a skill whose `SKILL.md` names another skill, a squad with no instructions, and two workflows that disagree about a shared column.

The `Connector` contract grows to match: `pull` takes `PullOptions`, `apply` can return the changes that failed, a `Change` can be a `note` and carry the connector's own `data`, and a connector can declare `validate`, and `place`, which names where `pull` read so `sync` confirms that workspace and re-checks it through the same profile. `RenderedSetup` now lists the target's `skills`.
