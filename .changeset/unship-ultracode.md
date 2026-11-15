---
"10xagents": minor
"@10xagents/connector-multica": patch
---

`10xagents` now bundles `starter`, a lead, a builder and a reviewer on one `request` workflow, in place of Ultracode, and `init` extends `starter` by default. The `@10xagents/connector-multica` README's examples use the starter.

**Breaking:** the bundled setup `ultracode` is gone, so `extends: ["ultracode"]` and `--from ultracode` fail. Extend `starter`, or a setup of your own.
