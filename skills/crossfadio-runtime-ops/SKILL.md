---
name: crossfadio-runtime-ops
description: "Evidence-first diagnosis and delivery for Crossfadio live/runtime problems: MusicAgent or Legacy fallback, LLM/provider/model timeouts, queue refill failures, audio/cache issues, auth/config drift, deployment health, or CPD follow-up. Use inside crossfadio-dev when the user asks what is happening online, why it did not take effect, or to deploy and verify a fix."
---

# Crossfadio Runtime Ops

Use this skill for runtime truth, not as a replacement for feature design or general code review.

## Evidence workflow

1. Read AGENTS.md, then the relevant sections of docs/ops-runbook.md. Check git status --short, branch, and current deployment scope before editing.
2. Establish the live boundary: service process, local and public /api/health, effective runtime .env, provider/model, and the relevant request/log window. Never print credentials.
3. Trace the full event path. For DJ refill, distinguish:
   - MusicAgent result and fallback reason;
   - Legacy invocation and its remaining deadline;
   - candidate eligibility and ranking;
   - actual DJ pick-next: broadcast appended tracks queue mutation.
4. For audio or cache failures, separate browser/media events, server logs, cache state, and upstream errors. Do not call a dry-run or a successful recommendation message proof of queue mutation.
5. State the evidence-backed root cause, confidence, and the smallest authorized fix. If the user asked only to inspect, do not change code, config, or production.

## Verification gates

- Run targeted tests for the touched path, then repository checks from README.md or the runbook.
- Run git diff --check and keep an explicit list of changed files.
- After deployment, run ./scripts/deploy.sh --status or the requested deploy mode, verify local and public health, process state, effective configuration, and one relevant live behavior.
- CPD means commit, push, deploy, post-deploy verification, and the requested main-branch handoff; do not report success from build output alone.

## Review loop

When the user asks for subagent review and repair, declare the scope, non-goals, maximum 1–2 rounds, P0/P1 boundary, and acceptance gates first. Stop when the gates pass; put new scope or architecture requests in a follow-up list.

## Source of truth

Use docs/ops-runbook.md for current ECS/deploy/log commands and the repository code for route, timeout, queue, fallback, and schema semantics. Treat old conversation summaries as leads that must be checked against the current runtime.
