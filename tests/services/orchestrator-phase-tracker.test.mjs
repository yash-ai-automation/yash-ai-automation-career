// tests/services/orchestrator-phase-tracker.test.mjs
//
// Regression test for the "every phase reports 0 ms" cosmetic bug discovered
// 2026-05-25 in run #12's Telegram output:
//   ⏱️ #12 resume_gen_end done · 0 ms
//   ⏱️ #12 resume_compile_end done · 0 ms
//
// Root cause (services/pipeline-orchestrator.mjs:351-361, pre-fix):
//   const phaseStarts = new Map();
//   const phasePoll = setInterval(() => {
//     const cp = selectCheckpoint(db, runId);
//     if (cp && cp.last_phase !== lastSeenPhase) {
//       const now = Date.now();
//       const startedAt = phaseStarts.get(cp.last_phase) || now;  // ← always `now` on first observation
//       onPhaseEnd({ phase: cp.last_phase, elapsedMs: now - startedAt });
//       phaseStarts.set(cp.last_phase, now);  // dead code: lastSeenPhase prevents re-observation
//       lastSeenPhase = cp.last_phase;
//     }
//   }, CHECKPOINT_POLL_MS);
//
// Because each phase name is observed exactly once (lastSeenPhase guard),
// phaseStarts.get(phase) is undefined on first observation, falls back to
// `now`, and elapsedMs = now - now = 0 for EVERY phase. The phaseStarts.set
// after the calculation is never read.
//
// The fix replaces this with a tracker that carries the previous phase's end
// time across observations: elapsedMs = now - lastPhaseEndTime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhaseTracker } from '../../services/pipeline-orchestrator.mjs';

test('createPhaseTracker: first phase observation reports elapsed since tracker start (not 0)', () => {
  let nowMs = 1_000_000;
  const tracker = createPhaseTracker(nowMs);
  nowMs += 33_000;   // 33 s later
  const ev = tracker.observe('jd_fetch_end', () => nowMs);
  assert.equal(ev.newPhase, true);
  assert.equal(ev.phase, 'jd_fetch_end');
  assert.equal(ev.elapsedMs, 33_000, 'first phase elapsed = now - tracker_start, NOT 0');
});

test('createPhaseTracker: subsequent phase reports elapsed since PREVIOUS phase end (not 0, not since start)', () => {
  let nowMs = 1_000_000;
  const tracker = createPhaseTracker(nowMs);

  nowMs += 33_000;
  tracker.observe('jd_fetch_end', () => nowMs);             // phase 1 ends at start+33s

  nowMs += 12_000;
  const ev2 = tracker.observe('resume_gen_end', () => nowMs); // phase 2 ends 12s later
  assert.equal(ev2.elapsedMs, 12_000,
    'resume_gen_end elapsed must be the gap from jd_fetch_end (12s), not from tracker start (45s) and not 0');

  nowMs += 7_500;
  const ev3 = tracker.observe('resume_compile_end', () => nowMs);
  assert.equal(ev3.elapsedMs, 7_500,
    'resume_compile_end elapsed must be the gap from resume_gen_end (7.5s)');
});

test('createPhaseTracker: same phase observed twice in a row → second observation is a no-op (newPhase=false)', () => {
  let nowMs = 1_000_000;
  const tracker = createPhaseTracker(nowMs);
  nowMs += 10_000;
  const ev1 = tracker.observe('jd_fetch_end', () => nowMs);
  assert.equal(ev1.newPhase, true);

  nowMs += 5_000;
  const ev2 = tracker.observe('jd_fetch_end', () => nowMs);
  assert.equal(ev2.newPhase, false, 'idempotent: same phase = no event');
});

test('createPhaseTracker: null/undefined phase is a no-op', () => {
  const tracker = createPhaseTracker(1_000_000);
  assert.equal(tracker.observe(null,      () => 1_050_000).newPhase, false);
  assert.equal(tracker.observe(undefined, () => 1_050_000).newPhase, false);
  assert.equal(tracker.observe('',        () => 1_050_000).newPhase, false);
});

test('createPhaseTracker: NEVER returns elapsedMs=0 for a real phase progression', () => {
  // Exhaustive: simulate the full 13-phase Yash pipeline; no phase should be 0 ms.
  const phases = [
    'jd_fetch_end', 'resume_gen_end', 'resume_compile_end',
    'cl_gen_end', 'cl_compile_end', 'url_end',
  ];
  let nowMs = 1_000_000;
  const tracker = createPhaseTracker(nowMs);
  const events = [];
  for (const p of phases) {
    nowMs += 10_000;                       // each phase takes 10 s
    const ev = tracker.observe(p, () => nowMs);
    if (ev.newPhase) events.push(ev);
  }
  assert.equal(events.length, phases.length);
  for (const ev of events) {
    assert.ok(ev.elapsedMs > 0,
      `phase ${ev.phase} must have non-zero elapsedMs — got ${ev.elapsedMs} (this is the bug we are fixing)`);
  }
});
