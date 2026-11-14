#!/usr/bin/env node
// Committed, so pnpm can link the bin on a fresh install, before the first build.
// oxlint-disable-next-line import/no-unassigned-import -- the import runs the CLI.
import "../dist/cli.mjs";
