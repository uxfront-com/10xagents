---
"10xagents": minor
---

Add Ultracode, the bundled setup that `10xagents init` extends by default. It's a squad of seven agents (Dispatcher, Planner, Designer, Builder, QA, Writer and Ops) that takes a request from triage through planning, building and review on one workflow, `request`. The agents' own text sits in each agent's `sections`, the rules every run needs are global traits, and each column with an agent has its step. The `example` target lists every agent, sets `vars.owner`, and carries a skeleton `workspace` skill to fill in with your repositories and conventions. A setup that extends `ultracode` changes a step or a global trait with an override.
