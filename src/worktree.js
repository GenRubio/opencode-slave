const fs = require("fs/promises");
const path = require("path");
const { runCommand } = require("./utils/process");
const { copyPath, pathExists } = require("./utils/fs");

const IGNORED_COPY_EXCLUDES = [".git", ".opencode-slave"];

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
  const useCurrentBranchAsBase = Boolean(options.useCurrentBranchAsBase);

  return {
    branch: overrideBranch || `${config.branchPrefix}${taskName}`,
    baseBranch: useCurrentBranchAsBase ? null : (overrideBase || config.baseBranch),
    useCurrentBranchAsBase,
  };
}

function getBranchName(config, taskName, options = {}) {
  return resolveWorktreeRefs(config, taskName, options).branch;
}

async function createWorktree(rootDir, config, taskName, options = {}) {
  const worktreePath = getWorktreePath(rootDir, config, taskName);
  const refs = resolveWorktreeRefs(config, taskName, options);
  const branch = refs.branch;
  const baseBranch = refs.useCurrentBranchAsBase ? await getCurrentBranch(rootDir) : refs.baseBranch;

  if (!baseBranch) {
    throw new Error(`Unable to resolve base branch for '${taskName}'.`);
  }

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

  await copyIgnoredFilesToWorktree(rootDir, worktreePath);

  return {
    worktreePath,
    branch,
    baseBranch,
  };
}

async function getCurrentBranch(rootDir) {
  const result = await runCommand({
    command: "git branch --show-current",
    cwd: rootDir,
  });

  if (result.code !== 0) {
    throw new Error(`Unable to detect current branch: ${result.stderr || result.stdout}`);
  }

  const branch = normalizeOptionalString(result.stdout);
  if (!branch) {
    throw new Error("Current HEAD is detached; cannot use current branch as base.");
  }

  return branch;
}

function shouldSkipIgnoredPath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  return IGNORED_COPY_EXCLUDES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}

async function listIgnoredPaths(rootDir) {
  const result = await runCommand({
    command: "git ls-files --others -i --exclude-standard -z",
    cwd: rootDir,
  });

  if (result.code !== 0) {
    throw new Error(`Unable to list ignored files: ${result.stderr || result.stdout}`);
  }

  return (result.stdout || "")
    .split("\u0000")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !shouldSkipIgnoredPath(entry));
}

async function copyIgnoredFilesToWorktree(rootDir, worktreePath) {
  const ignoredPaths = await listIgnoredPaths(rootDir);

  for (const relativePath of ignoredPaths) {
    const sourcePath = path.join(rootDir, relativePath);
    const destinationPath = path.join(worktreePath, relativePath);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    const destinationExists = await pathExists(destinationPath);
    if (destinationExists) {
      await fs.rm(destinationPath, { recursive: true, force: true });
    }

    await copyPath(sourcePath, destinationPath);
  }
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

async function maybeCreatePr(worktreePath, config, branch, baseBranch = config.baseBranch) {
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
    command: `gh pr create --base "${baseBranch}" --head "${branch}" --title "slave: ${branch}" --body-file "${bodyPath}"`,
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
  listIgnoredPaths,
  copyIgnoredFilesToWorktree,
  getCurrentBranch,
};
