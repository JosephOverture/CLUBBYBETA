# Clubby Agent Orchestrator (v0.1)

This package is the first safe autonomous engineering loop for Clubby:

`Manager -> Coding Agent -> QA Agent -> optional repair -> QA`

It uses the OpenAI Agents SDK and intentionally has **no production, Stripe, AWS, deploy, merge, push, or refund permissions**.

## Safety model

- Read-only by default.
- Repository writes require the operator to pass `--write` explicitly.
- File tools are restricted to the selected repository root and block protected directories such as `.git`, `node_modules`, `dist`, and `.clubby-agents`.
- QA can run only an allow-list of repository checks; there is no arbitrary shell tool.
- Run summaries are saved under `.clubby-agents/runs/` and should not be committed.
- The API key stays in `OPENAI_API_KEY`; never place it in a source file or `.env` committed to git.

## Setup

Clubby currently targets Node 24. From this directory:

```bash
npm install
export OPENAI_API_KEY="..."
```

PowerShell:

```powershell
$env:OPENAI_API_KEY="..."
```

## Run in inspection mode

From the repository root:

```bash
npm run agent:run -- "Inspect the event details screen and propose a UI polish pass"
```

The coding agent can inspect the repo, but writes are blocked.

## Run with repository writes enabled

```bash
npm run agent:run -- --write "Polish the event details loading and empty states without changing product behavior"
```

The manager delegates implementation to the coding agent and then delegates validation to QA.

## Current QA allow-list

- `typecheck` -> `corepack pnpm typecheck`
- `mobile-typecheck` -> `corepack pnpm --filter @clubby/mobile typecheck`
- `unit-tests` -> `corepack pnpm test`
- `build` -> `corepack pnpm build`

Database tests are intentionally not yet exposed because they spin up infrastructure. Add them only after the agent runner is moved into a dedicated CI/sandbox environment.

## Recommended next step

Run v0.1 on 3-5 low-risk UI/backend tasks. Review every diff. Once it is consistently reliable, add a GitHub adapter that creates branches/PRs and a staging-only deployment agent. Keep payments, auth, migrations, secrets, and production deploys behind explicit approval until those workflows have dedicated policies and tests.
