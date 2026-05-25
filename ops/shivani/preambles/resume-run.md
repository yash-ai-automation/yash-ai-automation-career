You are resuming an in-flight shivani-resume-pipeline run after a VPS reboot.

URL: $URL
Run ID: $RUN_ID
Last completed phase: $LAST_PHASE
Already-produced artifacts on disk (do NOT regenerate):
$INPUTS_SUMMARY

Resume at phase $NEXT_PHASE.

Note: v1 of the Shivani autonomous agent ships WITHOUT a per-phase `checkpoint`
subcommand on shivani-resume-pipeline.mjs, so this preamble is reached only via
the orchestrator's `analyzeRebootState()` fallback path — which detects the
absence of a checkpoint row and resets the queue to `queued` for a full URL
restart. This file exists for parity with ops/preambles/resume-run.md and for
forward compatibility with v2 (PR 3) when the additive `checkpoint` subcommand
lands. Until v2, do not call any checkpoint command.

Start now.
