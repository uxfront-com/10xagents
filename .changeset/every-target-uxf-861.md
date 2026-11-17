---
"10xagents": minor
---

`plan` and `sync` now go through every target of the setup when `--target` is left out: the targets in the setup's own `targets/` folder, in slug order, without the ones from the setups it extends. Each target starts with a `Target <slug> (1 of 2)` line, and a target that's up to date, skipped or failed no longer stops the ones after it. `--workspace` now needs `--target` when the setup has two or more targets. `validateSetup` with a `target` now checks only that target's own templates, beside the setup's. **Breaking:** a setup whose config sets `target` now gets all its own targets from `plan` and `sync`, so pass `--target` to sync one.
