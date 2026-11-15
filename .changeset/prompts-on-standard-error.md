---
"10xagents": patch
"@10xagents/connector-multica": patch
---

The CLI now asks its questions on standard error, so standard output carries only the command's output. Before, when several Multica profiles were logged in, `10xagents bench --format json > bench.json` wrote the profile question into the JSON file, and you never saw it. The numbered list of profiles is now part of the question, so it goes to standard error with it.
