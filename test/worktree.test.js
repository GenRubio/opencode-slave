const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorktree, resolveWorktreeRefs } = require("../src/worktree");

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "opencode-slave-worktree-"));
}

test("resolveWorktreeRefs uses global defaults when task overrides are null", () => {
  const refs = resolveWorktreeRefs(
    {
      branchPrefix: "slave/",
      baseBranch: "main",
    },
    "task-a",
    {
      branchName: null,
      baseBranch: null,
    }
  );

  assert.equal(refs.branch, "slave/task-a");
  assert.equal(refs.baseBranch, "main");
});

test("resolveWorktreeRefs honors per-task branch and base overrides", () => {
  const refs = resolveWorktreeRefs(
    {
      branchPrefix: "slave/",
      baseBranch: "main",
    },
    "task-b",
    {
      branchName: "feature/custom-branch",
      baseBranch: "dev",
    }
  );

  assert.equal(refs.branch, "feature/custom-branch");
  assert.equal(refs.baseBranch, "dev");
});

test("resolveWorktreeRefs supports using current branch as base", () => {
  const refs = resolveWorktreeRefs(
    {
      branchPrefix: "slave/",
      baseBranch: "main",
    },
    "task-c",
    {
      useCurrentBranchAsBase: true,
    }
  );

  assert.equal(refs.branch, "slave/task-c");
  assert.equal(refs.baseBranch, null);
  assert.equal(refs.useCurrentBranchAsBase, true);
});

test("createWorktree copies ignored local config files into task workspace", async () => {
  const root = await makeTempDir();
  await git(["init", "-b", "main"], root);
  await fs.writeFile(path.join(root, ".gitignore"), ".env\nlocal-config/\n.opencode-slave/\n", "utf8");
  await fs.writeFile(path.join(root, "tracked.txt"), "tracked\n", "utf8");
  await git(["add", ".gitignore", "tracked.txt"], root);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], root);

  await fs.writeFile(path.join(root, ".env"), "TOKEN=secret\n", "utf8");
  await fs.mkdir(path.join(root, "local-config"), { recursive: true });
  await fs.writeFile(path.join(root, "local-config", "settings.json"), '{"ok":true}\n', "utf8");
  await fs.mkdir(path.join(root, ".opencode-slave"), { recursive: true });
  await fs.writeFile(path.join(root, ".opencode-slave", "do-not-copy.txt"), "internal\n", "utf8");

  const worktree = await createWorktree(root, {
    worktreeBasePath: "../worktrees",
    branchPrefix: "slave/",
    baseBranch: "main",
  }, "task-copy");

  const copiedEnv = await fs.readFile(path.join(worktree.worktreePath, ".env"), "utf8");
  assert.equal(copiedEnv, "TOKEN=secret\n");

  const copiedSettings = await fs.readFile(path.join(worktree.worktreePath, "local-config", "settings.json"), "utf8");
  assert.equal(copiedSettings, '{"ok":true}\n');

  await assert.rejects(() => fs.access(path.join(worktree.worktreePath, ".opencode-slave", "do-not-copy.txt")));
});

test("createWorktree can use current branch as base per task", async () => {
  const root = await makeTempDir();
  await git(["init", "-b", "main"], root);
  await fs.writeFile(path.join(root, "tracked.txt"), "main\n", "utf8");
  await git(["add", "tracked.txt"], root);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], root);

  await git(["checkout", "-b", "feature/current-base"], root);
  await fs.writeFile(path.join(root, "feature-only.txt"), "feature\n", "utf8");
  await git(["add", "feature-only.txt"], root);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "feature"], root);

  const worktree = await createWorktree(root, {
    worktreeBasePath: "../worktrees",
    branchPrefix: "slave/",
    baseBranch: "main",
  }, "task-current", {
    useCurrentBranchAsBase: true,
  });

  const featureFile = await fs.readFile(path.join(worktree.worktreePath, "feature-only.txt"), "utf8");
  assert.equal(featureFile.trim(), "feature");
  assert.equal(worktree.baseBranch, "feature/current-base");
});
