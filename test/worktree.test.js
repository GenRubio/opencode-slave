const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveWorktreeRefs } = require("../src/worktree");

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
