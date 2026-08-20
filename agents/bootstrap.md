---
name: bootstrap
description: First-run procedure. The coordinator inspects a freshly scaffolded project and fills the placeholders that agentkit could not know, then hands the result to the human for approval.
---

# Bootstrap

`agentkit init` produces a working skeleton with placeholders. This procedure
fills them. Run it once, in the coordinator session, before doing any real work.

You are completing a scaffold, not designing the project. Everything you write
must be traceable to something you read or something the human told you.

## The one rule

**Never invent an invariant.** An invariant boundary is a decision somebody made,
with a reason. If you cannot point to where a constraint was decided — a README,
an ADR, a config that enforces it, a commit message, a comment, or the human
saying so — it does not go in the file. A fabricated constraint is worse than an
empty section: the section reads as authoritative and nobody re-checks it.

The same holds for the failure pattern. Do not guess what tends to break here.
Leave it empty until something bites twice; that is what the section is for.

## Sequence

**1. Read before asking.** Work through what the repository already tells you:
README and docs, package or build manifests, CI configuration, lint and type
config, test layout, directory structure, `git log` for recurring themes, issue
templates. Cheap and factual.

**2. Establish where truth lives.** Every project has sources that outrank each
other. Code proves what runs. Something else records why. Find both, and name the
document a new session must read first. If no such document exists, say so — that
absence is itself worth reporting.

**3. Derive the measurement discipline.** What does this project measure, with
what, and which readings have misled someone before? Only the third part needs
the human. Generic rules already live in the template; add specifics or leave it.

**4. Prune the roles.** The scaffold ships a full set. Delete from `roles.toml`
and `agents/` what this project has no use for, and say why. A `safety` role on a
static site is noise; a `safety` role on anything that moves, spends money, or
deletes data is not. Adjust models per role to match how hard each job actually
is here — the cheap tier exists to be used.

**5. Stand up the knowledge stores.** Both stores in `core.md` §Knowledge
stores are expected in every project:

- **Graph:** check `graphify` is on PATH, then build the initial graph with
  `graphify update .` (Layer 0, no model cost) and confirm
  `graphify-out/graph.json` exists. If the CLI is missing, tell the human what
  to install rather than skipping the store silently.
- **Vault:** locate the project's Obsidian vault or, with the human's consent,
  create one with a draft/inbox folder for worker reports. Record its path in
  `agents/orchestrator.md` under "where truth lives". Wire `agents/vault_scan.py`
  as the link validator.
- **Context diet:** list the MCP servers enabled for this project and propose
  disabling the unused ones in `.claude/settings.json` (see `core.md`
  §Context hygiene) — this is the single largest per-turn cost lever.

**6. Ask for what is left.** Collect the gaps into one short list of concrete
questions. Do not ask what you could have read. Do not ask in a drip.

**7. Propose, do not commit.** Present the filled `AGENTS.md`, the filled
`agents/orchestrator.md`, and the role changes as a diff for approval. These
files govern every future session; the human signs them off.

## Done when

`agentkit doctor` reports no remaining placeholders, every section is either
filled from evidence or deliberately deleted, and the human has accepted the
result. Record in the vault or the project's own status document that bootstrap
happened and on what date.
