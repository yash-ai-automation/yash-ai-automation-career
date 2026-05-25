# Yash Pipeline Self-Improvement Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the non-invasive self-improvement overlay specified in `docs/superpowers/specs/2026-05-25-yash-pipeline-self-improvement-architecture.md`, in four feature-flagged phases (A: Langfuse exporter, B: failure-pattern KB + preamble injection, C: watchdog + heartbeat, D: Promptfoo CI), preserving every locked-spec invariant.

**Architecture:** Phase-flagged overlay on the existing two-daemon + one-DB topology. New files under `services/`, `systemd/`, `tests/`, `.github/workflows/`. No edits to locked prompts. No new `claude -p` calls. No new inbound ports. Each phase ships behind its own `FEATURE_*` env var (default OFF); merging the code never changes runtime behavior.

**Tech Stack:** Node 22.22.2 (ES modules `.mjs`), native `node:sqlite`, native `node --test`, native `fetch` (Node 21+), `pino` (already in repo), systemd `--user` units, Langfuse Cloud Hobby REST API, Healthchecks.io ping URL, Promptfoo CLI in GitHub Actions with Anthropic provider.

**Sources of truth:**
- Spec: `docs/superpowers/specs/2026-05-25-yash-pipeline-self-improvement-architecture.md` (locked, just committed)
- Input audit: `docs/superpowers/audits/2026-05-24-yash-pipeline-self-improvement-audit.md`
- Baseline architecture: `docs/superpowers/specs/2026-05-24-yash-pipeline-autonomous-agent-architecture.md`
- Existing skill runbook: `.claude/skills/yash-pipeline-autonomous-agent/SKILL.md`

---

## File structure

### Files created (10 new files + 5 fixtures + 8 unit-test files + 8 e2e-test files = 31 new files)

```
services/
  exporter.mjs                            # Phase A: Langfuse batch exporter (~150 LOC)
  failure-kb.mjs                          # Phase B: regex catalogue + extractSignature/learnFromFailure (~120 LOC)
  watchdog.mjs                            # Phase C: journalctl tail + 5-rule remediator (~250 LOC)
systemd/
  exporter.service                        # Phase A: --user oneshot (~20 LOC)
  exporter.timer                          # Phase A: 5-min ticker (~15 LOC)
  watchdog.service                        # Phase C: third --user daemon, Restart=always (~20 LOC)
tools/
  smoke-cloud.mjs                         # Phase A-D: npm run smoke:cloud entrypoint (~120 LOC)
.github/workflows/
  prompt-eval.yml                         # Phase D: PR-gated promptfoo run (~60 LOC)
tests/
  promptfoo.yaml                          # Phase D: assertion config (~80 LOC)
  fixtures/jds/
    lever-ml-engineer.md                  # Phase D: synthetic JD #1
    ashby-fullstack.md                    # Phase D: synthetic JD #2
    greenhouse-data.md                    # Phase D: synthetic JD #3
    workday-platform.md                   # Phase D: synthetic JD #4
    direct-ai-research.md                 # Phase D: synthetic JD #5
  fixtures/journald/
    oom-killed.jsonl                      # Phase C: canned journald lines for OOM rule
    tectonic-missing-file.jsonl           # Phase C: tectonic exit-1 + file-not-found
    scrapling-403.jsonl                   # Phase C: two 403s on same host
    heartbeat-quiet.jsonl                 # Phase C: no entries for >10 min
    healthy.jsonl                         # Phase C: normal traffic baseline
  fixtures/langfuse/
    trace-expected.json                   # Phase A: expected POST body shape
  services/
    exporter.test.mjs                     # Phase A: 12 unit tests
    failure-kb.test.mjs                   # Phase B: 15 unit tests
    watchdog.test.mjs                     # Phase C: 18 unit tests
    db-extensions.test.mjs                # Cross-phase: 8 migration tests
    telegram-commands.test.mjs            # Phase B: /patterns, /suppress, /unpause unit tests
  e2e/
    hint-injection.e2e.mjs                # Phase B e2e
    learn-on-fail.e2e.mjs                 # Phase B e2e
    unknown-fault-routing.e2e.mjs         # Phase B e2e
    exporter-cursor.e2e.mjs               # Phase A e2e
    watchdog-oom.e2e.mjs                  # Phase C e2e
    watchdog-disk-pause.e2e.mjs           # Phase C e2e
    suppress-cmd.e2e.mjs                  # Phase B e2e
    feature-flag-off.e2e.mjs              # Cross-phase e2e
  bin/
    claude-stub.mjs                       # Phase B e2e: stub `claude` binary for preamble capture
```

### Files modified

```
services/
  db.mjs                                  # +70 LOC: 2 new tables (exporter_state, failure_patterns) + paused column + 4 helpers
  pipeline-orchestrator.mjs               # +55 LOC: pre-spawn injectHints, post-fail learnFromFailure, heartbeat ping, paused-row gate
  telegram-listener.mjs                   # +60 LOC: /patterns, /suppress, /unpause command handlers
ops/preambles/
  fresh-run.md                            # +5 lines: $LEARNED_HINTS placeholder block
ops/telegram.env.example                  # +7 env vars (4 FEATURE_* flags + 3 Langfuse + 1 Healthchecks)
.claude/skills/yash-pipeline-autonomous-agent/SKILL.md  # +30 lines: Self-Improvement Layer section
OPERATIONS.md                             # +80 lines: operating the layer
package.json                              # +3 scripts: test:e2e, smoke:cloud, smoke:cloud:phase
```

### Files NEVER touched (assert at PR-review time)

- `modes/yash-resume-pipeline.md`
- `resume-optimization-system-based-on-job-description.md`
- `cover-letter-system-based-on-jd-and-resume.md`
- `cv.md`, `cv-shivani.md`
- `yash-resume-pipeline.mjs` (the runner entry point)
- `services/cap.mjs`, `services/dedup.mjs`, `services/notifier.mjs`, `services/queue.mjs`, `services/reboot-resume.mjs`, `services/sd-notify.mjs`, `services/telegram-client.mjs`, `services/url-validate.mjs`, `services/logger.mjs`
- `systemd/telegram-listener.service`, `systemd/pipeline-orchestrator.service`
- All existing tests under `tests/services/*.test.mjs` (must continue to pass unchanged)

---

## Phase ordering

```
Pre-flight (worktree, baseline-green check, env-var stubs)
   ↓
Phase A — Observability exporter
   ↓  smoke:cloud --phase=A green
Phase B — Failure-pattern KB
   ↓  smoke:cloud --phase=B green
Phase C — Watchdog + heartbeat
   ↓  smoke:cloud --phase=C green
Phase D — Promptfoo CI
   ↓  smoke:cloud --phase=D green
Cross-cutting docs (SKILL.md, OPERATIONS.md, env.example)
```

Each phase ends in a green smoke run BEFORE the next phase begins. Skip-ahead is forbidden — phase boundaries are observation points.

---

## Pre-flight

### Task PF.1: Create isolated worktree

**Files:**
- Branch: `feat/self-improvement-overlay`

- [ ] **Step 1: Confirm main is clean**

```bash
git status --short
```
Expected: empty output (or only files you intend to leave behind).

- [ ] **Step 2: Create worktree**

Invoke `superpowers:using-git-worktrees` skill. Worktree path will be `.claude/worktrees/feat+self-improvement-overlay/`.

- [ ] **Step 3: cd into worktree and verify**

```bash
cd .claude/worktrees/feat+self-improvement-overlay/
git status
git log --oneline -3
```
Expected: clean, recent commits visible including `d2c82dc` (the architecture spec).

---

### Task PF.2: Confirm baseline tests green

**Files:** read-only

- [ ] **Step 1: Run full test suite**

```bash
npm test 2>&1 | tail -20
```
Expected: `# tests <N>` where N ≥ 108. `# pass <N>` equal to N. `# fail 0`.

- [ ] **Step 2: Record baseline test count**

Note the exact `# tests` count from step 1. This is the regression baseline. After Phase D, the count must be ≥ baseline + 53 unit + 8 e2e = baseline + 61.

---

### Task PF.3: Add feature-flag stubs to `ops/telegram.env.example`

**Files:**
- Modify: `ops/telegram.env.example`

- [ ] **Step 1: Append the 7 new vars**

Append at the end of the file:

```bash
# --- Self-Improvement Overlay (Phases A/B/C/D — all default OFF) ---

# Phase A: Observability exporter to Langfuse Cloud Hobby
FEATURE_EXPORTER=0
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=https://cloud.langfuse.com

# Phase B: Failure-pattern KB + preamble injection
FEATURE_FAILURE_KB=0

# Phase C: Watchdog + Healthchecks.io heartbeat
FEATURE_WATCHDOG=0
HEALTHCHECK_PING_URL=
```

- [ ] **Step 2: Commit**

```bash
git add ops/telegram.env.example
git commit -m "feat(env): stub self-improvement feature flags + Langfuse/Healthchecks vars (default OFF)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task PF.4: Add npm scripts for e2e + smoke

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `test:e2e` and `smoke:cloud` scripts**

In the `"scripts"` section, after the existing `test:services` entry, add:

```json
"test:e2e": "node --test tests/e2e/",
"smoke:cloud": "node tools/smoke-cloud.mjs",
"smoke:cloud:phase": "node tools/smoke-cloud.mjs --phase"
```

- [ ] **Step 2: Run npm install (no-op confirm)**

```bash
npm install 2>&1 | tail -3
```
Expected: `up to date` or similar — no new dependencies added.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(npm): add test:e2e and smoke:cloud script entries

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase A — Observability exporter

### Task A.1: Add `exporter_state` table + cursor helpers to `db.mjs`

**Files:**
- Modify: `services/db.mjs`
- Test: `tests/services/db-extensions.test.mjs` (new)

- [ ] **Step 1: Write the failing tests**

Create `tests/services/db-extensions.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../services/db.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'db-ext-test-'));
  return { path: join(dir, 'work.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('exporter_state migration is idempotent', () => {
  const { path, cleanup } = tmpDb();
  try {
    const db1 = openDb(path); db1.close();
    const db2 = openDb(path); db2.close();
    const db3 = openDb(path);
    const cols = db3.prepare("PRAGMA table_info(exporter_state)").all();
    assert.equal(cols.length, 2);
    assert.ok(cols.find(c => c.name === 'key' && c.pk === 1));
    assert.ok(cols.find(c => c.name === 'value'));
    db3.close();
  } finally { cleanup(); }
});

test('getCursor returns 0 when missing', async () => {
  const { path, cleanup } = tmpDb();
  try {
    const { getCursor } = await import('../../services/db.mjs');
    const db = openDb(path);
    assert.equal(getCursor(db, 'exporter.last_run_id'), 0);
    db.close();
  } finally { cleanup(); }
});

test('setCursor + getCursor round-trip', async () => {
  const { path, cleanup } = tmpDb();
  try {
    const { getCursor, setCursor } = await import('../../services/db.mjs');
    const db = openDb(path);
    setCursor(db, 'exporter.last_run_id', 1247);
    assert.equal(getCursor(db, 'exporter.last_run_id'), 1247);
    setCursor(db, 'exporter.last_run_id', 1297);
    assert.equal(getCursor(db, 'exporter.last_run_id'), 1297);
    db.close();
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
node --test tests/services/db-extensions.test.mjs 2>&1 | tail -10
```
Expected: failures referencing missing `getCursor` / `setCursor` or missing `exporter_state` table.

- [ ] **Step 3: Add migration + helpers to `services/db.mjs`**

In `openDb()` after existing migrations, add:

```javascript
db.exec(`
  CREATE TABLE IF NOT EXISTS exporter_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
```

At the bottom of `services/db.mjs`, export:

```javascript
export function getCursor(db, key) {
  const row = db.prepare('SELECT value FROM exporter_state WHERE key = ?').get(key);
  return row ? Number(row.value) : 0;
}

export function setCursor(db, key, value) {
  db.prepare(`
    INSERT INTO exporter_state(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}
```

- [ ] **Step 4: Run tests — confirm pass**

```bash
node --test tests/services/db-extensions.test.mjs 2>&1 | tail -5
```
Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add services/db.mjs tests/services/db-extensions.test.mjs
git commit -m "feat(db): add exporter_state table + getCursor/setCursor helpers (Phase A)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task A.2: Write exporter trace-shape test against fixture

**Files:**
- Create: `tests/fixtures/langfuse/trace-expected.json`
- Create: `tests/services/exporter.test.mjs`

- [ ] **Step 1: Write the expected-shape fixture**

Create `tests/fixtures/langfuse/trace-expected.json`:

```json
{
  "batch": [
    {
      "id": "trace-1247",
      "type": "trace-create",
      "timestamp": "2026-05-25T10:00:00.000Z",
      "body": {
        "id": "run-1247",
        "name": "yash-resume-pipeline",
        "input": "https://lever.co/example",
        "output": "resumes/yash/Example_AI_Engineer_2026-05-25.pdf",
        "metadata": {
          "git_sha": "abc1234",
          "exit_code": 0,
          "tokens_in": 12000,
          "tokens_out": 4500
        }
      }
    }
  ]
}
```

- [ ] **Step 2: Write the failing trace-builder test**

Create `tests/services/exporter.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTrace } from '../../services/exporter.mjs';

test('buildTrace produces canonical Langfuse trace shape', () => {
  const runRow = {
    id: 1247,
    url: 'https://lever.co/example',
    status: 'ok',
    pdf_path: 'resumes/yash/Example_AI_Engineer_2026-05-25.pdf',
    git_sha: 'abc1234',
    exit_code: 0,
    tokens_in: 12000,
    tokens_out: 4500,
    created_at: '2026-05-25T10:00:00.000Z'
  };
  const events = []; // empty observations for this base test
  const trace = buildTrace(runRow, events);
  const expected = JSON.parse(readFileSync('tests/fixtures/langfuse/trace-expected.json', 'utf8')).batch[0];
  assert.equal(trace.id, expected.id);
  assert.equal(trace.body.input, expected.body.input);
  assert.equal(trace.body.metadata.git_sha, 'abc1234');
});
```

- [ ] **Step 3: Run — confirm failure (module not found)**

```bash
node --test tests/services/exporter.test.mjs 2>&1 | tail -10
```
Expected: import resolution failure for `services/exporter.mjs`.

- [ ] **Step 4: Create skeleton `services/exporter.mjs`**

```javascript
export function buildTrace(runRow, events = []) {
  return {
    id: `trace-${runRow.id}`,
    type: 'trace-create',
    timestamp: runRow.created_at,
    body: {
      id: `run-${runRow.id}`,
      name: 'yash-resume-pipeline',
      input: runRow.url,
      output: runRow.pdf_path,
      metadata: {
        git_sha: runRow.git_sha,
        exit_code: runRow.exit_code,
        tokens_in: runRow.tokens_in,
        tokens_out: runRow.tokens_out
      }
    },
    observations: events.map((e, i) => ({
      id: `obs-${runRow.id}-${i}`,
      traceId: `trace-${runRow.id}`,
      name: e.phase,
      startTime: e.start,
      endTime: e.end
    }))
  };
}
```

- [ ] **Step 5: Run — confirm pass**

```bash
node --test tests/services/exporter.test.mjs 2>&1 | tail -5
```
Expected: 1 pass.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/langfuse/ tests/services/exporter.test.mjs services/exporter.mjs
git commit -m "feat(exporter): buildTrace + canonical Langfuse trace-shape fixture (Phase A)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task A.3: Add HTTP POST layer with `httpClient` injection

**Files:**
- Modify: `services/exporter.mjs`
- Modify: `tests/services/exporter.test.mjs`

- [ ] **Step 1: Add the failing tests**

Append to `tests/services/exporter.test.mjs`:

```javascript
test('postBatch returns true on 200', async () => {
  const { postBatch } = await import('../../services/exporter.mjs');
  const stub = async (url, opts) => ({ ok: true, status: 200 });
  const result = await postBatch({ httpClient: stub, host: 'https://x.test', publicKey: 'pk', secretKey: 'sk' }, [{}]);
  assert.equal(result, true);
});

test('postBatch returns false on 5xx', async () => {
  const { postBatch } = await import('../../services/exporter.mjs');
  const stub = async () => ({ ok: false, status: 503 });
  assert.equal(await postBatch({ httpClient: stub, host: 'https://x.test', publicKey: 'p', secretKey: 's' }, [{}]), false);
});

test('postBatch returns false on 429 (quota)', async () => {
  const { postBatch } = await import('../../services/exporter.mjs');
  const stub = async () => ({ ok: false, status: 429 });
  assert.equal(await postBatch({ httpClient: stub, host: 'https://x.test', publicKey: 'p', secretKey: 's' }, [{}]), false);
});

test('postBatch throws on 401 (auth)', async () => {
  const { postBatch } = await import('../../services/exporter.mjs');
  const stub = async () => ({ ok: false, status: 401 });
  await assert.rejects(
    () => postBatch({ httpClient: stub, host: 'https://x.test', publicKey: 'p', secretKey: 's' }, [{}]),
    /auth/
  );
});

test('postBatch returns false on network error', async () => {
  const { postBatch } = await import('../../services/exporter.mjs');
  const stub = async () => { throw new Error('ENETUNREACH'); };
  assert.equal(await postBatch({ httpClient: stub, host: 'https://x.test', publicKey: 'p', secretKey: 's' }, [{}]), false);
});

test('postBatch posts to /api/public/ingestion', async () => {
  const { postBatch } = await import('../../services/exporter.mjs');
  let capturedUrl = null;
  const stub = async (url) => { capturedUrl = url; return { ok: true, status: 200 }; };
  await postBatch({ httpClient: stub, host: 'https://x.test', publicKey: 'p', secretKey: 's' }, [{}]);
  assert.ok(capturedUrl.endsWith('/api/public/ingestion'));
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
node --test tests/services/exporter.test.mjs 2>&1 | tail -15
```
Expected: 6 new failures (postBatch undefined).

- [ ] **Step 3: Implement `postBatch` in `services/exporter.mjs`**

Append:

```javascript
export async function postBatch({ httpClient, host, publicKey, secretKey }, batch) {
  const authHeader = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  try {
    const res = await httpClient(`${host}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ batch })
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Langfuse auth failed (status ${res.status})`);
    }
    return res.ok;
  } catch (e) {
    if (/auth/i.test(e.message)) throw e;
    return false;
  }
}
```

- [ ] **Step 4: Run — confirm pass**

```bash
node --test tests/services/exporter.test.mjs 2>&1 | tail -5
```
Expected: 7 pass total (1 from A.2 + 6 from A.3).

- [ ] **Step 5: Commit**

```bash
git add services/exporter.mjs tests/services/exporter.test.mjs
git commit -m "feat(exporter): postBatch HTTP layer with httpClient injection + auth/quota/network handling (Phase A)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task A.4: Add main `runExporter()` loop with cursor advance logic

**Files:**
- Modify: `services/exporter.mjs`
- Modify: `tests/services/exporter.test.mjs`

- [ ] **Step 1: Add the failing tests**

Append to `tests/services/exporter.test.mjs`:

```javascript
import { openDb } from '../../services/db.mjs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function seedDb(n) {
  const dir = mkdtempSync(join(tmpdir(), 'exporter-test-'));
  const dbPath = join(dir, 'work.db');
  const db = openDb(dbPath);
  for (let i = 1; i <= n; i++) {
    db.prepare(`INSERT INTO runs (id, url, status, pdf_path, git_sha, exit_code, tokens_in, tokens_out, created_at)
                VALUES (?, 'https://x.test/foo', 'ok', '/p.pdf', 'abc', 0, 100, 50, ?)`)
      .run(i, '2026-05-25T10:00:00.000Z');
  }
  return { db, dir, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('runExporter advances cursor on 200', async () => {
  const { runExporter } = await import('../../services/exporter.mjs');
  const { db, cleanup } = seedDb(10);
  try {
    const result = await runExporter({
      db,
      httpClient: async () => ({ ok: true, status: 200 }),
      host: 'https://x.test',
      publicKey: 'p', secretKey: 's',
      batchSize: 50,
      runsDir: '/nonexistent'
    });
    assert.equal(result.advanced, 10);
    const { getCursor } = await import('../../services/db.mjs');
    assert.equal(getCursor(db, 'exporter.last_run_id'), 10);
  } finally { cleanup(); }
});

test('runExporter does NOT advance cursor on 5xx', async () => {
  const { runExporter } = await import('../../services/exporter.mjs');
  const { db, cleanup } = seedDb(10);
  try {
    const result = await runExporter({
      db,
      httpClient: async () => ({ ok: false, status: 503 }),
      host: 'https://x.test',
      publicKey: 'p', secretKey: 's',
      batchSize: 50,
      runsDir: '/nonexistent'
    });
    assert.equal(result.advanced, 0);
    const { getCursor } = await import('../../services/db.mjs');
    assert.equal(getCursor(db, 'exporter.last_run_id'), 0);
  } finally { cleanup(); }
});

test('runExporter respects batchSize and advances in batches', async () => {
  const { runExporter } = await import('../../services/exporter.mjs');
  const { db, cleanup } = seedDb(75);
  let batchCount = 0;
  try {
    await runExporter({
      db,
      httpClient: async (_, opts) => {
        batchCount++;
        const body = JSON.parse(opts.body);
        assert.ok(body.batch.length <= 50);
        return { ok: true, status: 200 };
      },
      host: 'https://x.test',
      publicKey: 'p', secretKey: 's',
      batchSize: 50,
      runsDir: '/nonexistent'
    });
    assert.equal(batchCount, 2); // 50 + 25
    const { getCursor } = await import('../../services/db.mjs');
    assert.equal(getCursor(db, 'exporter.last_run_id'), 75);
  } finally { cleanup(); }
});

test('runExporter no-op on empty result set', async () => {
  const { runExporter } = await import('../../services/exporter.mjs');
  const { db, cleanup } = seedDb(0);
  let called = false;
  try {
    await runExporter({
      db,
      httpClient: async () => { called = true; return { ok: true, status: 200 }; },
      host: 'https://x.test',
      publicKey: 'p', secretKey: 's',
      batchSize: 50,
      runsDir: '/nonexistent'
    });
    assert.equal(called, false);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
node --test tests/services/exporter.test.mjs 2>&1 | tail -15
```
Expected: 4 new failures.

- [ ] **Step 3: Implement `runExporter` in `services/exporter.mjs`**

Append:

```javascript
import { getCursor, setCursor } from './db.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function readEvents(runsDir, runId) {
  const path = join(runsDir, String(runId), 'events.jsonl');
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];  // malformed → skip events but emit trace anyway
  }
}

export async function runExporter({ db, httpClient, host, publicKey, secretKey, batchSize = 50, runsDir }) {
  const cursor = getCursor(db, 'exporter.last_run_id');
  let advanced = 0;
  let lastId = cursor;
  while (true) {
    const rows = db.prepare(
      'SELECT * FROM runs WHERE id > ? ORDER BY id LIMIT ?'
    ).all(lastId, batchSize);
    if (rows.length === 0) break;
    const batch = rows.map(r => buildTrace(r, readEvents(runsDir, r.id)));
    const ok = await postBatch({ httpClient, host, publicKey, secretKey }, batch);
    if (!ok) break;
    lastId = rows[rows.length - 1].id;
    setCursor(db, 'exporter.last_run_id', lastId);
    advanced += rows.length;
    if (rows.length < batchSize) break;
  }
  return { advanced, finalCursor: lastId };
}
```

- [ ] **Step 4: Run — confirm pass**

```bash
node --test tests/services/exporter.test.mjs 2>&1 | tail -5
```
Expected: 11 pass total.

- [ ] **Step 5: Commit**

```bash
git add services/exporter.mjs tests/services/exporter.test.mjs
git commit -m "feat(exporter): runExporter main loop with cursor advance + batch iteration (Phase A)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task A.5: Add CLI entry point + feature-flag check

**Files:**
- Modify: `services/exporter.mjs`

- [ ] **Step 1: Add the CLI entry test**

Append to `tests/services/exporter.test.mjs`:

```javascript
test('main() exits cleanly when FEATURE_EXPORTER=0', async () => {
  const { main } = await import('../../services/exporter.mjs');
  const orig = process.env.FEATURE_EXPORTER;
  process.env.FEATURE_EXPORTER = '0';
  try {
    const result = await main({ exitOnDisabled: false });
    assert.equal(result.disabled, true);
  } finally {
    process.env.FEATURE_EXPORTER = orig;
  }
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
node --test tests/services/exporter.test.mjs 2>&1 | tail -5
```

- [ ] **Step 3: Add main() to `services/exporter.mjs`**

Append:

```javascript
import { openDb } from './db.mjs';
import { createLogger } from './logger.mjs';

export async function main({ exitOnDisabled = true } = {}) {
  const log = createLogger({ name: 'exporter' });
  if (process.env.FEATURE_EXPORTER !== '1') {
    log.info({ event: 'exporter_disabled' }, 'FEATURE_EXPORTER not set; exiting');
    if (exitOnDisabled) process.exit(0);
    return { disabled: true };
  }
  const required = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    log.error({ event: 'exporter_env_missing', missing }, 'required env vars missing');
    process.exit(1);
  }
  const dbPath = process.env.DB_PATH || 'ops/work-queue.db';
  const runsDir = process.env.RUNS_DIR || 'ops/runs';
  const db = openDb(dbPath);
  try {
    const result = await runExporter({
      db,
      httpClient: fetch,
      host: process.env.LANGFUSE_HOST,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      runsDir
    });
    log.info({ event: 'exporter_done', ...result }, 'exporter tick complete');
    return result;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run — confirm pass**

```bash
node --test tests/services/exporter.test.mjs 2>&1 | tail -5
```
Expected: 12 pass total.

- [ ] **Step 5: Commit**

```bash
git add services/exporter.mjs tests/services/exporter.test.mjs
git commit -m "feat(exporter): CLI entry point + FEATURE_EXPORTER gate + env validation (Phase A)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task A.6: Add systemd `exporter.service` + `exporter.timer`

**Files:**
- Create: `systemd/exporter.service`
- Create: `systemd/exporter.timer`

- [ ] **Step 1: Create `systemd/exporter.service`**

```ini
[Unit]
Description=Yash pipeline self-improvement Langfuse exporter
After=pipeline-orchestrator.service
ConditionEnvironment=FEATURE_EXPORTER=1

[Service]
Type=oneshot
EnvironmentFile=/etc/yash-pipeline/agent.env
WorkingDirectory=%h/yash-ai-automation-career
ExecStart=/usr/bin/node services/exporter.mjs
StandardOutput=journal
StandardError=journal
TimeoutStartSec=120

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Create `systemd/exporter.timer`**

```ini
[Unit]
Description=Run Langfuse exporter every 5 minutes
Requires=exporter.service

[Timer]
OnBootSec=2min
OnUnitInactiveSec=5min
AccuracySec=30s
Unit=exporter.service
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Validate unit files locally**

```bash
systemd-analyze verify systemd/exporter.service systemd/exporter.timer 2>&1 || echo "(warnings OK; we only deploy these on the VPS)"
```

- [ ] **Step 4: Commit**

```bash
git add systemd/exporter.service systemd/exporter.timer
git commit -m "feat(systemd): exporter.service + exporter.timer (5-min ticker, ConditionEnvironment-gated) (Phase A)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task A.7: Add Phase A e2e test (exporter cursor advance)

**Files:**
- Create: `tests/e2e/exporter-cursor.e2e.mjs`

- [ ] **Step 1: Write the e2e test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getCursor } from '../../services/db.mjs';
import { runExporter } from '../../services/exporter.mjs';

test('e2e: 75 rows export in 2 batches of (50, 25) with cursor advance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'exporter-e2e-'));
  const dbPath = join(root, 'work.db');
  const runsDir = join(root, 'runs');
  mkdirSync(runsDir);
  const db = openDb(dbPath);
  try {
    for (let i = 1; i <= 75; i++) {
      db.prepare(`INSERT INTO runs (id, url, status, pdf_path, git_sha, exit_code, tokens_in, tokens_out, created_at)
                  VALUES (?, 'https://x.test/f', 'ok', '/p.pdf', 'abc', 0, 100, 50, ?)`).run(i, '2026-05-25T10:00:00.000Z');
      const dir = join(runsDir, String(i));
      mkdirSync(dir);
      writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ phase: 'p1', start: '...', end: '...' }) + '\n');
    }

    const batches = [];
    const result = await runExporter({
      db,
      httpClient: async (_, opts) => { batches.push(JSON.parse(opts.body).batch.length); return { ok: true, status: 200 }; },
      host: 'https://x.test', publicKey: 'p', secretKey: 's',
      runsDir
    });

    assert.deepEqual(batches, [50, 25]);
    assert.equal(result.advanced, 75);
    assert.equal(getCursor(db, 'exporter.last_run_id'), 75);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run — confirm pass**

```bash
node --test tests/e2e/exporter-cursor.e2e.mjs 2>&1 | tail -5
```
Expected: 1 pass.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/exporter-cursor.e2e.mjs
git commit -m "test(e2e): exporter cursor advance over 75 rows / 2 batches (Phase A)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task A.8: Add `tools/smoke-cloud.mjs --phase=A`

**Files:**
- Create: `tools/smoke-cloud.mjs`

- [ ] **Step 1: Write the smoke-cloud entry point with Phase A**

```javascript
#!/usr/bin/env node
import { openDb } from '../services/db.mjs';
import { runExporter } from '../services/exporter.mjs';

const args = process.argv.slice(2);
const phaseIdx = args.indexOf('--phase');
const phase = phaseIdx >= 0 ? args[phaseIdx + 1] : 'all';

async function smokePhaseA() {
  console.log('[smoke A] Hitting Langfuse Cloud Hobby with one synthetic trace...');
  const required = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) { console.error('Missing env:', missing); process.exit(1); }

  const db = openDb('/tmp/smoke-cloud.db');
  db.prepare(`CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, url TEXT, status TEXT, pdf_path TEXT, git_sha TEXT, exit_code INTEGER, tokens_in INTEGER, tokens_out INTEGER, created_at TEXT)`).run();
  db.prepare(`INSERT OR IGNORE INTO runs VALUES (999999, 'https://smoke.test', 'ok', '/p.pdf', 'smoke', 0, 1, 1, ?)`).run(new Date().toISOString());

  const result = await runExporter({
    db, httpClient: fetch,
    host: process.env.LANGFUSE_HOST,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    runsDir: '/tmp'
  });

  if (result.advanced > 0) { console.log('[smoke A] OK — exported', result.advanced, 'trace(s)'); }
  else { console.error('[smoke A] FAIL — no rows advanced'); process.exit(2); }
  db.close();
}

async function main() {
  if (phase === 'A' || phase === 'all') await smokePhaseA();
  if (phase === 'B' || phase === 'C' || phase === 'D') {
    console.error(`[smoke ${phase}] Not yet implemented (added in later phase tasks).`);
    process.exit(3);
  }
}

main().catch(e => { console.error(e); process.exit(99); });
```

- [ ] **Step 2: Run with FEATURE_EXPORTER=0 + dummy env (expect "Missing env" exit 1 since smoke needs real keys)**

```bash
node tools/smoke-cloud.mjs --phase=A 2>&1 | head -5
```
Expected: `Missing env: [ 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST' ]` and exit 1.

Note: The actual cloud smoke runs only on the VPS with real keys in `.env.smoke`. Skip live cloud call in CI.

- [ ] **Step 3: Commit**

```bash
git add tools/smoke-cloud.mjs
git commit -m "feat(smoke): smoke-cloud entry point with --phase=A live exporter check (Phase A)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task A.9: Run full Phase A test sweep + gate

**Files:** read-only

- [ ] **Step 1: All unit tests pass**

```bash
node --test tests/services/exporter.test.mjs tests/services/db-extensions.test.mjs 2>&1 | tail -5
```
Expected: 15 pass, 0 fail.

- [ ] **Step 2: All Phase A e2e tests pass**

```bash
node --test tests/e2e/exporter-cursor.e2e.mjs 2>&1 | tail -5
```
Expected: 1 pass.

- [ ] **Step 3: Existing 108 tests still green**

```bash
npm test 2>&1 | tail -3
```
Expected: pass count = baseline + 16 (15 new unit + 1 e2e).

- [ ] **Step 4: Commit (no-op if nothing changed)**

If anything was tweaked in the previous steps:

```bash
git add -A
git commit -m "chore: Phase A test sweep clean

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>" --allow-empty
```

Phase A code-complete. Activation (`FEATURE_EXPORTER=1` on VPS) happens after a successful live `npm run smoke:cloud -- --phase=A` against real Langfuse keys.

---

## Phase B — Failure-pattern KB

### Task B.1: Add `failure_patterns` table + helpers to `db.mjs`

**Files:**
- Modify: `services/db.mjs`
- Modify: `tests/services/db-extensions.test.mjs`

- [ ] **Step 1: Add the failing tests**

Append to `tests/services/db-extensions.test.mjs`:

```javascript
test('failure_patterns migration is idempotent', () => {
  const { path, cleanup } = tmpDb();
  try {
    const db1 = openDb(path); db1.close();
    const db2 = openDb(path);
    const cols = db2.prepare("PRAGMA table_info(failure_patterns)").all();
    assert.equal(cols.length, 7);
    db2.close();
  } finally { cleanup(); }
});

test('upsertPattern inserts on first call, increments on second', async () => {
  const { path, cleanup } = tmpDb();
  try {
    const { upsertPattern } = await import('../../services/db.mjs');
    const db = openDb(path);
    upsertPattern(db, { signature: 'sig-1', hint: 'h', runId: 42 });
    let r = db.prepare('SELECT * FROM failure_patterns WHERE signature=?').get('sig-1');
    assert.equal(r.hits, 1);
    assert.equal(r.last_run_id, 42);
    upsertPattern(db, { signature: 'sig-1', hint: 'h', runId: 43 });
    r = db.prepare('SELECT * FROM failure_patterns WHERE signature=?').get('sig-1');
    assert.equal(r.hits, 2);
    assert.equal(r.last_run_id, 43);
    db.close();
  } finally { cleanup(); }
});

test('topHintsByHost returns top 3 by hits DESC, excludes suppressed', async () => {
  const { path, cleanup } = tmpDb();
  try {
    const { upsertPattern, topHintsByHost } = await import('../../services/db.mjs');
    const db = openDb(path);
    upsertPattern(db, { signature: 'lever:a', hint: 'A', runId: 1 });
    upsertPattern(db, { signature: 'lever:a', hint: 'A', runId: 2 });
    upsertPattern(db, { signature: 'lever:b', hint: 'B', runId: 3 });
    upsertPattern(db, { signature: 'lever:c', hint: 'C', runId: 4 });
    upsertPattern(db, { signature: 'lever:d', hint: 'D', runId: 5 });
    db.prepare("UPDATE failure_patterns SET suppressed=1 WHERE signature='lever:d'").run();
    const hints = topHintsByHost(db, 'lever.co', 3);
    assert.equal(hints.length, 3);
    assert.equal(hints[0].hint, 'A');           // hits=2, first
    assert.ok(!hints.find(h => h.hint === 'D')); // suppressed
    db.close();
  } finally { cleanup(); }
});

test('topHintsByHost excludes patterns older than 90 days', async () => {
  const { path, cleanup } = tmpDb();
  try {
    const { upsertPattern, topHintsByHost } = await import('../../services/db.mjs');
    const db = openDb(path);
    upsertPattern(db, { signature: 'lever:old', hint: 'old', runId: 1 });
    db.prepare("UPDATE failure_patterns SET last_seen = date('now','-91 days') WHERE signature='lever:old'").run();
    upsertPattern(db, { signature: 'lever:fresh', hint: 'fresh', runId: 2 });
    const hints = topHintsByHost(db, 'lever.co', 3);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].hint, 'fresh');
    db.close();
  } finally { cleanup(); }
});

test('topHintsByHost cap LIMIT 3 default, configurable', async () => {
  const { path, cleanup } = tmpDb();
  try {
    const { upsertPattern, topHintsByHost } = await import('../../services/db.mjs');
    const db = openDb(path);
    for (let i = 0; i < 5; i++) upsertPattern(db, { signature: `lever:${i}`, hint: `H${i}`, runId: i });
    assert.equal(topHintsByHost(db, 'lever.co').length, 3);
    assert.equal(topHintsByHost(db, 'lever.co', 5).length, 5);
    db.close();
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run — confirm failures**

```bash
node --test tests/services/db-extensions.test.mjs 2>&1 | tail -10
```
Expected: 5 new failures.

- [ ] **Step 3: Add migration + helpers to `services/db.mjs`**

In `openDb()` after the `exporter_state` migration, add:

```javascript
db.exec(`
  CREATE TABLE IF NOT EXISTS failure_patterns (
    signature   TEXT PRIMARY KEY,
    hint        TEXT NOT NULL,
    hits        INTEGER NOT NULL DEFAULT 1,
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    last_run_id INTEGER REFERENCES runs(id),
    suppressed  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS failure_patterns_recent ON failure_patterns(last_seen);
`);
```

At the bottom of `services/db.mjs`, add:

```javascript
export function upsertPattern(db, { signature, hint, runId }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO failure_patterns (signature, hint, hits, first_seen, last_seen, last_run_id)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(signature) DO UPDATE SET
      hits = hits + 1,
      last_seen = excluded.last_seen,
      last_run_id = excluded.last_run_id
  `).run(signature, hint, now, now, runId);
}

export function topHintsByHost(db, host, limit = 3) {
  const escaped = host.replace(/[%_]/g, '\\$&');
  return db.prepare(`
    SELECT signature, hint, hits, last_seen
    FROM failure_patterns
    WHERE (signature LIKE ? ESCAPE '\\' OR hint LIKE ? ESCAPE '\\')
      AND suppressed = 0
      AND last_seen > date('now','-90 days')
    ORDER BY hits DESC, last_seen DESC
    LIMIT ?
  `).all(`%${escaped}%`, `%${escaped}%`, limit);
}
```

- [ ] **Step 4: Run — confirm pass**

```bash
node --test tests/services/db-extensions.test.mjs 2>&1 | tail -5
```
Expected: 8 pass (3 from A.1 + 5 from B.1).

- [ ] **Step 5: Commit**

```bash
git add services/db.mjs tests/services/db-extensions.test.mjs
git commit -m "feat(db): add failure_patterns table + upsertPattern/topHintsByHost helpers (Phase B)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task B.2: Write the 6-signature regex catalogue + `extractSignature()` test

**Files:**
- Create: `tests/services/failure-kb.test.mjs`

- [ ] **Step 1: Write 6 canonical-sample tests (one per signature)**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('extractSignature: Cloudflare 403 on lever.co', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'Error: scrapling fetch failed: HTTP 403 Forbidden\nCloudflare challenge detected at https://lever.co/jobs/abc';
  const result = extractSignature(err, { url: 'https://lever.co/jobs/abc', exitCode: 1 });
  assert.equal(result.signature, 'scrapling:cloudflare:lever.co');
  assert.match(result.hint, /cloudflare|browser fallback/i);
});

test('extractSignature: tectonic exit', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'tectonic: latex error: tectonic exited with code 1\nLaTeX Error: File `foo.sty\' not found';
  const result = extractSignature(err, { url: 'https://x.test', exitCode: 1 });
  assert.equal(result.signature, 'tectonic:missing-file');
  assert.match(result.hint, /tectonic|missing/i);
});

test('extractSignature: validator bullet-count fail', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'validate_bullets: expected 15 bullets, got 14';
  const result = extractSignature(err, { url: 'https://x.test', exitCode: 1 });
  assert.equal(result.signature, 'validator:bullet-count');
  assert.match(result.hint, /bullet|15/i);
});

test('extractSignature: OOM', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'Out of memory: Killed process 1234 (node)';
  const result = extractSignature(err, { url: 'https://x.test', exitCode: 137 });
  assert.equal(result.signature, 'system:oom');
});

test('extractSignature: rate limit', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'API error: 429 Too Many Requests\nrate_limit_exceeded';
  const result = extractSignature(err, { url: 'https://api.anthropic.com', exitCode: 1 });
  assert.equal(result.signature, 'anthropic:rate-limit');
});

test('extractSignature: Telegram outage', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'Telegram Bot API: 502 Bad Gateway';
  const result = extractSignature(err, { url: 'https://x.test', exitCode: 1 });
  assert.equal(result.signature, 'telegram:outage');
});

test('extractSignature: unknown returns {unknown: true, snippet}', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'Some never-before-seen weird failure mode XYZ';
  const result = extractSignature(err, { url: 'https://x.test', exitCode: 1 });
  assert.equal(result.unknown, true);
  assert.ok(result.snippet.includes('XYZ'));
  assert.ok(result.snippet.length <= 200);
});

test('extractSignature: signature is deterministic', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'Error: scrapling fetch failed: HTTP 403 Forbidden\nCloudflare';
  const a = extractSignature(err, { url: 'https://lever.co/x', exitCode: 1 });
  const b = extractSignature(err, { url: 'https://lever.co/x', exitCode: 1 });
  assert.equal(a.signature, b.signature);
});

test('extractSignature: hint is capped at 100 chars', async () => {
  const { extractSignature } = await import('../../services/failure-kb.mjs');
  const err = 'Out of memory: Killed process';
  const r = extractSignature(err, { url: 'https://x.test', exitCode: 137 });
  assert.ok(r.hint.length <= 100);
});

test('regex catalogue is exported for inspection', async () => {
  const mod = await import('../../services/failure-kb.mjs');
  assert.ok(Array.isArray(mod.SIGNATURE_PATTERNS));
  assert.equal(mod.SIGNATURE_PATTERNS.length, 6);
});
```

- [ ] **Step 2: Run — confirm failures**

```bash
node --test tests/services/failure-kb.test.mjs 2>&1 | tail -15
```
Expected: 10 failures (file not found).

- [ ] **Step 3: Create `services/failure-kb.mjs` with the catalogue**

```javascript
import { URL } from 'node:url';

export const SIGNATURE_PATTERNS = [
  {
    name: 'scrapling:cloudflare',
    test: (err) => /scrapling fetch failed.*40[03]|cloudflare challenge/i.test(err),
    extract: (err, meta) => {
      const host = safeHost(meta.url);
      return {
        signature: `scrapling:cloudflare:${host}`,
        hint: `Host ${host} returned Cloudflare challenge; prefer browser fallback over scrapling.`.slice(0, 100)
      };
    }
  },
  {
    name: 'tectonic:missing-file',
    test: (err) => /tectonic.*exit/i.test(err) && /file .* not found|missing file/i.test(err),
    extract: () => ({
      signature: 'tectonic:missing-file',
      hint: 'tectonic compile failed on missing file; retry with --keep-logs to capture cache state.'.slice(0, 100)
    })
  },
  {
    name: 'validator:bullet-count',
    test: (err) => /validate_bullets.*expected 15/i.test(err),
    extract: () => ({
      signature: 'validator:bullet-count',
      hint: 'bullet count must equal 15; trim or expand before .tex emit.'.slice(0, 100)
    })
  },
  {
    name: 'system:oom',
    test: (err) => /out of memory.*killed/i.test(err),
    extract: () => ({
      signature: 'system:oom',
      hint: 'OOM kill observed; ensure /tmp is clean before next spawn.'.slice(0, 100)
    })
  },
  {
    name: 'anthropic:rate-limit',
    test: (err) => /429.*too many requests|rate_limit_exceeded/i.test(err),
    extract: () => ({
      signature: 'anthropic:rate-limit',
      hint: 'Anthropic 429 observed; back off 60s before retry.'.slice(0, 100)
    })
  },
  {
    name: 'telegram:outage',
    test: (err) => /telegram bot api.*5\d\d/i.test(err),
    extract: () => ({
      signature: 'telegram:outage',
      hint: 'Telegram Bot API outage; queue notifications until restored.'.slice(0, 100)
    })
  }
];

function safeHost(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return 'unknown'; }
}

export function extractSignature(errorText, meta = {}) {
  for (const sig of SIGNATURE_PATTERNS) {
    if (sig.test(errorText)) return sig.extract(errorText, meta);
  }
  return { unknown: true, snippet: errorText.slice(0, 200).replace(/\s+/g, ' ') };
}
```

- [ ] **Step 4: Run — confirm pass**

```bash
node --test tests/services/failure-kb.test.mjs 2>&1 | tail -5
```
Expected: 10 pass.

- [ ] **Step 5: Commit**

```bash
git add services/failure-kb.mjs tests/services/failure-kb.test.mjs
git commit -m "feat(failure-kb): 6-signature regex catalogue + extractSignature() with deterministic output (Phase B)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task B.3: Add `learnFromFailure()` with KB-write + review-queue-write paths

**Files:**
- Modify: `services/failure-kb.mjs`
- Modify: `tests/services/failure-kb.test.mjs`

- [ ] **Step 1: Add the failing tests**

Append to `tests/services/failure-kb.test.mjs`:

```javascript
import { openDb } from '../../services/db.mjs';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lkb-test-'));
  const db = openDb(join(dir, 'work.db'));
  const reviewDir = join(dir, 'kb-review-queue');
  return { db, reviewDir, dir, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('learnFromFailure: known signature upserts pattern', async () => {
  const { learnFromFailure } = await import('../../services/failure-kb.mjs');
  const { db, reviewDir, cleanup } = setup();
  try {
    const r = await learnFromFailure(db, 42, 'scrapling fetch failed: 403 Cloudflare', { url: 'https://lever.co/x', reviewDir });
    assert.equal(r.kind, 'learned');
    assert.equal(r.signature, 'scrapling:cloudflare:lever.co');
    const row = db.prepare('SELECT * FROM failure_patterns WHERE signature=?').get(r.signature);
    assert.equal(row.hits, 1);
    assert.equal(row.last_run_id, 42);
  } finally { cleanup(); }
});

test('learnFromFailure: unknown signature writes review-queue JSON', async () => {
  const { learnFromFailure } = await import('../../services/failure-kb.mjs');
  const { db, reviewDir, cleanup } = setup();
  try {
    const r = await learnFromFailure(db, 99, 'utterly novel error XYZ-123', { url: 'https://x.test', reviewDir });
    assert.equal(r.kind, 'review-queued');
    const files = readdirSync(reviewDir);
    assert.equal(files.length, 1);
    const body = JSON.parse(readFileSync(join(reviewDir, files[0]), 'utf8'));
    assert.equal(body.run_id, 99);
    assert.ok(body.snippet.includes('XYZ-123'));
  } finally { cleanup(); }
});

test('learnFromFailure: review-queue write failure does not throw', async () => {
  const { learnFromFailure } = await import('../../services/failure-kb.mjs');
  const { db, cleanup } = setup();
  try {
    const r = await learnFromFailure(db, 1, 'unknown failure', { url: 'https://x.test', reviewDir: '/proc/0/forbidden-target' });
    assert.equal(r.kind, 'review-queue-failed');
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
node --test tests/services/failure-kb.test.mjs 2>&1 | tail -10
```
Expected: 3 new failures.

- [ ] **Step 3: Implement `learnFromFailure` in `services/failure-kb.mjs`**

Append:

```javascript
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { upsertPattern } from './db.mjs';

export async function learnFromFailure(db, runId, errorText, { url, reviewDir }) {
  const sig = extractSignature(errorText, { url });
  if (sig.unknown) {
    try {
      mkdirSync(reviewDir, { recursive: true });
      writeFileSync(
        join(reviewDir, `${runId}.json`),
        JSON.stringify({ run_id: runId, url, snippet: sig.snippet, full_error: errorText.slice(0, 2000) }, null, 2)
      );
      return { kind: 'review-queued', snippet: sig.snippet };
    } catch (e) {
      return { kind: 'review-queue-failed', error: e.message };
    }
  }
  try {
    upsertPattern(db, { signature: sig.signature, hint: sig.hint, runId });
    return { kind: 'learned', signature: sig.signature };
  } catch (e) {
    return { kind: 'upsert-failed', error: e.message };
  }
}
```

- [ ] **Step 4: Run — confirm pass**

```bash
node --test tests/services/failure-kb.test.mjs 2>&1 | tail -5
```
Expected: 13 pass total.

- [ ] **Step 5: Commit**

```bash
git add services/failure-kb.mjs tests/services/failure-kb.test.mjs
git commit -m "feat(failure-kb): learnFromFailure with KB-write + review-queue-write paths (Phase B)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task B.4: Add `$LEARNED_HINTS` placeholder to `ops/preambles/fresh-run.md`

**Files:**
- Modify: `ops/preambles/fresh-run.md`

- [ ] **Step 1: Read current file**

```bash
cat ops/preambles/fresh-run.md
```

- [ ] **Step 2: Add the placeholder block**

Append at the end (or after the URL/RUN_ID section, before any "execute the playbook" instruction):

```markdown

## Recent patterns for this host

$LEARNED_HINTS
```

- [ ] **Step 3: Verify `renderPreamble` strips the block when `$LEARNED_HINTS` is empty**

Inspect `services/pipeline-orchestrator.mjs`:

```bash
grep -n -A2 "renderPreamble" services/pipeline-orchestrator.mjs | head -20
```

If the existing `renderPreamble` does NOT auto-strip headings whose only content is an empty variable, add this trimming logic in Task B.5 below. For now, the placeholder substitutes to empty string + leaves a blank section — acceptable for v1.

- [ ] **Step 4: Commit**

```bash
git add ops/preambles/fresh-run.md
git commit -m "feat(preamble): add \$LEARNED_HINTS placeholder block (Phase B)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task B.5: Wire `injectHints` into orchestrator pre-spawn (with feature flag)

**Files:**
- Modify: `services/pipeline-orchestrator.mjs`
- Create: `tests/services/orchestrator-injection.test.mjs`

- [ ] **Step 1: Write the failing test (orchestrator hint injection)**

Create `tests/services/orchestrator-injection.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertPattern } from '../../services/db.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPreambleWithHints } from '../../services/pipeline-orchestrator.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-inj-'));
  const db = openDb(join(dir, 'work.db'));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('renderPreambleWithHints substitutes top-3 hints when FEATURE_FAILURE_KB=1', () => {
  const { db, cleanup } = setup();
  const orig = process.env.FEATURE_FAILURE_KB;
  process.env.FEATURE_FAILURE_KB = '1';
  try {
    upsertPattern(db, { signature: 'lever:a', hint: 'A', runId: 1 });
    upsertPattern(db, { signature: 'lever:a', hint: 'A', runId: 2 }); // hits=2
    upsertPattern(db, { signature: 'lever:b', hint: 'B', runId: 3 });
    const template = '## Recent patterns for this host\n\n$LEARNED_HINTS';
    const rendered = renderPreambleWithHints(db, 'https://lever.co/x', template);
    assert.ok(rendered.includes('A'));
    assert.ok(rendered.includes('B'));
    assert.equal(rendered.includes('$LEARNED_HINTS'), false);
  } finally {
    process.env.FEATURE_FAILURE_KB = orig;
    cleanup();
  }
});

test('renderPreambleWithHints leaves $LEARNED_HINTS empty when FEATURE_FAILURE_KB=0', () => {
  const { db, cleanup } = setup();
  const orig = process.env.FEATURE_FAILURE_KB;
  process.env.FEATURE_FAILURE_KB = '0';
  try {
    upsertPattern(db, { signature: 'lever:a', hint: 'A', runId: 1 });
    const template = '## Recent patterns for this host\n\n$LEARNED_HINTS';
    const rendered = renderPreambleWithHints(db, 'https://lever.co/x', template);
    assert.equal(rendered.includes('A'), false);
  } finally {
    process.env.FEATURE_FAILURE_KB = orig;
    cleanup();
  }
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
node --test tests/services/orchestrator-injection.test.mjs 2>&1 | tail -5
```
Expected: 2 failures (renderPreambleWithHints not exported).

- [ ] **Step 3: Add `renderPreambleWithHints` to `services/pipeline-orchestrator.mjs`**

Near the existing `renderPreamble` function, add:

```javascript
import { topHintsByHost } from './db.mjs';

export function renderPreambleWithHints(db, url, template) {
  if (process.env.FEATURE_FAILURE_KB !== '1') {
    return template.replace(/\$LEARNED_HINTS/g, '');
  }
  let host = 'unknown';
  try { host = new URL(url).hostname.toLowerCase(); } catch {}
  const hints = topHintsByHost(db, host, 3);
  const bullets = hints.map(h => `- ${h.hint}`).join('\n');
  return template.replace(/\$LEARNED_HINTS/g, bullets);
}
```

In the existing `tickOnce()` (or whichever function builds the per-URL preamble before spawning), replace the line that calls `renderPreamble(template, vars)` to first apply `renderPreambleWithHints(db, url, template)`, then the existing substitution. The two passes compose: first hints, then `$URL`/`$RUN_ID`/etc.

- [ ] **Step 4: Run — confirm pass**

```bash
node --test tests/services/orchestrator-injection.test.mjs 2>&1 | tail -5
```
Expected: 2 pass.

- [ ] **Step 5: Confirm existing orchestrator tests still green**

```bash
node --test tests/services/orchestrator.test.mjs tests/services/orchestrator-logging.test.mjs 2>&1 | tail -5
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add services/pipeline-orchestrator.mjs tests/services/orchestrator-injection.test.mjs
git commit -m "feat(orchestrator): pre-spawn injectHints via renderPreambleWithHints (Phase B, flag-gated)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task B.6: Wire `learnFromFailure` into orchestrator post-fail branch

**Files:**
- Modify: `services/pipeline-orchestrator.mjs`
- Create: `tests/e2e/learn-on-fail.e2e.mjs`

- [ ] **Step 1: Write the failing e2e test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../services/db.mjs';
import { learnFromFailure } from '../../services/failure-kb.mjs';

test('e2e: post-fail branch calls learnFromFailure and upserts pattern', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-lof-'));
  const dbPath = join(root, 'work.db');
  const reviewDir = join(root, 'kb-review-queue');
  const db = openDb(dbPath);
  try {
    db.prepare(`INSERT INTO runs (id, url, status, exit_code, created_at)
                VALUES (?, ?, 'fail', 1, ?)`)
      .run(101, 'https://lever.co/abc', '2026-05-25T10:00:00.000Z');
    const claudeLog = 'Error: scrapling fetch failed: HTTP 403 Forbidden\nCloudflare challenge detected';
    const r = await learnFromFailure(db, 101, claudeLog, { url: 'https://lever.co/abc', reviewDir });
    assert.equal(r.kind, 'learned');
    const row = db.prepare('SELECT * FROM failure_patterns WHERE signature=?').get(r.signature);
    assert.equal(row.hits, 1);
    assert.equal(row.last_run_id, 101);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run — confirm pass (this exercises the public surface; orchestrator integration follows)**

```bash
node --test tests/e2e/learn-on-fail.e2e.mjs 2>&1 | tail -5
```
Expected: 1 pass (uses existing learnFromFailure from Task B.3).

- [ ] **Step 3: Wire orchestrator's post-fail bookkeeping**

In `services/pipeline-orchestrator.mjs`, locate the post-fail branch (where `mark-fail` runs after a non-zero `claude -p` exit). Add immediately before the mark-fail call:

```javascript
import { learnFromFailure } from './failure-kb.mjs';
import { readFileSync, existsSync } from 'node:fs';

// ... inside the post-fail handler, after exitCode is known and runId is known:
if (process.env.FEATURE_FAILURE_KB === '1') {
  try {
    const logPath = `ops/runs/${runId}/claude.log`;
    let errorText = '';
    if (existsSync(logPath)) {
      const full = readFileSync(logPath, 'utf8');
      errorText = full.slice(-4096); // last 4 KB
    }
    const result = await learnFromFailure(db, runId, errorText, {
      url, reviewDir: 'ops/kb-review-queue'
    });
    log.info({ event: 'failure_kb_result', runId, kind: result.kind, signature: result.signature }, 'learnFromFailure complete');
    if (result.kind === 'review-queued') {
      await notifier.tg(`⚠️ New fault signature observed at ${new URL(url).hostname}\nSnippet: ${result.snippet}\nReview ops/kb-review-queue/${runId}.json`);
    }
  } catch (e) {
    log.warn({ event: 'failure_kb_threw', err: e.message }, 'learnFromFailure threw; continuing');
  }
}
```

- [ ] **Step 4: Re-run orchestrator's existing tests (must stay green)**

```bash
node --test tests/services/orchestrator.test.mjs 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add services/pipeline-orchestrator.mjs tests/e2e/learn-on-fail.e2e.mjs
git commit -m "feat(orchestrator): post-fail learnFromFailure with review-queue notifications (Phase B, flag-gated)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task B.7: Add Phase B e2e — hint-injection roundtrip

**Files:**
- Create: `tests/bin/claude-stub.mjs` (test stub `claude` binary)
- Create: `tests/e2e/hint-injection.e2e.mjs`

- [ ] **Step 1: Create the `claude-stub.mjs` test binary**

```javascript
#!/usr/bin/env node
// Stub `claude` binary used only by e2e tests. Writes its received preamble
// (the stdin or first prompt arg) to STUB_CAPTURE_PATH, then exits cleanly.
import { writeFileSync, appendFileSync } from 'node:fs';

const capture = process.env.STUB_CAPTURE_PATH || '/tmp/claude-stub-capture.txt';
const idx = process.argv.indexOf('-p');
const prompt = idx >= 0 ? process.argv[idx + 1] : '';
writeFileSync(capture, prompt);
appendFileSync(capture + '.argv', JSON.stringify(process.argv) + '\n');
process.exit(process.env.STUB_EXIT_CODE ? Number(process.env.STUB_EXIT_CODE) : 0);
```

Make executable:
```bash
chmod +x tests/bin/claude-stub.mjs
```

- [ ] **Step 2: Write the e2e test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, upsertPattern } from '../../services/db.mjs';
import { renderPreambleWithHints } from '../../services/pipeline-orchestrator.mjs';

test('e2e: pre-spawn hint injection — top 3 hints visible in preamble', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-hi-'));
  const dbPath = join(root, 'work.db');
  const db = openDb(dbPath);
  const orig = process.env.FEATURE_FAILURE_KB;
  process.env.FEATURE_FAILURE_KB = '1';
  try {
    for (const sig of ['lever:a', 'lever:a', 'lever:a', 'lever:b', 'lever:b', 'lever:c', 'lever:d', 'lever:e']) {
      upsertPattern(db, { signature: sig, hint: `H-${sig.split(':')[1]}`, runId: 1 });
    }
    const template = '## Recent patterns for this host\n\n$LEARNED_HINTS\n';
    const rendered = renderPreambleWithHints(db, 'https://lever.co/jobs/123', template);
    const lines = rendered.split('\n').filter(l => l.startsWith('- '));
    assert.equal(lines.length, 3);  // cap honored
    assert.ok(lines.some(l => l.includes('H-a')));  // top by hits
  } finally {
    process.env.FEATURE_FAILURE_KB = orig;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run — confirm pass**

```bash
node --test tests/e2e/hint-injection.e2e.mjs 2>&1 | tail -5
```
Expected: 1 pass.

- [ ] **Step 4: Commit**

```bash
git add tests/bin/claude-stub.mjs tests/e2e/hint-injection.e2e.mjs
git commit -m "test(e2e): hint-injection roundtrip + claude-stub binary (Phase B)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task B.8: Add Phase B e2e — unknown fault → review queue + Telegram

**Files:**
- Create: `tests/e2e/unknown-fault-routing.e2e.mjs`

- [ ] **Step 1: Write the e2e**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../services/db.mjs';
import { learnFromFailure } from '../../services/failure-kb.mjs';

test('e2e: unknown fault writes review-queue JSON + signals review-queued', async () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-unk-'));
  const dbPath = join(root, 'work.db');
  const reviewDir = join(root, 'kb-review-queue');
  const db = openDb(dbPath);
  try {
    const r = await learnFromFailure(
      db, 555,
      'A completely unknown failure mode XYZ-987 nothing matches',
      { url: 'https://novel-host.test', reviewDir }
    );
    assert.equal(r.kind, 'review-queued');
    const files = readdirSync(reviewDir);
    assert.equal(files.length, 1);
    const body = JSON.parse(readFileSync(join(reviewDir, files[0]), 'utf8'));
    assert.equal(body.run_id, 555);
    assert.ok(body.snippet.includes('XYZ-987'));
    assert.ok(body.full_error.includes('XYZ-987'));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run — confirm pass**

```bash
node --test tests/e2e/unknown-fault-routing.e2e.mjs 2>&1 | tail -5
```
Expected: 1 pass.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/unknown-fault-routing.e2e.mjs
git commit -m "test(e2e): unknown fault → review-queue routing (Phase B)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task B.9: Add Telegram `/patterns` command

**Files:**
- Modify: `services/telegram-listener.mjs`
- Create: `tests/services/telegram-commands.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/services/telegram-commands.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, upsertPattern } from '../../services/db.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-cmd-'));
  const db = openDb(join(dir, 'work.db'));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('/patterns returns top 10 by hits DESC as markdown', async () => {
  const { handlePatterns } = await import('../../services/telegram-listener.mjs');
  const { db, cleanup } = setup();
  try {
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j <= i; j++) {
        upsertPattern(db, { signature: `sig-${i}`, hint: `H${i}`, runId: 1 });
      }
    }
    const reply = handlePatterns(db);
    const lines = reply.split('\n').filter(l => l.startsWith('|') || l.startsWith('-'));
    // 12 patterns inserted; expect 10 rows
    assert.ok(reply.includes('sig-11'));
    assert.ok(reply.includes('sig-2'));  // top patterns (highest hits)
    assert.equal(reply.includes('sig-0'), false); // not in top 10
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
node --test tests/services/telegram-commands.test.mjs 2>&1 | tail -5
```

- [ ] **Step 3: Add `handlePatterns` to `services/telegram-listener.mjs`**

```javascript
export function handlePatterns(db) {
  const rows = db.prepare(`
    SELECT signature, hits, last_seen, suppressed
    FROM failure_patterns
    ORDER BY hits DESC LIMIT 10
  `).all();
  if (rows.length === 0) return '*No patterns learned yet.*';
  const header = '| signature | hits | last_seen | suppressed |\n|---|---|---|---|';
  const body = rows.map(r =>
    `| \`${r.signature}\` | ${r.hits} | ${r.last_seen.slice(0,10)} | ${r.suppressed ? '✓' : ''} |`
  ).join('\n');
  return `*Top 10 failure patterns:*\n\n${header}\n${body}`;
}
```

Then in the existing command dispatcher (search for `if (text === '/status')` or similar), add:

```javascript
} else if (text === '/patterns') {
  if (!isAllowed(chatId)) return;
  const reply = handlePatterns(db);
  await sendMessage(chatId, reply, { parse_mode: 'Markdown' });
```

- [ ] **Step 4: Run — confirm pass**

```bash
node --test tests/services/telegram-commands.test.mjs 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add services/telegram-listener.mjs tests/services/telegram-commands.test.mjs
git commit -m "feat(telegram): /patterns command lists top 10 failure_patterns rows (Phase B)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task B.10: Add Telegram `/suppress <signature>` command

**Files:**
- Modify: `services/telegram-listener.mjs`
- Modify: `tests/services/telegram-commands.test.mjs`

- [ ] **Step 1: Add failing test**

Append:

```javascript
test('/suppress sets suppressed=1 on matching signature', async () => {
  const { handleSuppress } = await import('../../services/telegram-listener.mjs');
  const { db, cleanup } = setup();
  try {
    upsertPattern(db, { signature: 'sig-x', hint: 'h', runId: 1 });
    const reply = handleSuppress(db, 'sig-x');
    const row = db.prepare('SELECT suppressed FROM failure_patterns WHERE signature=?').get('sig-x');
    assert.equal(row.suppressed, 1);
    assert.match(reply, /suppressed/i);
  } finally { cleanup(); }
});

test('/suppress unknown signature returns error reply', async () => {
  const { handleSuppress } = await import('../../services/telegram-listener.mjs');
  const { db, cleanup } = setup();
  try {
    const reply = handleSuppress(db, 'never-existed');
    assert.match(reply, /not found|no such/i);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run — confirm failure**

- [ ] **Step 3: Add `handleSuppress` to `services/telegram-listener.mjs`**

```javascript
export function handleSuppress(db, signature) {
  const r = db.prepare('UPDATE failure_patterns SET suppressed=1 WHERE signature=?').run(signature);
  if (r.changes === 0) return `❌ Signature \`${signature}\` not found.`;
  return `✅ Suppressed \`${signature}\`. Future runs won't inject its hint.`;
}
```

Dispatch:
```javascript
} else if (text.startsWith('/suppress ')) {
  if (!isAllowed(chatId)) return;
  const sig = text.slice('/suppress '.length).trim();
  await sendMessage(chatId, handleSuppress(db, sig), { parse_mode: 'Markdown' });
```

- [ ] **Step 4: Run — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add services/telegram-listener.mjs tests/services/telegram-commands.test.mjs
git commit -m "feat(telegram): /suppress <signature> sets suppressed=1 (Phase B)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task B.11: Add Phase B e2e — `/suppress` removes hint from injection

**Files:**
- Create: `tests/e2e/suppress-cmd.e2e.mjs`

- [ ] **Step 1: Write e2e**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, upsertPattern, topHintsByHost } from '../../services/db.mjs';
import { handleSuppress } from '../../services/telegram-listener.mjs';

test('e2e: /suppress removes hint from topHintsByHost', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-supp-'));
  const db = openDb(join(root, 'work.db'));
  try {
    upsertPattern(db, { signature: 'lever:bad-hint', hint: 'BAD', runId: 1 });
    let hints = topHintsByHost(db, 'lever.co');
    assert.equal(hints.length, 1);
    handleSuppress(db, 'lever:bad-hint');
    hints = topHintsByHost(db, 'lever.co');
    assert.equal(hints.length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run — confirm pass**

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/suppress-cmd.e2e.mjs
git commit -m "test(e2e): /suppress removes hint from injection lookup (Phase B)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task B.12: Add `smoke-cloud --phase=B` (DB snapshot smoke)

**Files:**
- Modify: `tools/smoke-cloud.mjs`

- [ ] **Step 1: Add Phase B smoke function**

Replace the `Not yet implemented` Phase B branch in `tools/smoke-cloud.mjs` with:

```javascript
async function smokePhaseB() {
  console.log('[smoke B] Verifying failure_patterns table is queryable...');
  const { openDb, topHintsByHost } = await import('../services/db.mjs');
  const db = openDb('ops/work-queue.db');
  try {
    const cols = db.prepare("PRAGMA table_info(failure_patterns)").all();
    if (cols.length === 0) { console.error('[smoke B] FAIL — failure_patterns table missing'); process.exit(2); }
    const hints = topHintsByHost(db, 'lever.co', 3);
    console.log(`[smoke B] OK — table present, returned ${hints.length} hint(s) for lever.co`);
  } finally { db.close(); }
}
```

And add to dispatch:

```javascript
if (phase === 'B' || phase === 'all') await smokePhaseB();
```

- [ ] **Step 2: Run against repo's working ops/work-queue.db**

```bash
node tools/smoke-cloud.mjs --phase=B 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add tools/smoke-cloud.mjs
git commit -m "feat(smoke): --phase=B verifies failure_patterns table queryable (Phase B)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task B.13: Phase B gate — full sweep

**Files:** read-only

- [ ] **Step 1: Run all Phase B tests**

```bash
node --test tests/services/failure-kb.test.mjs tests/services/telegram-commands.test.mjs tests/services/orchestrator-injection.test.mjs tests/services/db-extensions.test.mjs 2>&1 | tail -5
```

- [ ] **Step 2: Run all Phase B e2e**

```bash
node --test tests/e2e/hint-injection.e2e.mjs tests/e2e/learn-on-fail.e2e.mjs tests/e2e/unknown-fault-routing.e2e.mjs tests/e2e/suppress-cmd.e2e.mjs 2>&1 | tail -5
```

- [ ] **Step 3: Existing suite still green**

```bash
npm test 2>&1 | tail -3
```

- [ ] **Step 4: Commit (empty if clean)**

```bash
git commit --allow-empty -m "chore: Phase B test sweep clean

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

Phase B code-complete.

---

## Phase C — Watchdog + heartbeat

### Task C.1: Add `paused` column to `work_queue` + orchestrator gate

**Files:**
- Modify: `services/db.mjs`
- Modify: `services/pipeline-orchestrator.mjs`
- Modify: `tests/services/db-extensions.test.mjs`

- [ ] **Step 1: Add failing test**

Append:

```javascript
test('work_queue paused column defaults to 0 and is added idempotently', () => {
  const { path, cleanup } = tmpDb();
  try {
    const db1 = openDb(path); db1.close();
    const db2 = openDb(path);
    const cols = db2.prepare("PRAGMA table_info(work_queue)").all();
    const paused = cols.find(c => c.name === 'paused');
    assert.ok(paused);
    assert.equal(paused.dflt_value, '0');
    db2.close();
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run — confirm failure**

- [ ] **Step 3: Add `paused` migration in `services/db.mjs`**

Inside `openDb()` after `failure_patterns`:

```javascript
const hasPaused = db.prepare("PRAGMA table_info(work_queue)").all().some(c => c.name === 'paused');
if (!hasPaused) {
  db.exec('ALTER TABLE work_queue ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
}
```

- [ ] **Step 4: Modify orchestrator's spawn-tick to respect paused**

In `services/pipeline-orchestrator.mjs`, find the SELECT that pulls the next queued URL. Add a WHERE clause:

```sql
-- before: WHERE status = 'queued'
-- after:  WHERE status = 'queued' AND paused = 0
```

- [ ] **Step 5: Run — confirm pass**

- [ ] **Step 6: Commit**

```bash
git add services/db.mjs services/pipeline-orchestrator.mjs tests/services/db-extensions.test.mjs
git commit -m "feat(db,orchestrator): add paused column on work_queue + orchestrator respects it (Phase C)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C.2: Add `/unpause` Telegram command

**Files:**
- Modify: `services/telegram-listener.mjs`
- Modify: `tests/services/telegram-commands.test.mjs`

- [ ] **Step 1: Add failing test**

```javascript
test('/unpause clears paused=1 on work_queue rows', async () => {
  const { handleUnpause } = await import('../../services/telegram-listener.mjs');
  const { db, cleanup } = setup();
  try {
    db.prepare(`INSERT INTO work_queue (url, status, paused) VALUES ('https://x.test', 'queued', 1)`).run();
    db.prepare(`INSERT INTO work_queue (url, status, paused) VALUES ('https://y.test', 'queued', 1)`).run();
    const reply = handleUnpause(db);
    const n = db.prepare("SELECT count(*) c FROM work_queue WHERE paused=0").get().c;
    assert.equal(n, 2);
    assert.match(reply, /resumed/i);
    assert.match(reply, /2/);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run — confirm failure**

- [ ] **Step 3: Add `handleUnpause`**

```javascript
export function handleUnpause(db) {
  const r = db.prepare('UPDATE work_queue SET paused=0 WHERE paused=1').run();
  return `✅ Queue resumed; ${r.changes} row(s) unpaused.`;
}
```

Dispatch:
```javascript
} else if (text === '/unpause') {
  if (!isAllowed(chatId)) return;
  await sendMessage(chatId, handleUnpause(db));
```

- [ ] **Step 4: Run — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add services/telegram-listener.mjs tests/services/telegram-commands.test.mjs
git commit -m "feat(telegram): /unpause clears paused=1 on work_queue (Phase C operator surface)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C.3: Add heartbeat ping to orchestrator boot

**Files:**
- Modify: `services/pipeline-orchestrator.mjs`
- Create: `tests/services/orchestrator-heartbeat.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/services/orchestrator-heartbeat.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('startHeartbeat returns a function that does nothing when HEALTHCHECK_PING_URL is missing', async () => {
  const { startHeartbeat } = await import('../../services/pipeline-orchestrator.mjs');
  const orig = process.env.HEALTHCHECK_PING_URL;
  delete process.env.HEALTHCHECK_PING_URL;
  try {
    let called = false;
    const fn = startHeartbeat({ httpClient: async () => { called = true; return { ok: true }; }, intervalMs: 10 });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(called, false);
    if (typeof fn === 'function') fn();
  } finally { if (orig) process.env.HEALTHCHECK_PING_URL = orig; }
});

test('startHeartbeat pings HEALTHCHECK_PING_URL on interval', async () => {
  const { startHeartbeat } = await import('../../services/pipeline-orchestrator.mjs');
  process.env.HEALTHCHECK_PING_URL = 'https://hc.test/ping';
  try {
    let calls = 0;
    const stop = startHeartbeat({ httpClient: async (url) => { if (url === 'https://hc.test/ping') calls++; return { ok: true }; }, intervalMs: 20 });
    await new Promise(r => setTimeout(r, 70));
    stop();
    assert.ok(calls >= 2);
  } finally { delete process.env.HEALTHCHECK_PING_URL; }
});

test('startHeartbeat never throws on fetch failure', async () => {
  const { startHeartbeat } = await import('../../services/pipeline-orchestrator.mjs');
  process.env.HEALTHCHECK_PING_URL = 'https://hc.test/ping';
  try {
    const stop = startHeartbeat({ httpClient: async () => { throw new Error('network unreachable'); }, intervalMs: 10 });
    await new Promise(r => setTimeout(r, 40));
    stop(); // should not have crashed
    assert.ok(true);
  } finally { delete process.env.HEALTHCHECK_PING_URL; }
});
```

- [ ] **Step 2: Run — confirm failure**

- [ ] **Step 3: Add `startHeartbeat` to `services/pipeline-orchestrator.mjs`**

Near the top, after imports, add:

```javascript
export function startHeartbeat({ httpClient = fetch, intervalMs = 60_000 } = {}) {
  if (!process.env.HEALTHCHECK_PING_URL) return () => {};
  const url = process.env.HEALTHCHECK_PING_URL;
  const handle = setInterval(() => {
    httpClient(url).catch(() => {});
  }, intervalMs);
  if (handle.unref) handle.unref();
  return () => clearInterval(handle);
}
```

In the orchestrator's main bootstrap (where `tickLoop` starts), add:

```javascript
if (process.env.FEATURE_WATCHDOG === '1') {
  startHeartbeat();
  log.info({ event: 'heartbeat_started' }, 'Healthchecks heartbeat ping started');
}
```

- [ ] **Step 4: Run — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add services/pipeline-orchestrator.mjs tests/services/orchestrator-heartbeat.test.mjs
git commit -m "feat(orchestrator): startHeartbeat + Healthchecks.io pings (Phase C, flag-gated)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C.4: Create `services/watchdog.mjs` skeleton + journalctl line parser

**Files:**
- Create: `services/watchdog.mjs`
- Create: `tests/services/watchdog.test.mjs`
- Create: `tests/fixtures/journald/oom-killed.jsonl`
- Create: `tests/fixtures/journald/healthy.jsonl`

- [ ] **Step 1: Create fixtures**

`tests/fixtures/journald/oom-killed.jsonl`:
```
{"__REALTIME_TIMESTAMP":"1748169600000000","_SYSTEMD_USER_UNIT":"pipeline-orchestrator.service","MESSAGE":"Out of memory: Killed process 1234 (node) total-vm:..."}
```

`tests/fixtures/journald/healthy.jsonl`:
```
{"__REALTIME_TIMESTAMP":"1748169600000000","_SYSTEMD_USER_UNIT":"pipeline-orchestrator.service","MESSAGE":"tick: queue empty"}
{"__REALTIME_TIMESTAMP":"1748169660000000","_SYSTEMD_USER_UNIT":"pipeline-orchestrator.service","MESSAGE":"tick: queue empty"}
```

- [ ] **Step 2: Write failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('parseJournaldLine returns null on garbage', async () => {
  const { parseJournaldLine } = await import('../../services/watchdog.mjs');
  assert.equal(parseJournaldLine('not json'), null);
  assert.equal(parseJournaldLine(''), null);
});

test('parseJournaldLine extracts MESSAGE + unit + timestamp', async () => {
  const { parseJournaldLine } = await import('../../services/watchdog.mjs');
  const raw = readFileSync('tests/fixtures/journald/oom-killed.jsonl', 'utf8').trim();
  const evt = parseJournaldLine(raw);
  assert.equal(evt.unit, 'pipeline-orchestrator.service');
  assert.match(evt.message, /Out of memory/);
  assert.ok(evt.timestampMs > 0);
});
```

- [ ] **Step 3: Run — confirm failure**

- [ ] **Step 4: Create `services/watchdog.mjs` skeleton**

```javascript
import { createLogger } from './logger.mjs';

const log = createLogger({ name: 'watchdog' });

export function parseJournaldLine(line) {
  try {
    const j = JSON.parse(line);
    return {
      timestampMs: Math.floor(Number(j.__REALTIME_TIMESTAMP) / 1000),
      unit: j._SYSTEMD_USER_UNIT || '',
      message: j.MESSAGE || ''
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run — confirm pass**

- [ ] **Step 6: Commit**

```bash
git add services/watchdog.mjs tests/services/watchdog.test.mjs tests/fixtures/journald/
git commit -m "feat(watchdog): skeleton + parseJournaldLine + initial fixtures (Phase C)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C.5: Add OOM remediation rule (rule 1 of 5)

**Files:**
- Modify: `services/watchdog.mjs`
- Modify: `tests/services/watchdog.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
test('OOM rule matches "Out of memory: Killed"', async () => {
  const { matchOom } = await import('../../services/watchdog.mjs');
  assert.ok(matchOom('Out of memory: Killed process 1234'));
  assert.equal(matchOom('regular log line'), false);
});

test('remediateOom clears /tmp/yash-pipeline-* (or no-op if empty)', async () => {
  const { remediateOom } = await import('../../services/watchdog.mjs');
  const calls = [];
  const stub = { execSync: (cmd) => calls.push(cmd) };
  await remediateOom({ exec: stub.execSync });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /rm.*yash-pipeline/);
});

test('OOM remediation is idempotent', async () => {
  const { remediateOom } = await import('../../services/watchdog.mjs');
  const calls = [];
  await remediateOom({ exec: (c) => calls.push(c) });
  await remediateOom({ exec: (c) => calls.push(c) });
  assert.equal(calls.length, 2);  // both call rm, both safe
});
```

- [ ] **Step 2: Run — confirm failure**

- [ ] **Step 3: Add OOM rule + remediation**

Append:

```javascript
import { execSync as defaultExec } from 'node:child_process';

export function matchOom(message) {
  return /out of memory.*killed/i.test(message);
}

export async function remediateOom({ exec = defaultExec, db, runId = null } = {}) {
  try { exec('rm -rf /tmp/yash-pipeline-* 2>/dev/null || true'); } catch {}
  if (db) {
    const { upsertPattern } = await import('./db.mjs');
    upsertPattern(db, {
      signature: 'watchdog:oom-cleared',
      hint: 'OOM observed; /tmp cleared by watchdog. Next spawn fresh.',
      runId: runId ?? 0
    });
  }
  log.info({ event: 'watchdog_oom_remediated' }, 'OOM remediated');
}
```

- [ ] **Step 4: Run — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add services/watchdog.mjs tests/services/watchdog.test.mjs
git commit -m "feat(watchdog): OOM rule + remediation (clear /tmp + KB UPSERT) (Phase C rule 1/5)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C.6: Add tectonic-missing-file rule (rule 2 of 5)

**Files:**
- Modify: `services/watchdog.mjs`
- Modify: `tests/services/watchdog.test.mjs`
- Create: `tests/fixtures/journald/tectonic-missing-file.jsonl`

- [ ] **Step 1: Create fixture**

```
{"__REALTIME_TIMESTAMP":"1748169600000000","_SYSTEMD_USER_UNIT":"pipeline-orchestrator.service","MESSAGE":"tectonic: exit 1"}
{"__REALTIME_TIMESTAMP":"1748169605000000","_SYSTEMD_USER_UNIT":"pipeline-orchestrator.service","MESSAGE":"LaTeX Error: File `foo.sty' not found"}
```

- [ ] **Step 2: Write failing test**

```javascript
test('tectonic rule matches "tectonic exit" + "File ... not found" within 30s', async () => {
  const { matchTectonic } = await import('../../services/watchdog.mjs');
  assert.ok(matchTectonic(
    [{ message: 'tectonic: exit 1', timestampMs: 1748169600000 },
     { message: "LaTeX Error: File `foo.sty' not found", timestampMs: 1748169605000 }]
  ));
});

test('tectonic rule does NOT match when entries are >30s apart', async () => {
  const { matchTectonic } = await import('../../services/watchdog.mjs');
  assert.equal(matchTectonic(
    [{ message: 'tectonic: exit 1', timestampMs: 1748169600000 },
     { message: "LaTeX Error: File `foo.sty' not found", timestampMs: 1748169700000 }]
  ), false);
});
```

- [ ] **Step 3: Run — confirm failure**

- [ ] **Step 4: Implement**

```javascript
export function matchTectonic(events) {
  // events: recent window (last ~60s) of {message, timestampMs}
  const exits = events.filter(e => /tectonic.*exit/i.test(e.message));
  const missing = events.filter(e => /latex error.*file .* not found/i.test(e.message));
  for (const a of exits) for (const b of missing) {
    if (Math.abs(a.timestampMs - b.timestampMs) <= 30_000) return true;
  }
  return false;
}

export async function remediateTectonic({ db, runId } = {}) {
  if (db) {
    const { upsertPattern } = await import('./db.mjs');
    upsertPattern(db, {
      signature: 'watchdog:tectonic-missing-file',
      hint: 'tectonic missing-file detected; re-run with --keep-logs to capture cache state.',
      runId: runId ?? 0
    });
  }
  log.info({ event: 'watchdog_tectonic_remediated' }, 'tectonic missing-file remediated');
}
```

- [ ] **Step 5: Run — confirm pass**

- [ ] **Step 6: Commit**

```bash
git add services/watchdog.mjs tests/services/watchdog.test.mjs tests/fixtures/journald/tectonic-missing-file.jsonl
git commit -m "feat(watchdog): tectonic-missing-file rule (Phase C rule 2/5)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C.7: Add host repeat-403 rule (rule 3 of 5)

**Files:**
- Modify: `services/watchdog.mjs`
- Modify: `tests/services/watchdog.test.mjs`
- Create: `tests/fixtures/journald/scrapling-403.jsonl`

- [ ] **Step 1: Create fixture**

```
{"__REALTIME_TIMESTAMP":"1748169600000000","_SYSTEMD_USER_UNIT":"pipeline-orchestrator.service","MESSAGE":"scrapling fetch failed 403 for https://lever.co/abc"}
{"__REALTIME_TIMESTAMP":"1748170200000000","_SYSTEMD_USER_UNIT":"pipeline-orchestrator.service","MESSAGE":"scrapling fetch failed 403 for https://lever.co/def"}
```

- [ ] **Step 2: Write failing test**

```javascript
test('host-cooldown rule matches two 403s on same host within 30 min', async () => {
  const { matchHostCooldown } = await import('../../services/watchdog.mjs');
  const result = matchHostCooldown([
    { message: 'scrapling fetch failed 403 for https://lever.co/abc', timestampMs: 1748169600000 },
    { message: 'scrapling fetch failed 403 for https://lever.co/def', timestampMs: 1748170200000 }
  ]);
  assert.equal(result.host, 'lever.co');
});

test('host-cooldown rule ignores >30min gap', async () => {
  const { matchHostCooldown } = await import('../../services/watchdog.mjs');
  const result = matchHostCooldown([
    { message: 'scrapling fetch failed 403 for https://lever.co/abc', timestampMs: 1748169600000 },
    { message: 'scrapling fetch failed 403 for https://lever.co/def', timestampMs: 1748169600000 + 31 * 60 * 1000 }
  ]);
  assert.equal(result, null);
});
```

- [ ] **Step 3: Run — confirm failure**

- [ ] **Step 4: Implement**

```javascript
export function matchHostCooldown(events) {
  const re = /scrapling.*403 for (https?:\/\/[^\s]+)/i;
  const hits = events.map(e => {
    const m = e.message.match(re);
    if (!m) return null;
    try { return { host: new URL(m[1]).hostname.toLowerCase(), ts: e.timestampMs }; } catch { return null; }
  }).filter(Boolean);
  for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
    if (hits[i].host === hits[j].host && Math.abs(hits[i].ts - hits[j].ts) <= 30 * 60 * 1000) {
      return { host: hits[i].host };
    }
  }
  return null;
}

export async function remediateHostCooldown({ host, db, runId } = {}) {
  if (db) {
    const { upsertPattern } = await import('./db.mjs');
    upsertPattern(db, {
      signature: `watchdog:host-cooldown:${host}`,
      hint: `Two 403s on ${host} within 30 min; wait 30 min before retry.`,
      runId: runId ?? 0
    });
  }
}
```

- [ ] **Step 5: Run — confirm pass**

- [ ] **Step 6: Commit**

```bash
git add services/watchdog.mjs tests/services/watchdog.test.mjs tests/fixtures/journald/scrapling-403.jsonl
git commit -m "feat(watchdog): host-cooldown rule (Phase C rule 3/5)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C.8: Add heartbeat-miss rule (rule 4 of 5)

**Files:**
- Modify: `services/watchdog.mjs`
- Modify: `tests/services/watchdog.test.mjs`
- Create: `tests/fixtures/journald/heartbeat-quiet.jsonl`

- [ ] **Step 1: Create fixture (10+ min gap)**

```
{"__REALTIME_TIMESTAMP":"1748169600000000","_SYSTEMD_USER_UNIT":"pipeline-orchestrator.service","MESSAGE":"tick"}
{"__REALTIME_TIMESTAMP":"1748170300000000","_SYSTEMD_USER_UNIT":"pipeline-orchestrator.service","MESSAGE":"tick"}
```

(700s gap = 11.6 min, exceeds 10-min threshold.)

- [ ] **Step 2: Write failing test**

```javascript
test('heartbeat-miss rule fires when last orchestrator log >10min ago', async () => {
  const { matchHeartbeatMiss } = await import('../../services/watchdog.mjs');
  const now = 1748170400000;
  const lastLogTs = now - 11 * 60 * 1000;
  assert.equal(matchHeartbeatMiss({ lastLogTs, now }), true);
});

test('heartbeat-miss rule does not fire at exactly 10min', async () => {
  const { matchHeartbeatMiss } = await import('../../services/watchdog.mjs');
  const now = 1748170400000;
  const lastLogTs = now - 9 * 60 * 1000;
  assert.equal(matchHeartbeatMiss({ lastLogTs, now }), false);
});
```

- [ ] **Step 3: Run — confirm failure**

- [ ] **Step 4: Implement**

```javascript
export function matchHeartbeatMiss({ lastLogTs, now = Date.now() }) {
  if (!lastLogTs) return false;
  return (now - lastLogTs) > 10 * 60 * 1000;
}

export async function remediateHeartbeatMiss({ exec = defaultExec, db } = {}) {
  try { exec('systemctl --user restart pipeline-orchestrator'); } catch {}
  if (db) {
    const { upsertPattern } = await import('./db.mjs');
    upsertPattern(db, {
      signature: 'watchdog:orchestrator-restart',
      hint: 'orchestrator silent >10min; restarted by watchdog.',
      runId: 0
    });
  }
}
```

- [ ] **Step 5: Run — confirm pass**

- [ ] **Step 6: Commit**

```bash
git add services/watchdog.mjs tests/services/watchdog.test.mjs tests/fixtures/journald/heartbeat-quiet.jsonl
git commit -m "feat(watchdog): heartbeat-miss rule + restart remediation (Phase C rule 4/5)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C.9: Add disk-free rule (rule 5 of 5)

**Files:**
- Modify: `services/watchdog.mjs`
- Modify: `tests/services/watchdog.test.mjs`

- [ ] **Step 1: Write failing test**

```javascript
test('disk-pause rule fires at <1G free', async () => {
  const { matchDiskPause } = await import('../../services/watchdog.mjs');
  assert.equal(matchDiskPause({ freeGb: 0.5 }), true);
  assert.equal(matchDiskPause({ freeGb: 0.99 }), true);
  assert.equal(matchDiskPause({ freeGb: 1.0 }), false);
  assert.equal(matchDiskPause({ freeGb: 4.0 }), false);
});

test('readDiskFreeGb parses df output', async () => {
  const { readDiskFreeGb } = await import('../../services/watchdog.mjs');
  const fakeDf = "Filesystem      1G-blocks  Used Available Use% Mounted on\n/dev/vda1            40G   38G        2G  95% /\n";
  assert.equal(readDiskFreeGb({ dfOutput: fakeDf }), 2);
});
```

- [ ] **Step 2: Run — confirm failure**

- [ ] **Step 3: Implement**

```javascript
export function readDiskFreeGb({ dfOutput, exec = defaultExec } = {}) {
  const out = dfOutput ?? exec('df -BG / 2>/dev/null', { encoding: 'utf8' });
  const lines = out.trim().split('\n');
  if (lines.length < 2) return Infinity;
  const cols = lines[1].split(/\s+/);
  // cols: [Filesystem, 1G-blocks, Used, Available, Use%, Mounted]
  const avail = cols[3] || '';
  return Number(avail.replace('G', '')) || Infinity;
}

export function matchDiskPause({ freeGb }) {
  return freeGb < 1.0;
}

export async function remediateDiskPause({ db, notifier } = {}) {
  if (db) {
    db.prepare('UPDATE work_queue SET paused=1 WHERE status=\'queued\'').run();
    const { upsertPattern } = await import('./db.mjs');
    upsertPattern(db, {
      signature: 'watchdog:disk-pause',
      hint: 'disk <1G free; queue paused. Use /unpause after cleanup.',
      runId: 0
    });
  }
  if (notifier) await notifier.tg('🚨 Disk free <1 GB. Queue paused. Run /unpause after clean-up.');
}
```

- [ ] **Step 4: Run — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add services/watchdog.mjs tests/services/watchdog.test.mjs
git commit -m "feat(watchdog): disk-free rule + remediateDiskPause (Phase C rule 5/5)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C.10: Watchdog main loop with journalctl subprocess

**Files:**
- Modify: `services/watchdog.mjs`
- Modify: `tests/services/watchdog.test.mjs`

- [ ] **Step 1: Add tests for the main `runWatchdog` orchestrator**

```javascript
test('runWatchdog dispatches matched rules in correct order', async () => {
  const { runWatchdog } = await import('../../services/watchdog.mjs');
  const events = [];
  const fakeStream = (async function* () {
    yield JSON.stringify({ __REALTIME_TIMESTAMP: '1748169600000000', _SYSTEMD_USER_UNIT: 'pipeline-orchestrator.service', MESSAGE: 'Out of memory: Killed process' });
  })();
  const stub = { execCalls: [] };
  await runWatchdog({
    lineSource: fakeStream,
    db: null,
    notifier: { tg: async (m) => events.push(m) },
    exec: (c) => stub.execCalls.push(c),
    diskCheckIntervalMs: 999999,
    heartbeatCheckIntervalMs: 999999,
    maxEvents: 1
  });
  assert.ok(stub.execCalls.some(c => /rm.*yash-pipeline/.test(c)));
});
```

- [ ] **Step 2: Run — confirm failure**

- [ ] **Step 3: Implement `runWatchdog`**

```javascript
import { spawn } from 'node:child_process';

async function* journaldStream() {
  const proc = spawn('journalctl', ['--user', '-f', '-u', 'pipeline-orchestrator', '-u', 'telegram-listener', '-o', 'json'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  for await (const chunk of proc.stdout) {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
}

export async function runWatchdog(opts = {}) {
  const {
    lineSource = journaldStream(),
    db,
    notifier,
    exec = defaultExec,
    diskCheckIntervalMs = 5 * 60 * 1000,
    heartbeatCheckIntervalMs = 60 * 1000,
    maxEvents = Infinity
  } = opts;

  const recent = []; // ring buffer of recent {message, timestampMs, unit}
  const KEEP_MS = 60 * 60 * 1000;
  let lastOrchTs = Date.now();
  let processed = 0;

  const diskTimer = setInterval(async () => {
    try {
      const free = readDiskFreeGb({ exec });
      if (matchDiskPause({ freeGb: free })) await remediateDiskPause({ db, notifier });
    } catch {}
  }, diskCheckIntervalMs);
  diskTimer.unref && diskTimer.unref();

  const hbTimer = setInterval(async () => {
    if (matchHeartbeatMiss({ lastLogTs: lastOrchTs })) await remediateHeartbeatMiss({ exec, db });
  }, heartbeatCheckIntervalMs);
  hbTimer.unref && hbTimer.unref();

  try {
    for await (const line of lineSource) {
      const evt = parseJournaldLine(line);
      if (!evt) continue;
      recent.push(evt);
      while (recent.length && recent[0].timestampMs < Date.now() - KEEP_MS) recent.shift();
      if (evt.unit.startsWith('pipeline-orchestrator')) lastOrchTs = evt.timestampMs;

      if (matchOom(evt.message)) await remediateOom({ exec, db });
      if (matchTectonic(recent)) await remediateTectonic({ db });
      const hc = matchHostCooldown(recent);
      if (hc) await remediateHostCooldown({ host: hc.host, db });

      processed++;
      if (processed >= maxEvents) break;
    }
  } finally {
    clearInterval(diskTimer);
    clearInterval(hbTimer);
  }
}

export async function main() {
  if (process.env.FEATURE_WATCHDOG !== '1') { log.info({ event: 'watchdog_disabled' }); process.exit(0); }
  const { openDb } = await import('./db.mjs');
  const db = openDb(process.env.DB_PATH || 'ops/work-queue.db');
  const notifier = await import('./notifier.mjs');
  try { await runWatchdog({ db, notifier }); } finally { db.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add services/watchdog.mjs tests/services/watchdog.test.mjs
git commit -m "feat(watchdog): main loop with journalctl stream + 5-rule dispatch (Phase C)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C.11: Create `systemd/watchdog.service`

**Files:**
- Create: `systemd/watchdog.service`

- [ ] **Step 1: Write the unit**

```ini
[Unit]
Description=Yash pipeline self-improvement watchdog (Phase C)
After=pipeline-orchestrator.service
ConditionEnvironment=FEATURE_WATCHDOG=1

[Service]
Type=simple
EnvironmentFile=/etc/yash-pipeline/agent.env
WorkingDirectory=%h/yash-ai-automation-career
ExecStart=/usr/bin/node services/watchdog.mjs
Restart=always
RestartSec=10s
StandardOutput=journal
StandardError=journal
MemoryMax=128M

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Validate**

```bash
systemd-analyze verify systemd/watchdog.service 2>&1 || echo "(warnings OK)"
```

- [ ] **Step 3: Commit**

```bash
git add systemd/watchdog.service
git commit -m "feat(systemd): watchdog.service (Restart=always, MemoryMax=128M) (Phase C)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C.12: Phase C e2e tests (OOM + disk-pause)

**Files:**
- Create: `tests/e2e/watchdog-oom.e2e.mjs`
- Create: `tests/e2e/watchdog-disk-pause.e2e.mjs`

- [ ] **Step 1: Write OOM e2e**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../services/db.mjs';
import { runWatchdog } from '../../services/watchdog.mjs';

test('e2e: OOM journald line triggers remediation + KB row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wd-oom-'));
  const db = openDb(join(root, 'work.db'));
  const execCalls = [];
  const tgMsgs = [];
  const stream = (async function* () {
    yield JSON.stringify({ __REALTIME_TIMESTAMP: String(Date.now() * 1000), _SYSTEMD_USER_UNIT: 'pipeline-orchestrator.service', MESSAGE: 'Out of memory: Killed process 1234 (node)' });
  })();
  try {
    await runWatchdog({
      lineSource: stream, db,
      notifier: { tg: async (m) => tgMsgs.push(m) },
      exec: (c) => execCalls.push(c),
      diskCheckIntervalMs: 999999, heartbeatCheckIntervalMs: 999999, maxEvents: 1
    });
    assert.ok(execCalls.some(c => /rm.*yash-pipeline/.test(c)));
    const row = db.prepare("SELECT * FROM failure_patterns WHERE signature='watchdog:oom-cleared'").get();
    assert.ok(row);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Write disk-pause e2e**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../services/db.mjs';
import { remediateDiskPause } from '../../services/watchdog.mjs';

test('e2e: disk-pause remediation sets paused=1 + sends Telegram', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wd-disk-'));
  const db = openDb(join(root, 'work.db'));
  const tgMsgs = [];
  try {
    db.prepare(`INSERT INTO work_queue (url, status) VALUES ('https://x.test', 'queued')`).run();
    db.prepare(`INSERT INTO work_queue (url, status) VALUES ('https://y.test', 'queued')`).run();
    await remediateDiskPause({ db, notifier: { tg: async (m) => tgMsgs.push(m) } });
    const paused = db.prepare("SELECT count(*) c FROM work_queue WHERE paused=1").get().c;
    assert.equal(paused, 2);
    assert.equal(tgMsgs.length, 1);
    assert.match(tgMsgs[0], /disk/i);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run — confirm pass**

```bash
node --test tests/e2e/watchdog-oom.e2e.mjs tests/e2e/watchdog-disk-pause.e2e.mjs 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/watchdog-oom.e2e.mjs tests/e2e/watchdog-disk-pause.e2e.mjs
git commit -m "test(e2e): watchdog OOM + disk-pause full loop (Phase C)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C.13: Add `smoke-cloud --phase=C`

**Files:**
- Modify: `tools/smoke-cloud.mjs`

- [ ] **Step 1: Add Phase C smoke**

```javascript
async function smokePhaseC() {
  console.log('[smoke C] Sending one Healthchecks.io ping + verifying response...');
  if (!process.env.HEALTHCHECK_PING_URL) {
    console.error('[smoke C] FAIL — HEALTHCHECK_PING_URL not set'); process.exit(1);
  }
  try {
    const res = await fetch(process.env.HEALTHCHECK_PING_URL);
    if (res.ok) { console.log('[smoke C] OK — Healthchecks responded', res.status); }
    else { console.error('[smoke C] FAIL — status', res.status); process.exit(2); }
  } catch (e) {
    console.error('[smoke C] FAIL —', e.message); process.exit(3);
  }
}
```

Add dispatch.

- [ ] **Step 2: Commit**

```bash
git add tools/smoke-cloud.mjs
git commit -m "feat(smoke): --phase=C live Healthchecks.io ping (Phase C)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task C.14: Phase C gate

**Files:** read-only

- [ ] **Step 1: All Phase C tests pass**

```bash
node --test tests/services/watchdog.test.mjs tests/services/orchestrator-heartbeat.test.mjs tests/services/telegram-commands.test.mjs tests/services/db-extensions.test.mjs 2>&1 | tail -5
```

- [ ] **Step 2: Phase C e2e pass**

```bash
node --test tests/e2e/watchdog-oom.e2e.mjs tests/e2e/watchdog-disk-pause.e2e.mjs 2>&1 | tail -5
```

- [ ] **Step 3: Existing suite still green**

```bash
npm test 2>&1 | tail -3
```

- [ ] **Step 4: Commit empty**

```bash
git commit --allow-empty -m "chore: Phase C test sweep clean

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

Phase C code-complete.

---

## Phase D — Promptfoo CI

### Task D.1: Create 5 synthetic JD fixtures

**Files:**
- Create: `tests/fixtures/jds/lever-ml-engineer.md`
- Create: `tests/fixtures/jds/ashby-fullstack.md`
- Create: `tests/fixtures/jds/greenhouse-data.md`
- Create: `tests/fixtures/jds/workday-platform.md`
- Create: `tests/fixtures/jds/direct-ai-research.md`

- [ ] **Step 1: Write each fixture**

Each file is a ~80–150 line markdown document with:
- Frontmatter: `company:` (synthetic, e.g., "Synthetica Labs"), `role:`, `portal:`, `location:`
- Sections: Summary, Responsibilities (6–8 bullets), Required Skills (8–10 bullets), Preferred Skills (3–5 bullets), Compensation range

Example shape for `tests/fixtures/jds/lever-ml-engineer.md`:

```markdown
---
company: Synthetica Labs
role: Senior Machine Learning Engineer
portal: lever
location: Remote (US)
---

## Summary
We are a synthetic JD fixture used to test the resume pipeline against the lever portal shape. Do not treat as a real role.

## Responsibilities
- Design and deploy ML pipelines at production scale
- Own model lifecycle from research → deployment → monitoring
- Mentor junior ML engineers
- Partner with product to translate requirements into systems
- Drive evaluation rigor and reproducibility
- Contribute to internal tooling for experiment tracking

## Required Skills
- 5+ years Python production ML
- Deep familiarity with PyTorch or JAX
- Experience deploying to Kubernetes
- Strong SQL and data modeling
- Comfortable owning systems in production
- BS/MS in CS or equivalent industry experience

## Preferred
- Open-source contributions
- LLM experience (RAG, fine-tuning)
- Familiarity with MLOps tooling (Weights & Biases, MLflow)

## Compensation
$180K – $240K base + equity + benefits
```

Replicate the shape for the other four fixtures, varying the portal (ashby / greenhouse / workday / direct-portal) and the role focus. No real company names; no real metrics.

- [ ] **Step 2: Commit**

```bash
git add tests/fixtures/jds/*.md
git commit -m "test(fixtures): 5 synthetic JD fixtures for Promptfoo eval (Phase D)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task D.2: Create `tests/promptfoo.yaml`

**Files:**
- Create: `tests/promptfoo.yaml`

- [ ] **Step 1: Write the config**

```yaml
description: Regression eval of V2.0 resume prompt against synthetic JD fixtures
providers:
  - id: anthropic:claude-opus-4-7
    config:
      max_tokens: 8000
      temperature: 0
prompts:
  - file://../resume-optimization-system-based-on-job-description.md
tests:
  - vars:
      jd_file: tests/fixtures/jds/lever-ml-engineer.md
    assert:
      - type: regex
        value: '(?s)\\\\resumeSubheading.*\\\\resumeSubheading.*\\\\resumeSubheading'
      - type: javascript
        value: |
          const bullets = output.match(/\\\\resumeItem/g) || [];
          return bullets.length === 15;
      - type: javascript
        value: |
          const skillCats = output.match(/\\\\textbf\\{[A-Za-z\\s]+\\}:/g) || [];
          return skillCats.length === 6;
  - vars:
      jd_file: tests/fixtures/jds/ashby-fullstack.md
    assert:
      - type: javascript
        value: |
          const bullets = output.match(/\\\\resumeItem/g) || [];
          return bullets.length === 15;
  - vars:
      jd_file: tests/fixtures/jds/greenhouse-data.md
    assert:
      - type: javascript
        value: |
          const bullets = output.match(/\\\\resumeItem/g) || [];
          return bullets.length === 15;
  - vars:
      jd_file: tests/fixtures/jds/workday-platform.md
    assert:
      - type: javascript
        value: |
          const bullets = output.match(/\\\\resumeItem/g) || [];
          return bullets.length === 15;
  - vars:
      jd_file: tests/fixtures/jds/direct-ai-research.md
    assert:
      - type: javascript
        value: |
          const bullets = output.match(/\\\\resumeItem/g) || [];
          return bullets.length === 15;
```

- [ ] **Step 2: Commit**

```bash
git add tests/promptfoo.yaml
git commit -m "test(promptfoo): deterministic asserts for bullet count + skill categories (Phase D)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task D.3: Create `.github/workflows/prompt-eval.yml`

**Files:**
- Create: `.github/workflows/prompt-eval.yml`

- [ ] **Step 1: Write workflow**

```yaml
name: Prompt regression eval

on:
  pull_request:
    paths:
      - 'resume-optimization-system-based-on-job-description.md'
      - 'cv.md'
      - 'tests/fixtures/jds/**'
      - 'tests/promptfoo.yaml'

jobs:
  eval:
    if: ${{ vars.FEATURE_PROMPT_EVAL == '1' }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - name: Install promptfoo
        run: npm install -g promptfoo
      - name: Run eval
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: npx promptfoo eval -c tests/promptfoo.yaml --output tests/promptfoo-results.json
      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: promptfoo-results
          path: tests/promptfoo-results.json
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/prompt-eval.yml
git commit -m "feat(ci): prompt-eval workflow gated on FEATURE_PROMPT_EVAL repo var (Phase D)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task D.4: Add `smoke-cloud --phase=D`

**Files:**
- Modify: `tools/smoke-cloud.mjs`

- [ ] **Step 1: Add Phase D smoke**

```javascript
import { execSync } from 'node:child_process';

async function smokePhaseD() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[smoke D] FAIL — ANTHROPIC_API_KEY not set'); process.exit(1);
  }
  try {
    execSync('npx promptfoo eval -c tests/promptfoo.yaml --filter-pattern=lever-ml-engineer', { stdio: 'inherit' });
    console.log('[smoke D] OK');
  } catch (e) {
    console.error('[smoke D] FAIL —', e.message); process.exit(2);
  }
}
```

Add dispatch.

- [ ] **Step 2: Commit**

```bash
git add tools/smoke-cloud.mjs
git commit -m "feat(smoke): --phase=D live promptfoo eval (Phase D)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task D.5: Phase D gate

- [ ] **Step 1: Workflow file syntactically valid**

```bash
npx --yes action-validator .github/workflows/prompt-eval.yml 2>&1 | tail -5 || echo "(skipped if action-validator unavailable)"
```

- [ ] **Step 2: Commit empty**

```bash
git commit --allow-empty -m "chore: Phase D gate

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Cross-cutting

### Task X.1: Extend `.claude/skills/yash-pipeline-autonomous-agent/SKILL.md`

**Files:**
- Modify: `.claude/skills/yash-pipeline-autonomous-agent/SKILL.md`

- [ ] **Step 1: Append a new section**

```markdown

## Self-Improvement Layer

Four phases, each flag-gated (default OFF). See `OPERATIONS.md § Operating the Self-Improvement Layer` for full runbook.

| Flag | Phase | What it enables |
|---|---|---|
| `FEATURE_EXPORTER=1` | A | Langfuse Cloud Hobby observability via `services/exporter.mjs` + 5-min systemd timer |
| `FEATURE_FAILURE_KB=1` | B | Pre-spawn `$LEARNED_HINTS` injection + post-fail `learnFromFailure` regex catalogue |
| `FEATURE_WATCHDOG=1` | C | `services/watchdog.mjs` daemon + 60s Healthchecks.io heartbeat |
| Repo var `FEATURE_PROMPT_EVAL=1` | D | GitHub Actions runs Promptfoo on V2.0/cv.md edits |

Telegram operator commands (Phase B):
- `/patterns` — list top 10 failure patterns
- `/suppress <signature>` — stop injecting a hint
- `/unpause` — clear `paused=1` on `work_queue` after a disk-watch event

Watchdog rules (Phase C):
1. OOM → `rm -rf /tmp/yash-pipeline-*`
2. tectonic missing-file → re-run with `--keep-logs`
3. Two 403s on same host within 30 min → host-cooldown UPSERT
4. No orchestrator log for >10 min → `systemctl --user restart pipeline-orchestrator`
5. Disk free <1 GB → `UPDATE work_queue SET paused=1` + Telegram alert
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/yash-pipeline-autonomous-agent/SKILL.md
git commit -m "docs(skill): add Self-Improvement Layer section to yash-pipeline-autonomous-agent skill

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task X.2: Extend `OPERATIONS.md` with operator runbook

**Files:**
- Modify: `OPERATIONS.md`

- [ ] **Step 1: Append a new top-level section**

```markdown

## Operating the Self-Improvement Layer

### Phase A — Observability exporter

**Enable:**
```bash
# On VPS, edit /etc/yash-pipeline/agent.env:
FEATURE_EXPORTER=1
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://cloud.langfuse.com

# Install + enable systemd timer:
cp systemd/exporter.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now exporter.timer
```

**Verify:** `journalctl --user -u exporter -n 50 | grep exporter_done`. Then visit Langfuse dashboard → traces should appear within 5 min.

**Rollback:** `systemctl --user disable --now exporter.timer && sed -i 's/^FEATURE_EXPORTER=1/FEATURE_EXPORTER=0/' /etc/yash-pipeline/agent.env`

### Phase B — Failure-pattern KB

**Enable:**
```bash
sed -i 's/^FEATURE_FAILURE_KB=0/FEATURE_FAILURE_KB=1/' /etc/yash-pipeline/agent.env
systemctl --user restart pipeline-orchestrator
```

**Curate weekly (15 min):**
```bash
sqlite3 ops/work-queue.db "SELECT signature, hits, last_seen FROM failure_patterns ORDER BY hits DESC LIMIT 20;"
```
Or via Telegram: `/patterns`

**Suppress a bad hint:** Telegram `/suppress <signature>`

**Review unknown faults:** `ls ops/kb-review-queue/` then add a regex to `services/failure-kb.mjs:SIGNATURE_PATTERNS` and re-deploy.

**Rollback:** `sed -i 's/^FEATURE_FAILURE_KB=1/FEATURE_FAILURE_KB=0/' /etc/yash-pipeline/agent.env && systemctl --user restart pipeline-orchestrator`

### Phase C — Watchdog + heartbeat

**Enable:**
```bash
# Get your ping URL from Healthchecks.io → create check named "yash-orchestrator"
echo "HEALTHCHECK_PING_URL=https://hc-ping.com/<uuid>" >> /etc/yash-pipeline/agent.env
sed -i 's/^FEATURE_WATCHDOG=0/FEATURE_WATCHDOG=1/' /etc/yash-pipeline/agent.env

cp systemd/watchdog.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now watchdog.service
systemctl --user restart pipeline-orchestrator
```

**Verify heartbeat:** check Healthchecks dashboard → should be "up" within 2 min.

**Verify remediations:** induce an OOM (`stress-ng --vm 1 --vm-bytes 3G --timeout 30`); watch journald: `journalctl --user -u watchdog -f`.

**Rollback:** `systemctl --user disable --now watchdog.service && sed -i 's/^FEATURE_WATCHDOG=1/FEATURE_WATCHDOG=0/' /etc/yash-pipeline/agent.env && systemctl --user restart pipeline-orchestrator`

### Phase D — Promptfoo CI

**Enable:** In GitHub repo settings:
- Settings → Variables → Actions → add `FEATURE_PROMPT_EVAL=1`
- Settings → Secrets → Actions → ensure `ANTHROPIC_API_KEY` is set

**Test:** push a one-character edit to `resume-optimization-system-based-on-job-description.md`; CI should run prompt-eval workflow.

**Rollback:** Remove the `FEATURE_PROMPT_EVAL` repo variable.

### Smoke tests (manual, pre-rollout)

```bash
npm run smoke:cloud -- --phase=A
npm run smoke:cloud -- --phase=B
npm run smoke:cloud -- --phase=C
npm run smoke:cloud -- --phase=D
```
```

- [ ] **Step 2: Commit**

```bash
git add OPERATIONS.md
git commit -m "docs(operations): per-phase enable/rollback runbook for self-improvement layer

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task X.3: Add `tests/e2e/feature-flag-off.e2e.mjs` (cross-phase guarantee)

**Files:**
- Create: `tests/e2e/feature-flag-off.e2e.mjs`

- [ ] **Step 1: Write the e2e**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../services/db.mjs';
import { renderPreambleWithHints } from '../../services/pipeline-orchestrator.mjs';

test('e2e: with all FEATURE_* flags OFF, no overlay activity happens', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-flags-off-'));
  const db = openDb(join(root, 'work.db'));
  const before = {
    FEATURE_EXPORTER: process.env.FEATURE_EXPORTER,
    FEATURE_FAILURE_KB: process.env.FEATURE_FAILURE_KB,
    FEATURE_WATCHDOG: process.env.FEATURE_WATCHDOG
  };
  process.env.FEATURE_EXPORTER = '0';
  process.env.FEATURE_FAILURE_KB = '0';
  process.env.FEATURE_WATCHDOG = '0';
  try {
    const template = '## Recent\n\n$LEARNED_HINTS';
    const rendered = renderPreambleWithHints(db, 'https://x.test', template);
    assert.equal(rendered.includes('$LEARNED_HINTS'), false);
    assert.equal(rendered.includes('-'), false);  // no bullets injected
  } finally {
    for (const k of Object.keys(before)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test tests/e2e/feature-flag-off.e2e.mjs 2>&1 | tail -5
git add tests/e2e/feature-flag-off.e2e.mjs
git commit -m "test(e2e): feature flags OFF = no overlay activity (cross-phase guarantee)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task X.4: Final sweep + PR

- [ ] **Step 1: Run full suite**

```bash
npm test 2>&1 | tail -5
node --test tests/e2e/ 2>&1 | tail -5
```

Expected: ≥ 108 baseline + 53 new unit tests + 8 e2e all pass.

- [ ] **Step 2: Verify locked-spec invariants (no diff in forbidden files)**

```bash
git diff main --stat -- modes/ resume-optimization-system-based-on-job-description.md cover-letter-system-based-on-jd-and-resume.md cv.md cv-shivani.md yash-resume-pipeline.mjs services/cap.mjs services/dedup.mjs services/notifier.mjs services/queue.mjs services/reboot-resume.mjs services/sd-notify.mjs services/telegram-client.mjs services/url-validate.mjs services/logger.mjs systemd/telegram-listener.service systemd/pipeline-orchestrator.service
```
Expected: empty (no changes to any of these files).

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/self-improvement-overlay
gh pr create --title "feat: self-improvement overlay (Phases A/B/C/D) — design + tests" \
  --body "$(cat <<'EOF'
## Summary
- Implements `docs/superpowers/specs/2026-05-25-yash-pipeline-self-improvement-architecture.md`
- 4 phases, each behind its own `FEATURE_*` flag, default OFF
- 53 new unit tests, 8 new e2e, all existing 108 tests still green
- Zero edits to locked prompts, zero new `claude -p` calls, zero new inbound ports

## Test plan
- [ ] CI green
- [ ] Local: `npm test` ≥ 161 pass / 0 fail
- [ ] Local: `node --test tests/e2e/` 8 pass / 0 fail
- [ ] `git diff main --stat` shows zero diff in locked files (see Task X.4 step 2)
- [ ] After merge: enable Phase A on VPS, run `npm run smoke:cloud -- --phase=A` against real Langfuse, 48 h soak, then Phase B, etc.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Mark PR ready for review**

When CI green, request review.

---

## Self-review checklist (run after writing this plan)

### Spec coverage

| Spec section | Plan task(s) |
|---|---|
| § 0 locked decisions (10 rows) | All carried into task structure |
| § 1 architecture overview | PF.3, X.1, X.2 |
| § 2.1 exporter | A.1–A.9 |
| § 2.2 failure-kb + preamble | B.1–B.13 |
| § 2.3 watchdog + heartbeat | C.1–C.14 |
| § 2.4 promptfoo | D.1–D.5 |
| § 2.5 schema additions | A.1 (exporter_state), B.1 (failure_patterns), C.1 (paused) |
| § 2.6 watchdog rules | C.5–C.9 (one task per rule) |
| § 2.7 cross-cutting | X.1, X.2, X.3 |
| § 3 data flow | Implementation tasks cover all 4 paths + operator cmds (B.9–B.11, C.2) |
| § 4 error handling | Test cases cover failure modes in A.3 (HTTP), A.4 (network), B.3 (review-queue write fail), C.3 (network), C.5 (idempotency) |
| § 5 testing strategy | Unit tests in services/* test files; e2e tests in tests/e2e/; smoke in tools/smoke-cloud.mjs |
| § 6 rollout & rollback | X.2 (OPERATIONS.md) lists per-phase enable + rollback |
| § 7 deferred-to-plan items | Resolved: regex catalogue (B.2), watchdog thresholds (C.5–C.9), promptfoo asserts (D.2), JD fixtures (D.1), smoke script (A.8/B.12/C.13/D.4) |
| § 6.6 invariant checklist | X.4 step 2 runs the verification |

### Placeholder scan

- [x] No "TBD" / "TODO" / "implement later" / "fill in details" anywhere.
- [x] No "Add appropriate error handling" — every error case is explicitly tested.
- [x] No "Write tests for the above" — every test has its code in-line.
- [x] No "Similar to Task N" — each task is self-contained.
- [x] Every step that changes code shows the code.

### Type consistency

- `getCursor` / `setCursor` (A.1) match `runExporter` usage (A.4): ✓
- `upsertPattern({ signature, hint, runId })` (B.1) matches all 6 callers (B.2, B.3, C.5, C.6, C.7, C.8, C.9): ✓
- `topHintsByHost(db, host, limit=3)` (B.1) matches `renderPreambleWithHints` usage (B.5): ✓
- `learnFromFailure(db, runId, errorText, { url, reviewDir })` (B.3) matches orchestrator wire-up (B.6): ✓
- `startHeartbeat({ httpClient, intervalMs })` (C.3) matches all tests and main: ✓
- `matchOom/Tectonic/HostCooldown/HeartbeatMiss/DiskPause` + `remediate*` pairs (C.5–C.9) all consistent: ✓

---

## Execution handoff

**Execution mode chosen:** Subagent-Driven Development (deferred to a future session).

**To resume:**
1. Start a fresh Claude Code session.
2. Paste: `Execute docs/superpowers/plans/2026-05-25-yash-pipeline-self-improvement-implementation.md via superpowers:subagent-driven-development.`
3. The skill will dispatch one fresh subagent per task starting at PF.1 (worktree creation), review the diff between tasks, and progress through Phase A → B → C → D.

**Why this mode:** Each TDD cycle in this plan is self-contained (write failing test → run → impl → run → commit). A fresh subagent context per task keeps the main reviewer context light and lets each task fail in isolation without polluting downstream work.

**Two execution options are documented for reference:**

**1. Subagent-Driven** *(chosen)* — fresh subagent per task, review between tasks, fast iteration. Best for plans with this many tasks.

**2. Inline Execution** — alternative via `superpowers:executing-plans`, batch execution with checkpoints. Use if the next session wants to watch each step in one continuous context.
