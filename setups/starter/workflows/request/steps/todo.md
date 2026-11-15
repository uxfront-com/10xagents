Triage this request and post your decision with its reason.

- **Take it:** post the brief, then move the issue to {{workflows.request.columns.in_progress}} assigned to the Builder, in one write: `multica issue update <issue> --status in_progress --assignee builder`.
- **Duplicate or already done:** link what covers it and move it to {{workflows.request.columns.cancelled}}.
- **Decline:** post your recommendation, and move it to {{workflows.request.columns.blocked}} for {{vars.owner}} to decide.
- **Blocking questions:** ask them, and move it to {{workflows.request.columns.blocked}}.
