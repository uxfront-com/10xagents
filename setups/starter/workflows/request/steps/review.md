Verify the Builder's PR against the brief.

- **Pass:** every criterion held. Post the verdict, mark the PR ready, and move the issue to {{workflows.request.columns.in_review}}.
- **Fail:** post the blocking findings, and send it back to {{workflows.request.columns.in_progress}} assigned to the Builder, in one write: `multica issue update <issue> --status in_progress --assignee builder`.
- **Blocked:** when a criterion has two fair readings, or you can't verify it, ask {{vars.owner}} with your recommendation, and move it to {{workflows.request.columns.blocked}}.
