---
"10xagents": minor
"@10xagents/connector-multica": minor
---

Add `10xagents validate` and `10xagents build`. `validate` checks a setup's agents, templates, traits, workflows and targets, and prints each error as `<file>: <field>: <message>`. `build --target <slug>` renders each agent's prompt, each workflow's steps, the shared context and the squad into `dist/`, and gives the same bytes for the same setup. `connectors` lists the installed connectors and what each one can do. `init`, `install`, `plan`, `sync` and `bench` are listed, and exit 1 until a later release adds them.

The package also exports the `Connector` contract, the loader and the renderer. `@10xagents/connector-multica` now exports its connector with Multica's capabilities, so `build` renders for Multica: its sync comes in a later release.
