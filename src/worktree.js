const path = require("path");
const { runCommand } = require("./utils/process");

async function isGitRepo(rootDir) {
  const result = await runCommand({
    command: "git rev-parse --is-inside-work-tree",
    cwd: rootDir,
  });
  return result.code === 0;
}

function getWorktreePath(rootDir, config, taskName) {
  const repoName = path.basename(rootDir);
  return path.resolve(rootDir, config.worktreeBasePath, `${repoName}-slave-${taskName}`);
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveWorktreeRefs(config, taskName, options = {}) {
  const overrideBranch = normalizeOptionalString(options.branchName);
  const overrideBase = normalizeOptionalString(options.baseBranch);

  return {
    branch: overrideBranch || `${config.branchPrefix}${taskName}`,
    baseBranch: overrideBase || config.baseBranch,
  };
}

function getBranchName(config, taskName, options = {}) {
  return resolveWorktreeRefs(config, taskName, options).branch;
}

async function createWorktree(rootDir, config, taskName, options = {}) {
  const worktreePath = getWorktreePath(rootDir, config, taskName);
  const { branch, baseBranch } = resolveWorktreeRefs(config, taskName, options);

  await runCommand({
    command: `git fetch origin ${baseBranch}`,
    cwd: rootDir,
  });

  let result = await runCommand({
    command: `git worktree add "${worktreePath}" -b "${branch}" "origin/${baseBranch}"`,
    cwd: rootDir,
  });

  if (result.code !== 0 && `${result.stderr || result.stdout}`.includes("already exists")) {
    result = await runCommand({
      command: `git worktree add "${worktreePath}" "${branch}"`,
      cwd: rootDir,
    });
  }

  if (result.code !== 0) {
    result = await runCommand({
      command: `git worktree add "${worktreePath}" -b "${branch}" "${baseBranch}"`,
      cwd: rootDir,
    });

    if (result.code !== 0 && `${result.stderr || result.stdout}`.includes("already exists")) {
      result = await runCommand({
        command: `git worktree add "${worktreePath}" "${branch}"`,
        cwd: rootDir,
      });
    }
  }

  if (result.code !== 0) {
    throw new Error(
      `Unable to create worktree for '${taskName}' (branch='${branch}', base='${baseBranch}'): ${result.stderr || result.stdout}`
    );
  }

  return {
    worktreePath,
    branch,
    baseBranch,
  };
}

async function hasWorktreeChanges(worktreePath) {
  const result = await runCommand({
    command: "git status --porcelain",
    cwd: worktreePath,
  });

  return result.code === 0 && result.stdout.trim().length > 0;
}

async function removeWorktree(rootDir, worktreePath, force = false) {
  const forceFlag = force ? "--force" : "";
  const result = await runCommand({
    command: `git worktree remove ${forceFlag} "${worktreePath}"`,
    cwd: rootDir,
  });

  if (result.code !== 0) {
    throw new Error(`Unable to remove worktree '${worktreePath}': ${result.stderr || result.stdout}`);
  }
}

async function pruneWorktrees(rootDir) {
  return runCommand({
    command: "git worktree prune",
    cwd: rootDir,
  });
}

async function autoCommit(worktreePath, taskName) {
  const result = await runCommand({
    command: `git add . && git commit -m "chore(slave): complete task ${taskName}"`,
    cwd: worktreePath,
  });

  return result;
}

async function maybeCreatePr(worktreePath, config, branch) {
  const auth = await runCommand({ command: "gh auth status", cwd: worktreePath });
  if (auth.code !== 0) {
    return {
      created: false,
      reason: "gh auth status failed",
    };
  }

  const push = await runCommand({ command: `git push -u origin "${branch}"`, cwd: worktreePath });
  if (push.code !== 0) {
    return {
      created: false,
      reason: "git push failed",
      output: push.stderr || push.stdout,
    };
  }

  const bodyPath = path.join(".opencode-slave", "templates", "pr.md");
  const pr = await runCommand({
    command: `gh pr create --base "${config.baseBranch}" --head "${branch}" --title "slave: ${branch}" --body-file "${bodyPath}"`,
    cwd: worktreePath,
  });

  if (pr.code !== 0) {
    return {
      created: false,
      reason: "gh pr create failed",
      output: pr.stderr || pr.stdout,
    };
  }

  return {
    created: true,
    output: pr.stdout,
  };
}

module.exports = {
  isGitRepo,
  getWorktreePath,
  getBranchName,
  resolveWorktreeRefs,
  createWorktree,
  hasWorktreeChanges,
  removeWorktree,
  pruneWorktrees,
  autoCommit,
  maybeCreatePr,
};
