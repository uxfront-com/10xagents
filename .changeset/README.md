# Changesets

Every change to a package comes with a changeset, and so does every change under `setups/`, since `10xagents` bundles the setups. `pnpm changeset` writes one, and outside a terminal you write `.changeset/<branch-slug>.md` by hand, as `AGENTS.md` shows.

When changesets reach `main`, the Release workflow opens a `chore: release packages` pull request that bumps the versions and writes the changelogs. Merging it publishes the new versions to npm. See the [Changesets documentation](https://github.com/changesets/changesets) for how the files work.
