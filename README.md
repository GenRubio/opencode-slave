# opencode-slave

Autonomous task runner for OpenCode repositories.

`opencode-slave` creates structured task folders under each project, executes tasks sequentially or in parallel, supports worktrees and per-task branches, and handles recovery/cleanup for long runs.

This README is an operations guide focused on real usage.

## What it gives you

- Task registry in `.opencode-slave/tasks.json`
- Per-task workspace at `.opencode-slave/tasks/{taskName}`
- Auto executor mode (`__auto__`) that attaches `TASK.md` + all `context/*` files
- Optional reviewer gate per task with feedback loop back into `context/`
- Sequential mode (same repo) and worktree mode (separate branch per task)
- Background execution and recovery (`slave-resume`)
- Human-in-the-loop state (`waiting_input`) when clarification is needed
- Cleanup commands for completed/error tasks

## Install

Prerequisites:

- Node.js + npm
- OpenCode CLI
- Git (required for no-clone installer path)

### Option A: from local clone (recommended for contributors)

macOS / Linux:

```bash
./install.sh --local
```

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Local
```

### Option B: no clone required

Replace `<owner>/<repo>` with your repository path once.

macOS / Linux:

```bash
curl -fsSL "https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh" | OPENCODE_SLAVE_REPO_URL="https://github.com/<owner>/<repo>.git" bash
```

Windows (PowerShell):

```powershell
$env:OPENCODE_SLAVE_REPO_URL = "https://github.com/<owner>/<repo>.git"
irm "https://raw.githubusercontent.com/<owner>/<repo>/main/install.ps1" | iex
```

### Option C: manual install from current checkout

```bash
npm install
npm run install:opencode
```

`npm run install:opencode` (or either installer script) installs `/slave-*` slash commands in your OpenCode profile:

- Commands: `~/.config/opencode/commands`
- Wrapper script: `~/.config/opencode/scripts/opencode-slave.js`

## Important: workspace selection

All commands run in the **current working directory**.

- If you want tasks in project A, run `/slave-*` inside project A.
- If you want tasks in project B, run `/slave-*` inside project B.
- There is no `--workspace /path` flag today.

## How to invoke commands

You have 3 equivalent ways to run commands:

1) OpenCode slash commands (recommended after `npm run install:opencode`):

```bash
/slave-task my-task
/slave-start --parallel
```

2) Local CLI from this repository:

```bash
node src/cli.js slave-task my-task
node src/cli.js slave-start --parallel
```

3) Bin command (if installed as executable):

```bash
slave slave-task my-task
slave slave-start --parallel
```

## Quick start

```bash
# 1) In your target repo
/slave-task task-a
/slave-task task-b

# 2) Fill instructions/context
# .opencode-slave/tasks/task-a/TASK.md
# .opencode-slave/tasks/task-a/context/*

# 3) Run
/slave-start

# 4) Inspect
/slave-status
/slave-logs task-a
```

## Command reference

```bash
/slave-task {name}
/slave-start [--dry-run] [--parallel] [--background] [--worktree {name}]
/slave-status
/slave-logs {name}
/slave-questions [name]
/slave-answer {name} "your answer"
/slave-reset {name}
/slave-cancel {name}
/slave-validate
/slave-resume
/slave-prune-worktrees
/slave-clean-finished [--include-errors]
/slave-config [--model provider/model] [--provider provider --model model] [--clear-model]
```

## Task layout

When you run `slave-task {name}`, the runner creates:

```text
.opencode-slave/
  config.json
  tasks.json
  tasks/
    {name}/
      TASK.md
      task.json
      context/
      logs/execution.log
      output/result.json
```

Key files:

- `TASK.md`: plain-language objective, constraints, success criteria
- `context/*`: source-of-truth artifacts for that task
- `task.json`: per-task runtime config (priority, retries, timeout, worktree mode, executor)

Per-task branch/worktree toggle (inside each `task.json`):

```json
{
  "runInWorktree": true,
  "branchName": null,
  "baseBranch": null,
  "useCurrentBranchAsBase": false,
  "review": {
    "mode": "none",
    "commandTemplate": "__auto__"
  }
}
```

- `true`: run that task in a separate worktree/branch
- `false`: run that task in the current branch/workspace
- `branchName`: optional explicit branch name for that task (`null` = auto `branchPrefix + taskName`)
- `baseBranch`: optional base branch for that task (`null` = global `config.baseBranch`)
- `useCurrentBranchAsBase`: if `true`, use the currently checked out branch as the base when the worktree is created
- `review.mode`: `none` or `agent`
- `review.commandTemplate`: reviewer command (`__auto__` = OpenCode reviewer agent)

## Status lifecycle

Possible task states:

- `pending`
- `started`
- `waiting_input`
- `finished`
- `error`
- `cancelled`

Use `slave-status` to see status, retries, lease info, and last error.

## Execution modes

### 1) Sequential (single workspace)

Runs pending tasks in priority order in the current repo working tree.
If a task has `runInWorktree: true`, that individual task runs in its own worktree/branch even in sequential mode.

```bash
node src/cli.js /slave-start
```

### 2) Single task in worktree

Runs one task in its own worktree/branch.

```bash
node src/cli.js /slave-start --worktree task-a
```

### 3) Parallel with worktrees

Runs multiple tasks concurrently, each task in its own worktree/branch.

```bash
node src/cli.js /slave-start --parallel
```

### 4) Background worker

Runs detached (long-running).

```bash
node src/cli.js /slave-start --background
node src/cli.js /slave-status
node src/cli.js /slave-resume
```

`slave-resume` can recover stale `started` tasks when:

- lease expired, or
- process PID is dead, or
- heartbeat is stale.

## How to run each task on a separate branch from a branch you choose

This is the most important setup for branch isolation.

1) Edit `.opencode-slave/config.json` in your target repo.
2) Set these keys:

```json
{
  "baseBranch": "develop",
  "branchPrefix": "slave/",
  "worktreeBasePath": "../worktrees",
  "maxParallel": 3,
  "opencodeInactivityTimeoutSec": 300
}
```

3) Create tasks (`/slave-task ...`).
4) Run with worktrees (`/slave-start --parallel` or `/slave-start --worktree <task>`).

Per-task control option:

- Set `runInWorktree: true` only on tasks that must run in separate branches.
- Leave others with `runInWorktree: false` to run on current branch when using normal `/slave-start`.
- Optionally set `branchName` and `baseBranch` in each task:

```json
{
  "runInWorktree": true,
  "branchName": "feature/navbar-redesign",
  "baseBranch": "dev",
  "useCurrentBranchAsBase": false
}
```

If either value is `null`, global defaults are used.

To force a task to branch from whatever branch you are on when it starts:

```json
{
  "runInWorktree": true,
  "useCurrentBranchAsBase": true
}
```

Branch/worktree behavior:

- Branch name per task: `{branchPrefix}{taskName}`
- Worktree path: `{worktreeBasePath}/{repoName}-slave-{taskName}`
- Base for new branch: tries `origin/{baseBranch}` first, then local `{baseBranch}` fallback
- If `useCurrentBranchAsBase` is `true`, the task worktree uses the branch currently checked out at launch time
- Ignored local files like `.env` are copied into the task worktree after creation, except internal `.git` and `.opencode-slave`

`opencodeInactivityTimeoutSec` interrupts `__auto__` executions when no stdout/stderr is produced for too long, so tasks do not stay stuck in `started` forever.

Set `"opencodeInactivityTimeoutSec": 0` to disable inactivity timeout completely (recommended for very long tasks that may run for hours/days without output).

Useful git checks:

```bash
git worktree list
git branch --list "slave/*"
```

## Model selection

Set model override per project:

```bash
node src/cli.js /slave-config --model opencode/gpt-5.3-codex
```

Or split provider/model:

```bash
node src/cli.js /slave-config --provider opencode --model gpt-5.3-codex
```

Show current config:

```bash
node src/cli.js /slave-config
```

Clear override (use OpenCode default):

```bash
node src/cli.js /slave-config --clear-model
```

Notes:

- Default for new projects is `opencode/gpt-5.3-codex`.
- `openai/gpt-5.3-codex` is normalized to `opencode/gpt-5.3-codex` for CLI compatibility.

## Auto executor and custom executor

### Auto executor (`__auto__`)

Default mode in each task:

```json
{
  "executor": {
    "commandTemplate": "__auto__"
  }
}
```

In this mode the runner:

- Always attaches `TASK.md`
- Always attaches all files under `context/`
- Builds and runs an `opencode run` command

### Reviewer gate

You can enable a reviewer per task in `.opencode-slave/tasks/{name}/task.json`:

```json
{
  "review": {
    "mode": "agent",
    "commandTemplate": "__auto__"
  }
}
```

Behavior:

- Reviewer runs only after the implementation command succeeds
- Reviewer is instructed to stay read-only and verify the task against `TASK.md` + `context/*`
- On reviewer failure, feedback is written to `context/review-feedback.md`
- Next retry automatically receives that feedback because all `context/*` files are attached again
- Latest reviewer report is stored in `output/review.json`

You can also use a deterministic custom reviewer command:

```json
{
  "review": {
    "mode": "agent",
    "commandTemplate": "npm test"
  }
}
```

### Custom executor

You can set a custom command in `.opencode-slave/tasks/{name}/task.json`:

```json
{
  "executor": {
    "commandTemplate": "node \"{taskDir}/context/run.cjs\""
  }
}
```

Supported placeholders:

- `{taskName}`
- `{taskDir}`
- `{taskFile}`
- `{workspace}`
- `{providerModel}`

## Human-in-the-loop (`waiting_input`)

If a task needs clarification, it moves to `waiting_input` instead of hard failing.

```bash
node src/cli.js /slave-questions
node src/cli.js /slave-questions task-a
node src/cli.js /slave-answer task-a "Use option B and keep mobile layout"
node src/cli.js /slave-start --background
```

Artifacts:

- Questions file: `.opencode-slave/tasks/{name}/questions.md`
- Answers log: `.opencode-slave/tasks/{name}/context/answers.md`

## Cleanup and maintenance

Remove finished/cancelled tasks:

```bash
node src/cli.js /slave-clean-finished
```

Also remove `error` tasks:

```bash
node src/cli.js /slave-clean-finished --include-errors
```

Prune stale git worktree metadata:

```bash
node src/cli.js /slave-prune-worktrees
```

## Hooks (advanced)

Per-task hooks are supported if `securityMode` allows execution.

Place scripts in task folder:

- `pre-run.sh` / `pre-run.ps1` / `pre-run.cmd`
- `post-run.sh` / `post-run.ps1` / `post-run.cmd`

Default `securityMode` is `untrusted` (hooks are skipped).

## Troubleshooting

### Task stays `started` too long

- Check logs: `node src/cli.js /slave-logs {task}`
- Recover stale state: `node src/cli.js /slave-resume`
- If needed, reset task: `node src/cli.js /slave-reset {task}`

`execution.log` now streams stdout/stderr line by line while the command is running.

If the command is silent, heartbeat lines are appended periodically so you can still see progress while a task runs.

### Need to remove extra worktrees

- Run `node src/cli.js /slave-prune-worktrees`
- Or manually remove with `git worktree remove --force <path>` then prune

### Auto executor cannot run model/session

- Verify provider/model with `/slave-config`
- If environment/session is broken, use a custom executor for deterministic tasks

## Test the runner

From this repository:

```bash
npm test
```

## Design spec

Full orchestration spec is in `opencode-slave-plugin.md`.
