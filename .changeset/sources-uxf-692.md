---
"10xagents": minor
---

Add setup sources and layering. A setup's `10xagents.config.ts` can now `extend` other setups: a local path, a bundled setup's name, or `github:<owner>/<repo>[/<subdir>][#<ref>]` (`gh:` for short). Every template, trait, agent, workflow, step, target and skill resolves by id, the setup's own first and then the extended setups, the last listed first, and an item with the same id replaces the extended one whole. A workflow folder with only `steps/` changes those steps of an extended workflow.

`10xagents install` pins each GitHub source to a commit and a content hash in `10xagents.lock`, and `install --update` moves each to its ref's latest commit. `validate` and `build` use the locked commit, and fail with a hint to run `install` when a source isn't locked. Fetched sources are cached by commit under `~/.cache/10xagents`, and `GITHUB_TOKEN` reaches private repositories. `10xagents init [--from <source>]` writes a config with no import, so it loads where `10xagents` isn't installed, plus a starter target and the lock. `--dir` now takes any source, and prints the commit a GitHub ref resolves to.
