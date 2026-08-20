---
name: core
description: Generic multi-agent coordination doctrine shared across projects. Copied from agentkit; do not edit here — run `agentkit update` instead.
---

# Coordination core

This file is machinery, not project knowledge. It is copied verbatim by
`agentkit` and overwritten on update, so edits here are lost. Anything true only
of one project belongs in that project's `agents/orchestrator.md`.


## Layers

Escalate only as far as the question requires.

- **Layer 0 — no model.** `graphify update`, `relabel.py`, the vault wikilink
  scanner, `git fetch`. Shell commands. Never delegate these to an agent.
- **Layer 1 — you.** Reconciliation, scoping, graph queries, evidence packs,
  merging worker reports.
- **Layer 2a — one-shot calls.** A single non-interactive invocation returning
  text or JSON. No supervised worker, no lifecycle. Use for summarising,
  classifying, drafting.
- **Layer 2b — supervised workers.** Orca orchestration workers for multi-step
  work that reads widely or changes files.
- **Layer 3 — council.** Two large models cross-reading each other. Runs only
  when the human asks for it. Never start it on your own initiative.

`agents/roles.toml` maps each role to its CLI, model, effort, and layer. Read it
rather than hard-coding launch flags.

When `[settings] codex_available = false`, every role that declares a
`[roles.<name>.fallback]` block runs that block instead. Resolve the effective
launch config from the toggle before building any command; do not read the
top-level fields alone. `council-b` deliberately falls back to a third vendor
rather than to claude, because a claude-versus-claude council defeats its
purpose.

State is checkpointed by `agents/checkpoint.sh`, wired to Stop, SessionEnd, and
SessionStart hooks in `.claude/settings.json`. It runs without a model and writes
`.orchestrator/journal.md`. It captures mechanical facts only — branch, commit,
dirty count, open tasks. Reasoning is yours to record; see Sessions are
disposable.

## Workers run in the current worktree

Use `--worktree current`. A fresh worker means a fresh agent session, not a new
git checkout. Create a worktree only when the human asks for one or a concrete
filesystem conflict makes sharing unsafe — and state that conflict first.

Account for every settled worker: reuse it, retain it at the human's request, or
release it. Released workers stay readable.

**Every worker opens as an Orca pane — Claude workers included.** The human
supervises through the agent window; a worker spawned as an in-session subagent
is invisible there, so that path is a fallback for when Orca is unreachable, and
using it must be stated in the handoff. Idle notifications are part of that
visibility: do not suppress them.

**Orca's agent id is not the binary name.** `--agent` takes Orca's registered
id, and rejecting an unknown one looks exactly like refusing to run that agent.
`agy` is registered as `antigravity`; `--agent agy` fails on the name alone,
while `--agent antigravity` is accepted and launches the same binary. Check the
id before concluding an agent is unsupported. Orca may also refuse
`--model`/`--effort` for a given agent — `antigravity` does, so that role's
model comes from the CLI's own configuration and `roles.toml` cannot pin it.

**A readiness failure is a symptom, not a diagnosis.** When `worker-start` fails
at `agent_readiness`, three different things produce the identical error:

1. Wrong agent id — the launch never happened.
2. The agent launched but is **parked on a prompt**: a trust dialog, a login, an
   approval. It is running and will never report ready.
3. The CLI genuinely does not answer the handshake.

Only reading the pane separates them. `agentkit preflight` names the Orca agent
id and the trust state statically; `--launch` opens the role's real command,
waits for `tui-idle` and reads the pane back; `--handshake` probes `worker-start`
for 2b roles, re-reads the pane on failure, and cleans up the dispatch and task
afterwards.

**`terminal wait --for tui-idle` returning ok is not readiness.** Measured
2026-08-19: it returned ok for all three agents at once while codex was parked
on a hook-trust prompt and agy had not finished signing in. Idle means the
output stopped moving, which is exactly what a modal prompt and a stalled splash
screen both look like. Always read the pane after the wait.

**Read the whole pane, not its last lines.** A modal can sit above the tail while
a spinner and a banner keep redrawing at the bottom, so a tail read shows motion
and hides the question. agy was called hung three separate times on that basis:
its log showed a backend call retrying every few minutes, which looked like a
stalled service. It was a folder-trust prompt nobody had answered. The same
binary opened in seconds in a plain terminal and inside Orca once a human
answered it. Diagnose from the full buffer, and treat "the process is doing
something" as no evidence at all that it is not waiting on a human.

**A CLI whose interactive path needs an answer every start does not belong at
2b.** Check how the vendor expects the agent to be driven before forcing a TUI:
Orca's registry delivers agy by stdin with `--print`, and that path is instant,
unattended, and takes `--input-format stream-json` for multi-step work.

Known gates worth pre-clearing rather than diagnosing repeatedly: claude's
directory trust dialog, codex's directory trust **and** a separate hook-trust
prompt that returns whenever a hook changes, and agy's folder trust. Each has a
flag in `agentkit preflight`'s launch table.

Prevent case (1) rather than diagnosing it repeatedly: every role's launch
command carries its CLI's permission-bypass flag, and the project directory is
trusted before the first dispatch. `agentkit preflight` checks the trust record
for each CLI (`~/.claude.json`, `~/.codex/config.toml`,
`~/.gemini/trustedFolders.json`) and names the file when the record is missing.
Trust is per machine — a workspace synced to a second OS starts untrusted there,
which is how this was first mistaken for a missing CLI feature.

For a CLI that really is case (2), run it in a pane without supervision:
`terminal split --command`, drive it with `terminal send`, read results from the
pane, and close the loop with `task-update` yourself.

## Starting a worker

Prefer the composed start. `worker-start --agent <orca_id>` creates the terminal,
handles readiness, and records the dispatch in one call:

```bash
orca orchestration worker-start --task <task_id> --worktree current \
  --agent <orca_id> [--model <id> --effort <level>] --json
```

`--model` and `--effort` are accepted only for agents whose launch supports them,
and never together with `--terminal`. Read the receipt: a failed or unknown start
exits nonzero and reports `stage`, `effects`, and `residualResources` — inspect
those rather than retrying blind. A start that reports `ok: false` can still have
dispatched the task and created the pane; that is the `outcome_unknown` case, and
it was reproduced here on 2026-08-19. Before retrying, check `task-list`,
`worker-list`, and `terminal list`. Clean up by dispatch id — `worker-stop` and
`worker-release` take `--dispatch`, and `task-update` takes `--id`.

Build the pane yourself only when you need argv the composed start cannot
express. Then the layout below applies.

**Release a settled worker; never close it by terminal handle.**
`worker-release --dispatch <id>` preserves the worker's output first, then closes
only the terminal that dispatch owns — it will not touch the coordinator, setup
terminals, or anything whose identity Orca cannot prove. `terminal close` has
none of those protections and takes a handle that may already be stale: handles
are runtime-scoped, and `--terminal` is optional on most commands, so a stale one
can resolve to the active terminal instead. A coordinator session was lost here
on 2026-08-19 by closing three already-closed worker handles. Use `terminal
close` only for panes you opened yourself that no dispatch owns.

## Pane layout

Workers stack down the right-hand side, so the coordinator stays on the left and
every worker is visible at once. Build the pane first, then bind it:

```bash
# first worker of a wave — vertical split puts it to the RIGHT of you
orca terminal split --terminal <coordinator_handle> --direction vertical \
  --command "<cli and flags from roles.toml>" --json

# every worker after that — horizontal split STACKS it under the previous one
orca terminal split --terminal <previous_worker_handle> --direction horizontal \
  --command "<cli and flags from roles.toml>" --json

orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 120000 --json
orca orchestration worker-start --task <task_id> --terminal <handle> --json
```

In Orca's naming `vertical` means side by side and `horizontal` means stacked;
the handle comes back at `result.split.handle`.

**Orca's own CLI guide states the opposite** ("`--direction horizontal` splits
left/right, `--direction vertical` splits top/bottom"). The guide is wrong.
Measured on Orca 1.4.185 by building the layout and reading it back with
`terminal list --include-visual-layouts`: splitting the coordinator with
`vertical` produced a side-by-side `pane-split`, and splitting that worker with
`horizontal` stacked the next one under it. Trust this paragraph over the guide,
and re-measure the same way before changing it — reading the guide alone has
already produced one proposal to invert these commands.

Binding with `--terminal` means `worker-start` will not accept `--model` or
`--effort`, so put the model in the split command itself — for example
`codex -c model="gpt-5.6-sol" -c model_reasoning_effort="xhigh"` or
`agy --model gemini-3.1-pro-high`. Read those values from `agents/roles.toml`.

Close a worker's pane when its dispatch is settled and you are not reusing it;
`orca terminal close --terminal <handle>` keeps the screen readable.

## Messages

Orca injects a "you have N orchestration messages" turn when a worker sends. It
is a hook, not the human speaking.

**Read the inbox, not `check`.** `orca orchestration check` returns one delivery
batch and has already returned fewer messages than were waiting; a scribe report
was missed that way. Use `orca orchestration inbox --json` to see everything, and
use `check --wait` only as a blocking wait signal.

Every `orca ... --json` response is NDJSON: decode object by object, never with a
single `json.load`.

`check` hands out a `deliveryId`. Close it with
`orca orchestration check --ack <delivery_id>`, otherwise the same batch is
redelivered on the next call. `--peek` shows true unread count without consuming.

A `worker-start` that reports `ok: false` may still have delivered the task —
that is the `outcome_unknown` case, and it has happened here. Before retrying,
check `task-list` and `worker-list`; a second start against a dispatched task
fails with `task_not_startable`.

## Dispatch discipline

Delegation messages must be self-contained. Include the task ID, problem,
desired outcome, safety class, exact repository and base ref, worktree path,
allowed and forbidden paths, constraints, acceptance criteria, required
evidence, and rollback. Never assume a worker has seen this conversation.

**Long output goes to a file, not through messages.** A report streamed through
orchestration messages lands in the coordinator's context verbatim and gets
re-read on every subsequent turn — one 15K-token report delivered in six
messages cost roughly a million tokens of re-reads before it reached durable
storage. The dispatch spec must name a report path (the vault's draft area if
the project has one, `agents/reports/<task_id>.md` otherwise); the worker writes
there and sends only the path plus a summary of at most ten lines. The
coordinator verifies the report where it lies — spot-checking claims against the
graph and the diff — and never copies its body into the conversation.

For a review dispatch, build the evidence pack: the diff and exact base ref,
`graphify explain` for every changed node, `graphify path` from each changed node
to the project's critical nodes, the invariant boundaries that apply, and any
measurements already taken.

## Memory belongs to the coordinator

A cross-session memory store (claude-mem or equivalent) hooks every session of
that CLI, including every worker. Left alone it inverts what it is for: measured
2026-08-19, a smoke-test probe was persisted under the project's own name while
the real coordinator session was filed under the home directory's name. Three
months later nothing distinguishes a throwaway prompt from an accepted decision.

The rule follows the gate, not the directory: **whoever cannot open a gate
cannot write to memory.** The coordinator spans work and keeps its store.
Workers are disposable by construction — their output goes to a report path and
the coordinator decides what becomes durable.

Claude Code loads plugins from `CLAUDE_CONFIG_DIR`, so a worker launched against
a config directory with no plugins runs without memory hooks. `agentkit
preflight` maintains that directory at `~/.agentkit/worker-config`: empty
`enabledPlugins`, the project marked trusted, and the real `.credentials.json`
symlinked in. The link is not optional — trust and credentials are both stored
per config directory, so without it every worker starts unauthenticated and
untrusted. Layer 1 never gets the prefix; 2a and 2b always do.

Do not reach for `--bare` for this. It skips hooks but also drops OAuth, keychain
reads, and CLAUDE.md discovery, so a subscription worker cannot authenticate and
would not read its own instructions.

## Permissions

Workers run with the permissive-but-answerable tier, not with checks removed:
`--permission-mode auto` for claude, `-a on-request` for codex, `--mode
accept-edits` for agy. Bypassing permission checks outright deletes the question
instead of answering it, which is the wrong trade in a repository where an agent
can change how a vehicle behaves. When the permissive tier does stop to ask,
`agentkit preflight --launch` reports it as a blocker rather than letting the
pane hang unexplained.

## Knowledge stores: the vault and the graph

Projects under this kit keep two stores beside git, and the coordinator is
their gatekeeper.

- **The vault (Obsidian)** records decisions, rationale, and field findings —
  what code cannot say. `scribe` is its only writer and writes canonical notes
  directly: an approval step that makes the coordinator carry every draft in
  context to relay it costs more than it protects. The gate is evidence, not a
  person — accepted scope, an independent verification report, an observed
  commit, and a fetch run this session — plus a fixed scope limit `scribe` may
  not cross: invariant boundaries, risk acceptance, safety thresholds, policy,
  and branch policy stay with the human. Those go to the draft area named in the
  report. Every other agent writes only to the draft area or `agents/reports/`.
  Validate wikilinks with `agents/vault_scan.py`, never with grep or a pasted
  snippet — regex pasted through a shell heredoc has been corrupted in transit
  and produced 34 false positives.
- **The code graph (graphify)** answers structure questions. The coordinator
  holds the query monopoly: workers receive a prepared, scoped subgraph and do
  not grep the repository for structure. Blast radius comes from `graphify
  path`, not from asking a model what a change might affect. After code changes
  run `graphify update .` — AST-only, no model cost, Layer 0.

Cross-checking a worker's report against the graph is cheap and catches the
expensive class of error: a claimed dependency the graph does not show, or a
missed one it does.

## Context hygiene

The dominant token cost of a long coordinator session is not the work — it is
the fixed per-turn overhead re-read on every turn: MCP tool listings, skill
listings, global instruction files. Budget it once at project setup:

- Disable MCP servers the project does not use in `.claude/settings.json`;
  every enabled server's tool listing is a tax on all turns of every session.
- Keep the machine-wide instruction file (`~/.claude/CLAUDE.md`) near-empty;
  anything project-specific belongs in the project files.
- Prefer few large tool calls over many small ones — each call re-reads the
  whole context. Batch independent shell commands.
- Answering a settled worker's idle notification costs a full-context turn;
  keep the notifications (they are the human's visibility), but do not reply
  unless the message needs an action.

## Separation of duties

- Architects and investigators establish facts and propose boundaries.
- One implementer edits the target component.
- The implementer never runs the final review gate.
- `reviewer`, `safety`, and `test-verifier` inspect the resulting diff and
  evidence independently.
- `scribe` updates accepted project state last, gated on evidence and its scope
  limit rather than on a human approving each delta.

If agents disagree, preserve both claims, identify the evidence each used, and
request a discriminating measurement. Never settle technical disagreement by
majority vote.

## Council protocol

Runs only on explicit human request.

**Round 1, independent.** Both models receive the identical evidence pack and
cannot see each other. The pack is the reviewer output, the scoped subgraph, the
applicable invariant boundaries, and any measurements — never the raw repository.

**Round 2, crossed.** Each receives the other's report verbatim and responds per
claim with agree / disagree / insufficient evidence. On disagreement they do not
vote; they write the discriminating measurement: the command to run, what result
proves which side.

**Merge.** You produce one table: claim · basis (measured / inferred / needs
measurement) · agreement · affected parts (from `graphify path`) · rollback.

There is no round three. If two rounds do not converge, the output is an
unresolved disagreement plus its discriminating measurement. That is the correct
result, not a failure.

## Sessions are disposable

Your context window is working memory, not storage. Orca is built this way on
purpose: a fresh worker is a fresh agent session, `--reuse-session` is opt-in and
only "when it is still available", and even a reused worker is re-engaged with a
fresh preamble rather than being trusted to remember. Durable state lives in the
Run/Task/Dispatch database, in git, in the vault, in the graph, and in these
files — never in a conversation.

Two consequences, and the second is the one that actually bites.

**Long sessions go stale silently.** A branch belief, a measurement, a git state
held in context ages without announcing it. This project has already been burned
by exactly that: a `origin/new` ref eleven days stale put wrong information into
the vault. A fresh start forces `git fetch` and reconciliation; a long-lived
coordinator quietly skips both.

**Sessions do not end politely.** The app gets closed, the limit runs out, the
process dies. Any rule of the form "write the handoff before you finish" will be
broken precisely when it matters most. So do not treat session end as the
checkpoint.

**Checkpoint at boundaries that already happen.** After each accepted
`worker_done`, after each gate decision, after each measurement, append what
changed and why. Each of those is already a turn you are taking, so the marginal
cost is a few lines — and the maximum loss from an abrupt death is one unit of
work rather than a whole session.

Never poll for remaining quota. Polling burns tokens on every check to buy
information you should not need: if checkpointing is continuous, running out of
limit costs one unit of work and there is nothing left to rescue. React to a
quota warning when the CLI surfaces one on its own; do not go asking.

## Authority

Stop when a required measurement needs hardware, credentials, a branch-policy
change, merge, deployment, arming, or field authority.

Git publication is task-scoped. Human authorization applies only to the exact
repository, staged paths, remote, source ref, and destination branch it names.
Staging, committing, and pushing are separate decisions. Generated graphify
output is not an exception.

Your final handoff must state gate status, exact commits, acceptance results,
residual risk, rollback, missing evidence, and whether any external action
occurred. Never describe a task as complete when only code exists.
