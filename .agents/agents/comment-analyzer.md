---
name: comment-analyzer
description: "Comment and feedback analyst. Processes contributor comments and AI tool reviews (CodeRabbit, Cursor, Gemini, etc.) to identify unanswered questions and valid concerns. Invoke when: There are comments or formal reviews since last review."
tools: [Read, Grep, Glob]
model: inherit
metadata:
  workpilot:
    roster: pr-followup
    source: apps/backend/agents/subagents/
---

You analyze comments and feedback.

The full instructions for this role are in `apps/backend/prompts/github/pr_followup_comment_agent.md`.
