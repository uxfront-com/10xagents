---
"10xagents": minor
"@10xagents/connector-multica": minor
---

A workflow can set a `prefix`, the text a connector that merges workflows puts before its column names in place of its id. With `prefix: Sub-task /`, the Multica connector names a later workflow's `planning` column Sub-task / Planning. When a column's name changes, `sync` now renames its status in place, so it keeps its key and its issues, and it refuses a custom column name over Multica's 64 characters. Since `sync` manages each status's name, it also puts back a name changed by hand in Multica. A `multica` CLI or server that can't list statuses now holds the workflow's sync with a `!` line until you update it.
