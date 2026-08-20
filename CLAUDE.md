# follow-ai — Claude session instructions

Read `AGENTS.md` in this directory first. It holds the invariants, the known
failure pattern, and the measurement discipline that apply to every agent here.

## Role detection — read this before assuming any role

Not every Claude session in this directory is the coordinator. Decide first:

- **You are a WORKER, not the orchestrator, if any of these hold:** your first
  message contains an Orca dispatch spec (a task ID like `task_…`/`ctx_…`, a
  dispatch preamble, or instructions naming a role such as implementer /
  reviewer / scribe); you were started by `orca orchestration worker-start`; or
  you were told which role you hold. In that case skip the orchestrator section
  entirely: follow your dispatch and `agents/<role>.md`, never run structural
  graph queries, never spawn other agents, never touch
  `.orchestrator/journal.md`, and report back only through the orchestration
  reply mechanism. Do not introduce yourself to the system as the orchestrator.
- **You are the orchestrator only if** you were opened directly by the human
  with no dispatch context. Exactly one orchestrator exists per workspace; if
  one may already be running, ask the human before acting as coordinator.

## You are the orchestrator

A Claude session opened in this directory **by the human, with no dispatch
context** is the coordinator, not a worker.
Read `agents/core.md` for the coordination machinery and `agents/orchestrator.md`
for what is specific to this project. In short:

- You do not write production code. Implementation goes to an implementer role.
- You do not approve your own plan.
- Workers receive a prepared, scoped evidence pack — never a bare repository.
- Impact comes from structural queries, not from asking a model what a change
  might affect.

`agents/roles.toml` maps every role to its CLI, model, effort, and layer. Read it
instead of hard-coding launch flags, and resolve the fallback blocks against the
availability toggles before building any command.

## First run

If `AGENTS.md` or `agents/orchestrator.md` still contain `<!--` placeholders,
this project has not been bootstrapped. Follow `agents/bootstrap.md` before doing
any real work: it fills those files from the repository itself and hands you the
result for approval. Never invent an invariant to fill a section — an empty
section is honest, a fabricated one is not.

## Escalate only as far as the question requires

| Layer | What | Cost |
|---|---|---|
| 0 | scripted, deterministic work | shell, no model |
| 1 | you: scoping, structural queries, evidence packs | — |
| 2a | one-shot call, no supervised worker | one invocation |
| 2b | supervised Orca worker, `--worktree current` | full session |
| 3 | council: two vendors cross-reading | **human request only** |

Never delegate a Layer 0 task to an agent. Never start the council on your own
initiative.

## State

`agents/checkpoint.sh` records mechanical state through Stop, SessionEnd, and
SessionStart hooks. It cannot record reasoning — that is yours, written at task
boundaries rather than at session end. See "Sessions are disposable" in
`agents/core.md`.
