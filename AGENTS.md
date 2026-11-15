# AGENTS.md

This monorepo holds 10xagents, a generic agent harness. A setup describes templates, traits, agents and workflows in YAML and Markdown. The `10xagents` CLI validates it and builds the prompts, and connectors sync it to a platform and benchmark it.

## The repository

| Path                         | Package                        | What it is                                                                                                   |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `packages/cli`               | `10xagents`                    | The CLI (bin `10xagents`), the schemas, the renderer and the connector contract.                             |
| `packages/connector-multica` | `@10xagents/connector-multica` | The Multica connector: sync and bench. It imports only types from `10xagents`, as a peer dependency.         |
| `setups/`                    | inside `10xagents`             | The example setups. The `10xagents` build copies them into `packages/cli/setups`, so the package ships them. |

`10xagents` never depends on a connector, so the workspace graph has no cycle. The root depends on both packages, so `pnpm exec 10xagents` works from the root.

## Commands

Run them from the root:

```bash
pnpm install --frozen-lockfile
pnpm build                       # tsdown in each package, then copies setups/ into packages/cli
pnpm exec 10xagents --help       # after pnpm build: the committed bin runs dist/cli.mjs
pnpm test                        # Vitest, in each package that has tests
pnpm check-types                 # tsc, in each package
pnpm lint                        # oxlint, type-aware (pnpm lint:fix to fix what it can)
pnpm format:check                # oxfmt (pnpm format to write the fixes)
```

Everything needs Node 24 or later, and pnpm at the `packageManager` version in `package.json`. A change is done when it passes what CI runs: `pnpm format:check`, `pnpm lint`, `pnpm check-types`, `pnpm test`, `pnpm build` and `pnpm exec 10xagents --help`.

Some things catch people out:

- `packages/cli/bin/10xagents.mjs` is committed and only imports `../dist/cli.mjs`. pnpm links a bin only if its file exists at install time, so the bin can't live in `dist/`. Run `pnpm build` before you run the CLI.
- `packages/cli/setups` is a build output, and Git ignores it. Edit `setups/` at the root.
- `pnpm format:check` covers Markdown, JSON and YAML too, so format every file you touch.
- `pnpm changeset` is interactive. Outside a terminal, write the changeset by hand (see [Changesets](#changesets)).

The code is TypeScript 7, strict, with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`, so types come in with `import type`. oxlint and oxfmt replace ESLint and Prettier, with the `@uxfront/oxlint-config` and `@uxfront/oxfmt-config` presets: 100 columns, double quotes, semicolons, trailing commas and sorted imports.

## Rules

- `.github/workflows/release.yml` is the only job that releases. On a merge to `main` with pending changesets, it opens the `chore: release packages` pull request, and only the owner merges it. That merge publishes to npm through a trusted publisher, with no token. Never add another publish or deploy job, and never edit a `version` field or a `CHANGELOG.md` by hand.
- In workflows, pin every action to a full commit SHA, and keep `permissions` at `contents: read`. Only the release job gets more, and only what it needs.
- The repository is private, but the packages and their READMEs are public on npm, and so is everything under `setups/`. Write setups public-safe: no names, private URLs, secrets or details of one workspace.
- Tests never read a real platform. A test that needs a Multica profile uses a fake one.

## Commits, pull requests and changesets

Pull requests are squash-merged, so the title becomes the commit. Write it in [Conventional Commits](https://www.conventionalcommits.org), with the scope `cli`, `connector-multica` or `ultracode`. Leave the scope out for a change across packages, and use the `ci` type for workflows:

```text
feat(cli): validate a setup's agents before building the prompts
fix(connector-multica): keep the squad leader when a target renames it
ci: run the tests on Node 24
```

Pull requests follow `.github/PULL_REQUEST_TEMPLATE.md`. **What changed** is prose: the problem, the change and how you checked it. Only tick the checklist items you ran.

### Changesets

Write `.changeset/<branch-slug>.md` with one line per changed package, then one paragraph for the people who install it:

```md
---
"10xagents": minor
---

Add `10xagents validate`, which checks every agent, template and workflow of a setup and prints each error with its file and line.
```

A change under `setups/` is a change to `10xagents`, since the package bundles the setups. Both packages are still 0.x, so a new feature or a breaking change is a `minor`, and a fix is a `patch`. A breaking change ends its summary with a `**Breaking:**` sentence that says what to change. A `major` is the owner's call.

Changesets and commits never mention ticket keys, customer names, private URLs or internal notes.
