---
"10xagents": minor
---

Reach private GitHub sources with the gh CLI's token. When `GITHUB_TOKEN` and `GH_TOKEN` aren't set, or GitHub rejects the one that is as invalid or expired, `install`, `validate`, `build` and the other commands that fetch a GitHub source retry once with the token from `gh auth token`. gh runs only after GitHub refuses a request, so public sources and cached ones never start it. `GH_TOKEN` now counts too, after `GITHUB_TOKEN`.
