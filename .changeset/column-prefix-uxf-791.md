---
"10xagents": minor
"@10xagents/connector-multica": minor
---

A workflow can set a `prefix`, the text a connector that merges workflows puts before a later workflow's column names in place of its id. With `prefix: In Parts /`, the Multica connector names a later workflow's `planning` column In Parts / Planning, where it would otherwise be Part Planning. A `prefix` can't be empty or start or end with a space. To rename a live workspace's columns, rename each status with `multica issue-status update` before you sync, so it keeps its key and its issues.
