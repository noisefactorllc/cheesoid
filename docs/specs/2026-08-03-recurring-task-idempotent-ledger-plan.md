# Recurring Task Idempotent Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Cheesoid-owned recurring task a durable occurrence ledger and a deterministic tool-use idempotency context, so a restart, duplicate timer, queued wakeup, or model retry cannot repeat the same external side effect.

**Architecture:** Add one filesystem-backed ledger per persona runtime and make every recurring timer path claim its scheduled occurrence before waking the agent. Carry that occurrence context through queued chat turns and every tool execution. Read-only tools continue normally; mutating tools must declare one of three replay policies: framework-transactional, destination-idempotent, or blocked during recurring turns. A completed action returns its stored receipt on replay. An ambiguous crash fails closed until reconciliation or an operator retry reuses the same destination key.

**Tech Stack:** Node.js ESM, JSON persistence under `persona/runtime`, `node:test`, existing Express harness APIs, existing Cheesoid Mail idempotency API.

---

## Scope and invariants

This plan covers all recurrence initiated by Cheesoid:

- config-owned `wakeups:` entries;
- agent/user-created recurring cron entries in `runtime/schedules.json`;
- the self-rescheduling idle-autonomy timer;
- both the nightly sleep wakeup and the sleep cycle triggered after substantive idle turns;
- currently external recurring persona jobs as they are migrated into one of the two Cheesoid scheduler paths.

One-shot `at` reminders use the same ledger for crash safety, but they are not the motivation for this project. Provider retries inside one model turn are also covered because tool actions share the occurrence context.

The non-negotiable invariants are:

1. The occurrence key is based on the scheduled slot, never the process start time or actual fire time. Normally that is the exact armed target; deliberately coalesced triggers such as nightly and post-idle sleep use one documented normalized daily slot.
2. A scheduler must durably claim the occurrence before it queues or starts an agent turn.
3. A recurring mutating tool must not run without an explicit replay policy.
4. A destination-idempotent tool receives the same key on every replay and verifies the destination's stored receipt.
5. The framework records successful tool acceptance before it marks the occurrence complete.
6. Unknown, corrupt, locked, or migration-incomplete ledger state fails closed for mutating tools.
7. Ordinary user-triggered tool use remains backward compatible. In particular, agents retain normal team-mail capability; only recurring-run calls acquire idempotency enforcement.
8. “Completed” means the task's required effect has a durable accepted receipt. `queued` or `pending` may be recorded as accepted/submitted, but must not be described as final delivery.
9. Required effects are declared on the schedule, not inferred from whatever tools the model happened to call. A report turn that ends without its required send receipt is not complete.
10. Idle-autonomy turns declare no external effects and may use only read-only tools plus framework-recorded private thought. If idle work needs a side effect, it must create an explicit schedule with declared actions; idle must not become an untracked mutation path.

### State model

Each occurrence uses the stable key:

```text
recurrence:v1:<source>:<schedule-id>:<scheduled-for-ISO>
```

The external key is `sha256(occurrence-key + ":" + action-key)`, encoded as lowercase hex. This keeps destination keys bounded and deterministic without leaking prompts or recipient data.

```text
claimed -> running -> completed
                 \-> failed
                 \-> uncertain
```

- `claimed`: the exact occurrence was reserved on disk but its turn has not started.
- `running`: the turn started and owns a lease.
- `completed`: every required mutating action has a durable success/accepted receipt.
- `failed`: execution failed before an external effect was accepted. It is visible but is not automatically replayed.
- `uncertain`: the process may have crossed an external side effect before recording its receipt. It is blocked until destination reconciliation resolves it.

`completed`, unexpired `claimed`/`running`, and `uncertain` all suppress a new scheduled turn. Operator retries reuse the original occurrence and action keys; they never mint a new key for the same scheduled slot.

### Ledger schema

Store `runtime/recurring-runs.json` as a versioned document:

```json
{
  "version": 1,
  "runs": {
    "<occurrence-key>": {
      "run_id": "uuid",
      "source": "config|runtime|system",
      "schedule_id": "weekly-ops",
      "scheduled_for": "2026-08-03T08:00:00.000Z",
      "state": "running",
      "attempt": 1,
      "claimed_at": "...",
      "lease_expires_at": "...",
      "finished_at": null,
      "error": null,
      "actions": {
        "send-report": {
          "tool": "send_weekly_report",
          "state": "accepted",
          "idempotency_key": "<sha256>",
          "started_at": "...",
          "finished_at": "...",
          "receipt": {
            "destination_id": "delivery uuid",
            "status": "queued"
          }
        }
      }
    }
  }
}
```

Receipts must be small, redacted, and explicitly selected by the tool adapter. Never persist arbitrary tool output, mail bodies, prompts, credentials, or full provider responses in this ledger.

---

### Task 1: Build the durable occurrence ledger

**Files:**

- Create: `server/lib/recurring-run-ledger.js`
- Create: `tests/recurring-run-ledger.test.js`

- [ ] **Step 1: Write failing state-transition and persistence tests**

Cover these cases in `tests/recurring-run-ledger.test.js`:

- `claimOccurrence()` creates a version-1 record and returns `claimed`.
- a second claim for the same scheduled occurrence returns `already_claimed` without changing `run_id`;
- completed and uncertain occurrences remain blocked across a new ledger instance;
- `startAction()` returns the same deterministic key for the same `actionKey`;
- `acceptAction()` stores only the adapter-provided receipt;
- replay of an accepted action returns `already_accepted` plus the stored receipt;
- `failAction({ uncertain: true })` blocks replay;
- corrupt JSON, an unknown schema version, and an unresolvable lock all fail closed;
- two concurrent claims produce one winner;
- writes survive a new instance and leave no temporary file behind;
- retention removes only old terminal runs and never active or uncertain runs.

- [ ] **Step 2: Run the new test and verify the module-not-found failure**

Run: `node --test tests/recurring-run-ledger.test.js`

Expected: FAIL because `server/lib/recurring-run-ledger.js` does not exist.

- [ ] **Step 3: Implement the ledger API**

Export:

```js
export function createRecurringRunLedger({ runtimeDir, now = () => Date.now(), leaseMs, retentionMs })
// returns:
// claimOccurrence({ source, scheduleId, scheduledFor })
// markRunning({ occurrenceKey, runId })
// startAction({ occurrenceKey, runId, actionKey, tool })
// acceptAction({ occurrenceKey, runId, actionKey, receipt })
// failAction({ occurrenceKey, runId, actionKey, error, uncertain })
// completeOccurrence({ occurrenceKey, runId })
// failOccurrence({ occurrenceKey, runId, error, uncertain })
// getOccurrence(occurrenceKey)
// listOccurrences({ scheduleId, limit })
// reconcileAction({ occurrenceKey, actionKey, receipt })
```

Use an exclusive short-lived lock file for each read-modify-write transaction. Write a unique temporary file, `fsync` it, rename it atomically, then `fsync` the containing directory. A live local lock owner must never be reclaimed. Treat a lock as abandoned only when its lease has expired and its recorded PID is not alive; test PID reuse and malformed lock metadata conservatively.

- [ ] **Step 4: Run the focused tests**

Run: `node --test tests/recurring-run-ledger.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/recurring-run-ledger.js tests/recurring-run-ledger.test.js
git commit -m "feat: add durable recurring-run ledger"
```

---

### Task 2: Give every scheduler a stable occurrence identity

**Files:**

- Modify: `server/lib/wakeup.js`
- Modify: `server/lib/persona.js`
- Modify: `personas/example/persona.yaml`
- Modify: `tests/wakeup.test.js`
- Modify: `tests/persona.test.js`

- [ ] **Step 1: Write failing identity tests**

Add tests proving:

- `nextMatch()` remains backward compatible;
- a `WakeupScheduler` passes the exact `_nextTime` it armed as `scheduledFor`, even when the timer fires late;
- duplicate callbacks for that target produce the same occurrence identity;
- config wakeups require a unique stable `id` when `idempotency: required` is enabled;
- legacy wakeups without an `id` still load with idempotency disabled and an explicit startup warning during the compatibility window;
- nightly and idle-triggered sleep both use stable `source: "system"`, `scheduleId: "sleep"`, with `scheduledFor` normalized to the UTC day used by the existing journal filename;
- an idle timer stores its absolute target when armed and uses stable `source: "system"`, `scheduleId: "idle-autonomy"`, with that target as `scheduledFor`;
- either sleep trigger claiming that daily slot suppresses the other, so the detached post-idle callback cannot overlap the nightly run.

- [ ] **Step 2: Add config validation and documented syntax**

Document this shape in `personas/example/persona.yaml`:

```yaml
wakeups:
  - id: weekly-ops
    name: Weekly operations review
    mode: cron
    schedule: "0 2 * * 1"
    prompt: prompts/weekly-ops.md
    idempotency:
      mode: required
      actions:
        - key: send-report
          tool: send_weekly_report
```

Reject duplicate `id` values within a persona, duplicate action keys, and required actions whose tool has no compatible replay policy. Keep `name` presentation-only: renaming it must not create a new recurrence identity. Idle autonomy explicitly declares an empty external-action list. Sleep uses a framework-owned `sleep-distill` action whose adapter validates the dated journal/state writes before context compaction is committed.

- [ ] **Step 3: Change the callback contract**

Change `WakeupScheduler` to call:

```js
await onWakeup({
  prompt,
  occurrence: {
    source: 'config',
    scheduleId: wakeupConfig.id,
    scheduledFor: new Date(targetMs).toISOString(),
  },
})
```

Accept the old string callback behind a temporary compatibility adapter only where tests demonstrate a current caller still needs it. Do not compute `scheduledFor` from `Date.now()`.

- [ ] **Step 4: Run focused tests and commit**

Run: `node --test tests/wakeup.test.js tests/persona.test.js`

```bash
git add server/lib/wakeup.js server/lib/persona.js personas/example/persona.yaml tests/wakeup.test.js tests/persona.test.js
git commit -m "feat: identify scheduled occurrences"
```

---

### Task 3: Claim before dispatch in both scheduler paths

**Files:**

- Modify: `server/lib/schedule-store.js`
- Modify: `server/lib/harness.js`
- Modify: `server/lib/chat-session.js`
- Modify: `server/lib/sleep.js`
- Modify: `tests/schedules-runtime.test.js`
- Modify: `tests/idle-circuit-breakers.test.js`
- Modify: `tests/sleep.test.js`
- Create: `tests/recurring-wakeup-integration.test.js`

- [ ] **Step 1: Write failing dispatch tests**

Test config wakeups, runtime cron schedules, one-shot schedules, idle autonomy, nightly sleep, and idle-triggered sleep. For each path verify:

- the ledger claim is persisted before `onFire`/`sendMessage` starts;
- two scheduler instances sharing a runtime directory dispatch one turn;
- a process restart at `claimed`, `running`, `completed`, and `uncertain` does not duplicate the turn;
- the scheduled timestamp, not the late callback time, selects the occurrence;
- a queued schedule message retains its occurrence context while the room is busy;
- a failed ledger read prevents dispatch;
- runtime `lastFired` advances only after the occurrence is durably claimed;
- removing a schedule while its callback awaits does not delete its run receipt.
- duplicate idle timer callbacks claim one exact armed target and start one idle turn;
- idle-triggered sleep claims the same normalized daily `sleep` occurrence as nightly sleep before its detached callback and cannot overlap it;
- an idle turn cannot invoke an external mutating tool, even at high autonomy.

- [ ] **Step 2: Create one ledger in the harness**

In `createHarness()`, instantiate `harness.recurringRuns` beside `harness.schedules`. Inject it into `createScheduleStore()` and every `WakeupScheduler`; do not create independent ledgers per scheduler.

- [ ] **Step 3: Make claim-before-dispatch automatic**

Both schedulers and `_startIdleTimer()` must call `claimOccurrence()` before queuing or starting any agent work. On `already_claimed`, `completed`, `uncertain`, corrupt state, or lock failure, log a structured suppression event and schedule the next occurrence without invoking the model.

For a runtime schedule, use `source: "runtime"` and its persisted random `id`. For config wakeups use `source: "config"` and the new stable config `id`. Both sleep triggers use `source: "system"`/`sleep` and normalize `scheduledFor` to `YYYY-MM-DDT00:00:00.000Z`, matching the UTC date already used by `runSleepCycle()` for journal names. For idle, persist the absolute target selected by `_startIdleTimer()` and use `source: "system"`/`idle-autonomy`; never derive the slot inside `_idleThought()`. Claim the shared sleep slot before launching either sleep path.

- [ ] **Step 4: Preserve run context through the room queue**

Add `options.recurringRun` to `sendMessage()`/`_processMessage()`. Store it on queued message records and restore it while draining. Set `this._turnRecurringRun` only for the active turn and clear it in `finally`, including early-return floor-control paths.

Make scheduler calls request an execution result instead of relying on `_processMessage()`'s current swallowed errors. A provider failure must call `failOccurrence`; a successful agent loop may call `completeOccurrence` only after action validation in Task 4. `_idleThought()` and `runSleepCycle()` must return structured results for the same reason; their current booleans/strings are insufficient evidence for ledger completion.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test tests/wakeup.test.js tests/schedules-runtime.test.js tests/idle-circuit-breakers.test.js tests/sleep.test.js tests/recurring-wakeup-integration.test.js tests/webhook-queue.test.js`

```bash
git add server/lib/schedule-store.js server/lib/harness.js server/lib/chat-session.js server/lib/sleep.js tests/schedules-runtime.test.js tests/idle-circuit-breakers.test.js tests/sleep.test.js tests/recurring-wakeup-integration.test.js tests/webhook-queue.test.js
git commit -m "feat: claim recurring work before dispatch"
```

---

### Task 4: Enforce ledger-aware tool execution

**Files:**

- Modify: `server/lib/agent.js`
- Modify: `server/lib/tools.js`
- Modify: `server/lib/tools-harness.js`
- Modify: `server/lib/chat-session.js`
- Create: `tests/recurring-tool-idempotency.test.js`
- Modify: `tests/tools-harness.test.js`
- Modify: `tests/agent-hybrid.test.js`

- [ ] **Step 1: Write the replay-policy tests**

Cover:

- all direct, rescued, reasoner, and hybrid tool execution paths receive the same `recurringRun` options;
- read-only tools execute on every call and do not create action records;
- an accepted action returns its stored receipt without invoking the tool again;
- a mutating tool without a replay policy is rejected before execution on a recurring turn;
- an uncertain action is rejected until reconciliation;
- user turns are unchanged and can still use normal mutating tools;
- two different action keys in one occurrence may execute once each;
- the same action key with different input is rejected as a collision;
- a destination-idempotent adapter receives the deterministic key and can reconcile an existing destination receipt;
- a recurring action reported as `queued`/`pending` is accepted but is not labeled delivered.
- a turn that omits a schedule-declared required action cannot complete;
- an explicit zero-action schedule may complete as `no_effect`.
- idle-autonomy blocks external mutation while preserving read-only research and `internal({ thought })` journal behavior;
- `internal({ trigger: true })` remains blocked during idle because waking a peer is an external effect.

- [ ] **Step 2: Define policies outside provider-visible tool schemas**

Extend tool modules with an optional separate export:

```js
export const idempotency = {
  send_weekly_report: {
    effect: 'mutating',
    replay: 'destination',
    defaultActionKey: 'send-report',
    receipt: result => ({
      destination_id: result.delivery_id,
      status: result.delivery_status,
    }),
    reconcile: async ({ idempotencyKey }) => { /* authoritative lookup */ },
  },
}
```

Supported `replay` values:

- `read-only`: no action ledger entry;
- `framework`: the implementation is a Cheesoid-owned atomic mutation coordinated with the ledger;
- `destination`: the adapter passes the key to a downstream uniqueness boundary and implements authoritative lookup;
- `blocked`: forbidden during recurring turns.

Keep this metadata out of the function schema sent to model providers. Existing two-argument persona `execute(name, input)` functions remain valid because JavaScript ignores the added options argument on ordinary turns.

- [ ] **Step 3: Pass context through every agent execution path**

Add `toolContext` to agent config and merge it into the third argument at every `tools.execute()` site in `server/lib/agent.js`, including narrated-call rescue and hybrid/reasoner execution. Add a regression test for each call site so a later provider refactor cannot silently drop the context.

- [ ] **Step 4: Wrap mutating execution in action transitions**

In `loadTools().execute()`:

1. resolve the tool policy;
2. canonicalize and hash the input for collision detection;
3. call `startAction()` before invoking the tool;
4. return a prior accepted receipt without invoking the tool on replay;
5. pass `{ recurringRun, actionKey, idempotencyKey }` to the tool;
6. store the selected receipt after destination acceptance;
7. mark timeouts, connection drops, and malformed responses `uncertain` unless the adapter proves no effect occurred.

Never infer success from a model's prose. Completion is based on tool results and ledger receipts.

- [ ] **Step 5: Classify built-in tools**

Start with an explicit allowlist, not name heuristics:

- reads/search/list/status/fetch GET: `read-only`;
- framework-owned atomic writes with direct result receipts: `framework`;
- `send_chat_message`, `reply_to_message`, `react_to_message`, `task_start`, `schedule_create`, peer triggers, shell, and any unclassified custom tool: `blocked` until an adapter proves replay safety.

`internal` needs input-sensitive classification: thought-only use is a framework-recorded local action; backchannel trigger use is blocked during idle and requires a declared destination adapter on any other recurring schedule.

This conservative first release may block an existing recurring workflow. Migrate its actual effect tool in Task 6; do not weaken the guard globally.

- [ ] **Step 6: Finish occurrence state from evidence**

A successful model turn may complete as `no_effect` only when the schedule explicitly declares an empty external-action list. Idle thought persistence is recorded as a framework-local action but does not authorize chat, peer, shell, or other mutations. Otherwise, completion requires one accepted or reconciled receipt for every `(action key, tool)` pair declared by that schedule; extra mutating actions remain forbidden unless declared. Any omitted required action records failed, any uncertain action makes the occurrence uncertain, and provider/tool failure before an action starts records failed. No state is derived from assistant text.

- [ ] **Step 7: Run focused tests and commit**

Run: `node --test tests/recurring-tool-idempotency.test.js tests/tools-harness.test.js tests/agent-hybrid.test.js`

```bash
git add server/lib/agent.js server/lib/tools.js server/lib/tools-harness.js server/lib/chat-session.js tests/recurring-tool-idempotency.test.js tests/tools-harness.test.js tests/agent-hybrid.test.js
git commit -m "feat: enforce idempotent recurring tool use"
```

---

### Task 5: Add operator visibility and safe reconciliation

**Files:**

- Modify: `server/routes/harness.js`
- Modify: `server/lib/tools-harness.js`
- Modify: `server/public/js/harness-panels.js`
- Modify: `docs/harness.md`
- Create: `tests/recurring-runs-routes.test.js`
- Modify: `tests/tools-harness.test.js`

- [ ] **Step 1: Write failing route and authorization tests**

Add tests for:

- `GET /api/recurring-runs?schedule_id=...` returns redacted recent status and receipts;
- `schedule_list` includes the last occurrence state and scheduled time;
- only a human-authorized request can retry or reconcile;
- retry preserves the original occurrence and destination keys;
- reconciliation requires adapter evidence and cannot accept an arbitrary caller-supplied “success” string;
- ledger contents never expose prompts, bodies, credentials, or raw tool output.

- [ ] **Step 2: Add read-only status surfaces**

Expose run state in the existing Schedules panel and `schedule_list`. Add a detail endpoint for recent occurrences. Use the existing `requireHuman` guard for all mutation routes.

- [ ] **Step 3: Add explicit recovery operations**

Provide operator actions for:

- `reconcile`: ask the registered destination adapter for the existing receipt;
- `retry`: re-enter the same occurrence with the same deterministic keys after a proven pre-effect failure;
- `abandon`: terminally suppress an occurrence with an operator reason.

Do not provide “delete ledger row and try again.” That recreates the duplicate-send failure mode.

- [ ] **Step 4: Document operations and commit**

Document state meanings, exact recovery commands/API calls, retention, backups, and the distinction between accepted and delivered.

Run: `node --test tests/recurring-runs-routes.test.js tests/tools-harness.test.js`

```bash
git add server/routes/harness.js server/lib/tools-harness.js server/public/js/harness-panels.js docs/harness.md tests/recurring-runs-routes.test.js tests/tools-harness.test.js
git commit -m "feat: expose recurring run recovery state"
```

---

### Task 6: Migrate current recurring personas without removing ordinary mail

**Files:**

- Modify: `/Users/aayars/platform/brad/persona/persona.yaml`
- Modify: `/Users/aayars/platform/brad/persona/tools/tools.js`
- Modify: `/Users/aayars/platform/brad/persona/tools/weekly-report.mjs`
- Delete after verified cutover: `/Users/aayars/platform/brad/persona/cron/brad-webhooks`
- Modify: `/Users/aayars/platform/margo/persona/persona.yaml`
- Modify: affected Brad and Margo tool tests
- Create: `scripts/migrate-recurring-runs.mjs`
- Create: `tests/migrate-recurring-runs.test.js`

- [ ] **Step 1: Inventory and lock the rollout set**

The current known set is Brad's external Monday cron, Margo's Monday config wakeup, every persona's enabled idle-autonomy and sleep cycles, the idle-triggered sleep path, and any persisted runtime cron schedules discovered at deployment time. Re-run the inventory immediately before implementation; do not assume this August 2026 list is complete.

- [ ] **Step 2: Write migration and compatibility tests first**

Prove:

- Brad's existing `memory/weekly-report-deliveries.json` imports the current week and delivery receipt without creating a new run;
- repeat import is a no-op;
- malformed legacy state fails the migration;
- Margo receives a stable config `id` without changing schedule or prompt;
- ordinary `send_mail` remains available to Brad and every other agent for legitimate team mail;
- Brad's weekly report adapter uses the framework-provided destination key and still blocks report-like messages through generic mail;
- the external Brad cron cannot coexist with the new config wakeup after cutover.
- runtime `schedule_create` requires callers to declare the action key/tool pairs for effectful recurring schedules, while reminder-only schedules explicitly declare no actions.

- [ ] **Step 3: Add a dry-run/apply/check migration command**

`scripts/migrate-recurring-runs.mjs` must support:

```bash
node scripts/migrate-recurring-runs.mjs --runtime /path/to/runtime --legacy-brad-ledger /path/to/file --dry-run
node scripts/migrate-recurring-runs.mjs --runtime /path/to/runtime --legacy-brad-ledger /path/to/file --apply
node scripts/migrate-recurring-runs.mjs --runtime /path/to/runtime --check
```

`--apply` writes an adjacent timestamped backup before changing state, uses the ledger's atomic writer, and prints counts only. `--check` exits nonzero unless schema version, imported occurrence, action receipt, and uniqueness invariants are all valid.

- [ ] **Step 4: Move Brad into Cheesoid's scheduler**

Add `id: weekly-ops`, the unchanged Monday 2:00 AM schedule, required action `send-report`/`send_weekly_report`, and the existing guarded prompt to Brad's `persona.yaml`. Adapt `send_weekly_report` to the destination policy while retaining its server-side Cheesoid Mail key. Keep generic team mail enabled.

Only after the migration check passes and the config wakeup is visibly scheduled, remove the external crontab entry. Deploy must assert there is exactly one weekly-ops scheduler source.

- [ ] **Step 5: Add Margo and sleep identities**

Give Margo's existing Monday wakeup a stable `id`; do not change its cadence or business behavior in this project. The framework assigns the system sleep identity automatically, so persona files need no sleep edit unless a duplicate ID validation requires it.

- [ ] **Step 6: Run consumer tests and commit each repository separately**

Run the full Cheesoid suite plus the focused Brad and Margo suites. Commit only files belonging to this rollout; leave unrelated persona work unstaged. Push directly to each repository's existing `main` branch. Do not create branches, worktrees, or pull requests.

---

### Task 7: Deployment and migration gate

**Files:**

- Modify the existing service deployment definitions in `/Users/aayars/platform/scaffold` only where needed to run the migration gate.
- Modify the Brad and Margo deploy workflows only where their current deployment contract requires it.
- Do not create a relational database migration for Cheesoid core: its new persistence is the versioned runtime ledger file.

- [ ] **Step 1: Back up and dry-run production state**

Before deploying new runtime code, back up each affected persona's `runtime/schedules.json`, `runtime/recurring-runs.json` if present, and Brad's legacy weekly ledger. Run the migration in `--dry-run` mode and retain its non-secret summary in deployment logs.

- [ ] **Step 2: Apply the migration before restarting services**

The deployment sequence is mandatory:

1. stop scheduler-bearing containers or otherwise prove a single writer;
2. back up the runtime files;
3. run `--apply` with fail-fast behavior;
4. run `--check` and require exit code zero;
5. start the new application image;
6. verify health and ledger schema version;
7. verify exactly one source owns every known recurring task.

Do not treat a committed migration script as an applied migration. The deployment workflow must show the apply command and the successful post-apply check in its logs.

- [ ] **Step 3: Explicitly verify the downstream mail prerequisite**

Brad's destination adapter depends on Cheesoid Mail's agent-scoped unique idempotency key and authoritative lookup endpoint. Before Brad cutover, verify in production that:

- migration `003_outbound_idempotency.sql` has been applied;
- the `idempotency_key` column exists;
- the unique partial index is valid and has `(from_agent, idempotency_key)` with the non-null predicate;
- a repeated send with one key returns the original row and creates no second queue record.

If any check fails, stop the Brad deployment. Do not start the new scheduler against an unverified destination schema.

- [ ] **Step 4: Canary and duplicate-fire proof**

Use a non-mail canary recurring tool first. Trigger the same occurrence twice and restart between claims; prove one action receipt and one external effect. Then perform Brad's reconciliation-only preflight for the current week and confirm no new outbound row. Do not generate or send a test weekly report to the team.

- [ ] **Step 5: Roll out and observe**

Roll out one persona at a time. For the first two occurrences of each schedule, verify the scheduled timestamp, occurrence key, action state, destination receipt, next-fire time, and absence of a duplicate destination row. Keep the legacy Brad ledger read-only for one retention window, then remove it in a separate cleanup change after evidence shows no rollback needs it.

---

## Final verification checklist

- [ ] `npm test` passes in Cheesoid.
- [ ] Focused Brad and Margo tests pass.
- [ ] Every config wakeup has a unique stable `id` and explicit idempotency mode.
- [ ] Every runtime cron occurrence is keyed by its persisted schedule ID and exact scheduled time.
- [ ] Sleep cycles use the same claim path.
- [ ] Idle-autonomy claims its armed target and cannot use external mutating tools.
- [ ] Idle-triggered and nightly sleep coalesce onto one deterministic daily occurrence and cannot race or duplicate each other.
- [ ] Busy-room queueing preserves recurring context.
- [ ] Every mutating tool reachable from a recurring turn is classified; unclassified tools fail closed.
- [ ] Destination adapters reconcile authoritative receipts after ambiguous failures.
- [ ] Generic user-triggered mail to the team remains available.
- [ ] The production migration log contains both `--apply` and a successful `--check`.
- [ ] Cheesoid Mail's production schema and uniqueness behavior are explicitly verified.
- [ ] Brad's external cron is absent only after its config wakeup is healthy and uniquely scheduled.
- [ ] A forced duplicate callback and a restart produce one occurrence and one external effect.
- [ ] No branch, worktree, or pull request was created.
