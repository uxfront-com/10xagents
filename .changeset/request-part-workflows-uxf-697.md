---
"10xagents": minor
---

Ultracode now runs on two workflows: `request` for an issue with no parent, and `part` for a sub-issue. `part` has its own Planning, Plan Review, Plan Approval, In Parts and Quality Assurance steps, and shares the built-in columns with `request`. On Multica, its columns become `Part Planning`, `Part Plan Review` and so on. A new global trait tells every agent which column a sub-issue moves to, and the Dispatcher's `select-workflow` trait names the column each workflow starts at. The `request` steps and the other global traits don't change.

**Breaking:** the Agent context and the Dispatcher now name the `part` workflow's columns, so a target that extends Ultracode must list `workflows: [request, part]`. A target that lists only `request` fails `validate`.
