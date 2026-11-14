# Changesets

Every change to a package comes with a changeset, and so does every change under `setups/`, since `10xagents` bundles the setups. `pnpm changeset` writes one, and outside a terminal you write `.changeset/<branch-slug>.md` by hand, as `AGENTS.md` shows.

Merging to `main` releases nothing. The owner runs `changeset version` and publishes. See the [Changesets documentation](https://github.com/changesets/changesets) for how the files work.
