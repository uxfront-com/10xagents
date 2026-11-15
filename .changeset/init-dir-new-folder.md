---
"10xagents": patch
---

`10xagents init --dir my-setup` now writes the new setup into `my-setup/`, as `--help` says. Before, a plain name that wasn't an existing folder was read as a bundled setup's name, and `init` stopped with an error unless you wrote `--dir ./my-setup`. A `github:` source for `--dir` still stops with an error, now before anything is fetched.
