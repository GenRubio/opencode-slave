const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const {
  DEFAULT_EXECUTOR_COMMAND_TEMPLATE,
  OPENCODE_ENV_UNSET_KEYS,
  TASK_STATUSES,
} = require("./constants");
const { createLogger } = require("./logger");
const { acquireLock, refreshLock, releaseLock } = require("./lock");
const { runInvestigation } = require("./investigation");
const {
  getAbsolutePaths,
  ensureBaseStructure,
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  ensureTaskDirectory,
  readTaskConfig,
  syncTaskFoldersToState,
  createTaskRecord,
} = require("./state");
const { pathExists, appendLine, readJson, writeJsonAtomic, listFilesRecursive } = require("./utils/fs");
const { isProcessAlive, runCommand } = require("./utils/process");
const { addSeconds, isExpired, nowIso, sleep } = require("./utils/time");
const { buildDependencyErrors, detectDependencyCycles, validateTaskName } = require("./utils/validation");
const { buildHookCommand, resolveHook } = require("./hooks");
const {
  autoCommit,
  createWorktree,
  hasWorktreeChanges,
  isGitRepo,
  maybeCreatePr,
  pruneWorktrees,
  removeWorktree,
} = require("./worktree");

function getTaskByName(state, taskName) {
  return state.tasks.find((task) => task.name === taskName);
}

function getTaskDir(rootDir, taskName) {
  return path.join(rootDir, ".opencode-slave", "tasks", taskName);
}

function getTaskLogPath(rootDir, taskName) {
  return path.join(getTaskDir(rootDir, taskName), "logs", "execution.log");
}

function getTaskContextDir(rootDir, taskName) {
  return path.join(getTaskDir(rootDir, taskName), "context");
}

function getTaskResultPath(rootDir, taskName) {
  return path.join(getTaskDir(rootDir, taskName), "output", "result.json");
}

function getTaskQuestionsPath(rootDir, taskName) {
  return path.join(getTaskDir(rootDir, taskName), "questions.md");
}

function getTaskAnswersPath(rootDir, taskName) {
  return path.join(getTaskContextDir(rootDir, taskName), "answers.md");
}

function getTaskReviewFeedbackPath(rootDir, taskName) {
  return path.join(getTaskContextDir(rootDir, taskName), "review-feedback.md");
}

function getTaskReviewResultPath(rootDir, taskName) {
  return path.join(getTaskDir(rootDir, taskName), "output", "review.json");
}

function getTaskCheckpointPath(rootDir, taskName) {
  return path.join(rootDir, ".opencode-slave", "runtime", "checkpoints", `${taskName}.checkpoint.json`);
}

class WaitingInputRequiredError extends Error {
  constructor(message, questions = []) {
    super(message);
    this.name = "WaitingInputRequiredError";
    this.waitingInput = true;
    this.questions = Array.isArray(questions) ? questions : [];
  }
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function normalizeReviewMode(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["agent", "llm", "reviewer"].includes(normalized)) {
    return "agent";
  }

  return "none";
}

function mergeTaskWithConfig(task, taskConfig, globalConfig) {
  const branchName = typeof taskConfig.branchName === "string" && taskConfig.branchName.trim().length > 0
    ? taskConfig.branchName.trim()
    : null;
  const baseBranch = typeof taskConfig.baseBranch === "string" && taskConfig.baseBranch.trim().length > 0
    ? taskConfig.baseBranch.trim()
    : null;
  const useCurrentBranchAsBase = Boolean(taskConfig.useCurrentBranchAsBase ?? task.useCurrentBranchAsBase ?? false);
  const reviewConfig = taskConfig.review || {};
  const reviewCommandTemplate =
    typeof reviewConfig.commandTemplate === "string" && reviewConfig.commandTemplate.trim().length > 0
      ? reviewConfig.commandTemplate.trim()
      : task.reviewCommandTemplate || DEFAULT_EXECUTOR_COMMAND_TEMPLATE;

  return {
    ...task,
    priority: Number(taskConfig.priority ?? task.priority ?? 100),
    dependsOn: asArray(taskConfig.dependsOn ?? task.dependsOn),
    maxRetries: Number(taskConfig.maxRetries ?? task.maxRetries ?? globalConfig.defaultMaxRetries),
    timeoutSec: Number(taskConfig.timeoutSec ?? task.timeoutSec ?? globalConfig.defaultTimeoutSec),
    runInWorktree: Boolean(taskConfig.runInWorktree ?? task.runInWorktree ?? false),
    branchName,
    baseBranch,
    useCurrentBranchAsBase,
    reviewMode: normalizeReviewMode(reviewConfig.mode ?? task.reviewMode ?? globalConfig.reviewMode),
    reviewCommandTemplate,
    investigationBudget: Number(
      taskConfig.investigationBudget ?? task.investigationBudget ?? globalConfig.defaultInvestigationBudget
    ),
    tags: asArray(taskConfig.tags ?? task.tags),
  };
}

function shouldUseWorktreeForTask(task, options) {
  if (options.singleTaskName || options.parallel) {
    return true;
  }

  return Boolean(task.runInWorktree);
}

async function loadTaskConfigs(rootDir, state, config) {
  const mergedTasks = [];
  for (const task of state.tasks) {
    const taskConfig = await readTaskConfig(rootDir, task.name);
    mergedTasks.push(mergeTaskWithConfig(task, taskConfig, config));
  }
  state.tasks = mergedTasks;
}

function dependenciesFinished(task, state) {
  for (const depName of task.dependsOn || []) {
    const dep = getTaskByName(state, depName);
    if (!dep || dep.status !== TASK_STATUSES.FINISHED) {
      return false;
    }
  }
  return true;
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }

    if ((a.createdAt || "") !== (b.createdAt || "")) {
      return (a.createdAt || "").localeCompare(b.createdAt || "");
    }

    return a.name.localeCompare(b.name);
  });
}

function createStateManager(rootDir, state) {
  let writeQueue = Promise.resolve();

  async function update(mutator) {
    writeQueue = writeQueue.then(async () => {
      mutator(state);
      await saveState(rootDir, state);
    });

    await writeQueue;
  }

  return {
    state,
    update,
  };
}

async function runHookIfAllowed({ rootDir, taskName, taskWorkspace, hookType, config }) {
  if (config.securityMode === "untrusted") {
    return { skipped: true, reason: "security mode is untrusted" };
  }

  const taskDir = getTaskDir(rootDir, taskName);
  const hookPath = await resolveHook(taskDir, hookType);
  if (!hookPath) {
    return { skipped: true, reason: "hook not found" };
  }

  const command = buildHookCommand(hookPath);
  const result = await runCommand({
    command,
    cwd: taskWorkspace,
  });

  return {
    skipped: false,
    command,
    result,
  };
}

async function getGitStatusSnapshot(cwd) {
  const result = await runCommand({ command: "git status --porcelain", cwd, timeoutSec: 30 });
  if (result.code !== 0) {
    return null;
  }

  return (result.stdout || "").trim();
}

function getProviderModel(config) {
  if (config.opencodeProvider && config.opencodeModel) {
    return `${config.opencodeProvider}/${config.opencodeModel}`;
  }

  if (config.opencodeModel && config.opencodeModel.includes("/")) {
    return config.opencodeModel;
  }

  return null;
}

function getReviewProviderModel(config) {
  if (config.reviewProvider && config.reviewModel) {
    return `${config.reviewProvider}/${config.reviewModel}`;
  }

  return getProviderModel(config);
}

function escapeDoubleQuotes(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function stripAnsi(input) {
  return String(input || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function extractHumanInputQuestions(stdoutText, stderrText) {
  const combined = `${stripAnsi(stdoutText)}\n${stripAnsi(stderrText)}`;
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const questionLike = lines.filter((line) => {
    return (
      /\?$/.test(line) ||
      /(please provide|could you provide|need more context|which option|what should|confirm|clarify|missing context)/i.test(
        line
      )
    );
  });

  if (questionLike.length > 0) {
    return questionLike.slice(0, 8);
  }

  return [];
}

function formatQuestionsMarkdown(taskName, reason, questions) {
  const lines = [
    `# Questions for ${taskName}`,
    "",
    `Blocked reason: ${reason}`,
    "",
    "## Questions",
  ];

  if (!questions || questions.length === 0) {
    lines.push("- Please add missing context to TASK.md or context/ and resume the task.");
  } else {
    for (const question of questions) {
      lines.push(`- ${question}`);
    }
  }

  lines.push("", "## How to answer", "- Use /slave-answer {task} \"your answer\"", "- Or add files under context/");
  return `${lines.join("\n")}\n`;
}

function createTaskStreamLogger(logPath, prefix = "") {
  let writeQueue = Promise.resolve();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let sawStdout = false;
  let sawStderr = false;

  function enqueue(line) {
    writeQueue = writeQueue.then(() => appendLine(logPath, line)).catch(() => {
      // best effort
    });
    return writeQueue;
  }

  function consume(stream, chunk) {
    const text = stripAnsi(chunk || "");
    if (!text) {
      return;
    }

    if (stream === "stdout") {
      sawStdout = true;
      stdoutBuffer += text;
    } else {
      sawStderr = true;
      stderrBuffer += text;
    }

    const currentBuffer = stream === "stdout" ? stdoutBuffer : stderrBuffer;
    const normalized = currentBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = normalized.split("\n");
    const completeLines = parts.slice(0, -1);
    const remaining = parts[parts.length - 1] || "";
    const streamLabel = prefix ? `${prefix}${stream}` : stream;

    for (const line of completeLines) {
      enqueue(`[${nowIso()}] ${streamLabel}: ${line}`);
    }

    if (stream === "stdout") {
      stdoutBuffer = remaining;
    } else {
      stderrBuffer = remaining;
    }
  }

  async function flush() {
    const stdoutLabel = prefix ? `${prefix}stdout` : "stdout";
    const stderrLabel = prefix ? `${prefix}stderr` : "stderr";
    if (stdoutBuffer.length > 0) {
      enqueue(`[${nowIso()}] ${stdoutLabel}: ${stdoutBuffer}`);
      stdoutBuffer = "";
    }

    if (stderrBuffer.length > 0) {
      enqueue(`[${nowIso()}] ${stderrLabel}: ${stderrBuffer}`);
      stderrBuffer = "";
    }

    await writeQueue;
  }

  return {
    onStdout: (chunk) => consume("stdout", chunk),
    onStderr: (chunk) => consume("stderr", chunk),
    flush,
    sawStdout: () => sawStdout,
    sawStderr: () => sawStderr,
  };
}

async function setTaskWaitingInput(rootDir, stateManager, taskName, reason, questions) {
  const waitingSince = nowIso();
  const normalizedQuestions = Array.isArray(questions) ? questions.filter(Boolean).slice(0, 8) : [];

  await stateManager.update((state) => {
    const current = getTaskByName(state, taskName);
    if (!current) {
      return;
    }
    current.status = TASK_STATUSES.WAITING_INPUT;
    current.waitingSince = waitingSince;
    current.blockedReason = reason;
    current.questions = normalizedQuestions;
    current.error = reason;
    current.leaseOwner = null;
    current.leaseExpiresAt = null;
    current.processPid = null;
  });

  await fs.writeFile(getTaskQuestionsPath(rootDir, taskName), formatQuestionsMarkdown(taskName, reason, normalizedQuestions), "utf8");
}

function buildAutoTaskCommand(taskFile, contextFiles, config) {
  const providerModel = getProviderModel(config);
  const modelArg = providerModel ? ` -m "${providerModel}"` : "";
  const attachedFiles = [taskFile, ...contextFiles];
  const fileArgs = attachedFiles.map((filePath) => ` -f "${escapeDoubleQuotes(filePath)}"`).join("");
  const hasContext = contextFiles.length > 0;
  const prompt =
    `Execute the task defined in ${taskFile} autonomously in the current repository. ` +
    "First read all attached files. " +
    (hasContext
      ? "Use the attached context files as the source of truth, even if TASK.md is minimal. "
      : "If TASK.md is minimal, inspect repository files before acting. ") +
    "Investigate all relevant code paths and data sources before asking questions. " +
    "Implement changes, run validations, and summarize results.";

  return `opencode run${modelArg}${fileArgs} -- "${escapeDoubleQuotes(prompt)}"`;
}

function buildAutoReviewCommand(taskFile, contextFiles, config) {
  const providerModel = getReviewProviderModel(config);
  const modelArg = providerModel ? ` -m "${providerModel}"` : "";
  const attachedFiles = [taskFile, ...contextFiles];
  const fileArgs = attachedFiles.map((filePath) => ` -f "${escapeDoubleQuotes(filePath)}"`).join("");
  const hasContext = contextFiles.length > 0;
  const prompt =
    `Review the implementation for the task defined in ${taskFile} in the current repository. ` +
    "First read all attached files. " +
    (hasContext
      ? "Use the attached context files as the source of truth for requirements and prior feedback. "
      : "Inspect the repository carefully before deciding. ") +
    "You are a reviewer only: do not edit files, do not commit, and do not change the workspace. " +
    "Verify every success criterion, inspect the changed code, and run validation commands from TASK.md when useful. " +
    "Finish with these exact markers: REVIEW_VERDICT: PASS or FAIL, REVIEW_SUMMARY: <one sentence>, REVIEW_ISSUES: followed by bullet lines. " +
    "When the task passes, write '- none' under REVIEW_ISSUES.";

  return `opencode run${modelArg}${fileArgs} -- "${escapeDoubleQuotes(prompt)}"`;
}

function hasUserTaskInstructions(taskMarkdown) {
  if (!taskMarkdown) {
    return false;
  }

  const cleaned = taskMarkdown
    .replace(/<!--[^]*?-->/g, "")
    .replace(/^#.*$/gm, "")
    .trim();

  return cleaned.length > 0;
}

async function buildTaskCommand(template, rootDir, taskName, taskWorkspace, config) {
  const taskDir = getTaskDir(rootDir, taskName);
  const taskFile = path.join(taskDir, "TASK.md");
  const contextFiles = await listFilesRecursive(getTaskContextDir(rootDir, taskName), {
    maxFiles: 50,
    maxDepth: 8,
  });

  if (!template || template === DEFAULT_EXECUTOR_COMMAND_TEMPLATE || template === "__auto__") {
    const rawTaskMarkdown = await fs.readFile(taskFile, "utf8").catch(() => "");
    const taskHasInstructions = hasUserTaskInstructions(rawTaskMarkdown);

    if (!taskHasInstructions && contextFiles.length === 0) {
      throw new WaitingInputRequiredError(
        `Task '${taskName}' needs more context before execution.`,
        [
          "Please describe the task goal in TASK.md (Descripcion/Criterios de exito).",
          "Add supporting files in context/ (spec, screenshots, examples).",
        ]
      );
    }

    return buildAutoTaskCommand(taskFile, contextFiles, config);
  }

  return template
    .replaceAll("{taskName}", taskName)
    .replaceAll("{taskDir}", taskDir)
    .replaceAll("{taskFile}", taskFile)
    .replaceAll("{workspace}", taskWorkspace)
    .replaceAll("{providerModel}", getProviderModel(config) || "");
}

async function buildReviewCommand(template, rootDir, taskName, taskWorkspace, config) {
  const taskDir = getTaskDir(rootDir, taskName);
  const taskFile = path.join(taskDir, "TASK.md");
  const contextFiles = await listFilesRecursive(getTaskContextDir(rootDir, taskName), {
    maxFiles: 50,
    maxDepth: 8,
  });

  if (!template || template === DEFAULT_EXECUTOR_COMMAND_TEMPLATE || template === "__auto__") {
    return buildAutoReviewCommand(taskFile, contextFiles, config);
  }

  return template
    .replaceAll("{taskName}", taskName)
    .replaceAll("{taskDir}", taskDir)
    .replaceAll("{taskFile}", taskFile)
    .replaceAll("{workspace}", taskWorkspace)
    .replaceAll("{providerModel}", getProviderModel(config) || "")
    .replaceAll("{reviewProviderModel}", getReviewProviderModel(config) || "");
}

function parseReviewIssues(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const startIndex = lines.findIndex((line) => /^REVIEW_ISSUES:/i.test(line.trim()));
  if (startIndex === -1) {
    return [];
  }

  const issues = [];
  const firstLine = lines[startIndex].replace(/^REVIEW_ISSUES:/i, "").trim();
  if (firstLine && !/^none$/i.test(firstLine)) {
    issues.push(firstLine.replace(/^-\s*/, "").trim());
  }

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      if (issues.length > 0) {
        break;
      }
      continue;
    }

    if (/^[A-Z_]+:/.test(trimmed)) {
      break;
    }

    if (/^-\s*/.test(trimmed)) {
      const issue = trimmed.replace(/^-\s*/, "").trim();
      if (issue && !/^none$/i.test(issue)) {
        issues.push(issue);
      }
      continue;
    }

    if (issues.length > 0) {
      break;
    }
  }

  return issues.slice(0, 12);
}

function parseReviewResult({ stdout, stderr, result, autoMode }) {
  const combined = stripAnsi(`${stdout || ""}\n${stderr || ""}`);
  const verdictMatch = combined.match(/REVIEW_VERDICT:\s*(PASS|FAIL)/i);
  const summaryMatch = combined.match(/REVIEW_SUMMARY:\s*(.+)/i);
  const issues = parseReviewIssues(combined);
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : null;
  const summary = summaryMatch
    ? summaryMatch[1].trim()
    : verdict === "PASS"
      ? "Reviewer approved the implementation."
      : verdict === "FAIL"
        ? "Reviewer rejected the implementation."
        : null;

  if (verdict) {
    return {
      parsed: true,
      verdict,
      passed: verdict === "PASS",
      summary,
      issues,
    };
  }

  if (!autoMode) {
    const passed = result.code === 0 && !result.timedOut;
    return {
      parsed: false,
      verdict: passed ? "PASS" : "FAIL",
      passed,
      summary: passed
        ? "Custom reviewer command completed successfully."
        : "Custom reviewer command failed.",
      issues,
    };
  }

  return {
    parsed: false,
    verdict: "FAIL",
    passed: false,
    summary: "Reviewer output was not parsable.",
    issues: issues.length > 0 ? issues : ["Missing REVIEW_VERDICT marker in reviewer output."],
  };
}

function formatReviewFeedbackMarkdown(taskName, review) {
  const lines = [
    `# Reviewer feedback for ${taskName}`,
    "",
    `Updated: ${nowIso()}`,
    "",
  ];

  for (const item of review.history || []) {
    lines.push(`## Attempt ${item.attempt}`);
    lines.push(`Verdict: ${item.verdict}`);
    lines.push(`Summary: ${item.summary}`);
    lines.push("Issues:");
    if ((item.issues || []).length === 0) {
      lines.push("- none");
    } else {
      for (const issue of item.issues) {
        lines.push(`- ${issue}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function updateRuntimeState(rootDir, patch) {
  const absolute = getAbsolutePaths(rootDir);
  const current = await readJson(absolute.runtimeState, {
    workerPid: process.pid,
    startedAt: nowIso(),
    lastHeartbeatAt: nowIso(),
    activeTasks: [],
    progress: {},
    stopReason: null,
  });

  const next = {
    ...current,
    ...patch,
    lastHeartbeatAt: nowIso(),
  };

  await writeJsonAtomic(absolute.runtimeState, next);
}

async function writeTaskCheckpoint(rootDir, taskName, payload) {
  const checkpointPath = getTaskCheckpointPath(rootDir, taskName);
  await writeJsonAtomic(checkpointPath, {
    taskName,
    updatedAt: nowIso(),
    ...payload,
  });
}

async function writeTaskResult(rootDir, taskName, payload) {
  const resultPath = getTaskResultPath(rootDir, taskName);
  await writeJsonAtomic(resultPath, {
    generatedAt: nowIso(),
    ...payload,
  });
}

function buildStrategies() {
  return [
    "conservative-fix",
    "alternative-implementation",
    "targeted-refactor",
    "fallback-minimal-change",
  ];
}

async function executeReview({
  rootDir,
  config,
  task,
  taskConfig,
  mergedTask,
  taskWorkspace,
  logPath,
  attemptNumber,
}) {
  if (mergedTask.reviewMode !== "agent") {
    return {
      enabled: false,
      passed: true,
      verdict: "SKIPPED",
      summary: "Review disabled for this task.",
      issues: [],
      reportPath: null,
    };
  }

  const template = taskConfig?.review?.commandTemplate || mergedTask.reviewCommandTemplate;
  const command = await buildReviewCommand(template, rootDir, task.name, taskWorkspace, config);
  const autoMode = !template || template === DEFAULT_EXECUTOR_COMMAND_TEMPLATE || template === "__auto__";
  const beforeSnapshot = await getGitStatusSnapshot(taskWorkspace);
  const streamLogger = createTaskStreamLogger(logPath, "review ");

  await appendLine(logPath, `[${nowIso()}] Running reviewer command: ${command}`);
  const result = await runCommand({
    command,
    cwd: taskWorkspace,
    unsetEnv: command.trim().startsWith("opencode run") ? OPENCODE_ENV_UNSET_KEYS : [],
    timeoutSec: mergedTask.timeoutSec,
    onStdout: streamLogger.onStdout,
    onStderr: streamLogger.onStderr,
  });
  await streamLogger.flush();

  const afterSnapshot = await getGitStatusSnapshot(taskWorkspace);
  const workspaceChanged = beforeSnapshot !== null && afterSnapshot !== null && beforeSnapshot !== afterSnapshot;
  const parsed = parseReviewResult({
    stdout: result.stdout,
    stderr: result.stderr,
    result,
    autoMode,
  });

  const issues = [...parsed.issues];
  if (workspaceChanged) {
    issues.push("Reviewer modified the workspace, but reviewer runs must be read-only.");
  }

  const passed = parsed.passed && !workspaceChanged && !result.timedOut && (autoMode || result.code === 0);
  const summary = workspaceChanged
    ? "Reviewer changed the workspace and the review was rejected."
    : result.timedOut
      ? "Reviewer timed out before producing a final verdict."
      : parsed.summary;
  const reviewResult = {
    enabled: true,
    passed,
    verdict: passed ? "PASS" : "FAIL",
    summary,
    issues,
    exitCode: result.code,
    timedOut: result.timedOut,
    command,
    workspaceChanged,
    reportPath: getTaskReviewResultPath(rootDir, task.name),
    history: [
      {
        attempt: attemptNumber,
        verdict: passed ? "PASS" : "FAIL",
        summary,
        issues,
      },
    ],
  };

  await writeJsonAtomic(reviewResult.reportPath, {
    taskName: task.name,
    generatedAt: nowIso(),
    attempt: attemptNumber,
    verdict: reviewResult.verdict,
    passed: reviewResult.passed,
    summary: reviewResult.summary,
    issues: reviewResult.issues,
    exitCode: result.code,
    timedOut: result.timedOut,
    workspaceChanged,
    command,
    stdout: stripAnsi(result.stdout || "").slice(0, 8000),
    stderr: stripAnsi(result.stderr || "").slice(0, 8000),
  });

  if (!passed) {
    const feedbackPath = getTaskReviewFeedbackPath(rootDir, task.name);
    await fs.writeFile(
      feedbackPath,
      formatReviewFeedbackMarkdown(task.name, {
        history: [reviewResult.history[0]],
      }),
      "utf8"
    );
  }

  return reviewResult;
}

async function executeTask({
  rootDir,
  config,
  stateManager,
  task,
  useWorktree,
  lockHandle,
  logger,
}) {
  const taskDir = getTaskDir(rootDir, task.name);
  const taskConfig = await readTaskConfig(rootDir, task.name);
  const mergedTask = mergeTaskWithConfig(task, taskConfig, config);

  const logPath = getTaskLogPath(rootDir, task.name);
  const strategies = buildStrategies();
  let worktreeInfo = null;
  let taskWorkspace = rootDir;

  if (useWorktree) {
      worktreeInfo = await createWorktree(rootDir, config, task.name, {
        branchName: mergedTask.branchName,
        baseBranch: mergedTask.baseBranch,
        useCurrentBranchAsBase: mergedTask.useCurrentBranchAsBase,
      });
    taskWorkspace = worktreeInfo.worktreePath;
  }

  const maxAttempts = Math.max(1, mergedTask.maxRetries + 1);
  const maxByBudget = Math.max(1, mergedTask.investigationBudget);
  const totalAttempts = Math.min(maxAttempts, maxByBudget);

  await appendLine(logPath, `[${nowIso()}] Starting task ${task.name} in ${taskWorkspace}`);

  try {
    for (let attemptNumber = 1; attemptNumber <= totalAttempts; attemptNumber += 1) {
      await refreshLock(lockHandle, config.lockTtlSec);

      const strategy = strategies[(attemptNumber - 1) % strategies.length];
      const investigation = await runInvestigation(rootDir, mergedTask, taskConfig, config);

      await stateManager.update((state) => {
        const current = getTaskByName(state, task.name);
        current.status = TASK_STATUSES.STARTED;
        current.startedAt = current.startedAt || nowIso();
        current.lastHeartbeatAt = nowIso();
        current.leaseOwner = `${process.pid}`;
        current.leaseExpiresAt = addSeconds(nowIso(), config.leaseTtlSec);
        current.investigationUsed = (current.investigationUsed || 0) + 1;
        current.researchSummary = investigation.summary;
        current.error = null;
        if (worktreeInfo) {
          current.branch = worktreeInfo.branch;
          current.worktree = worktreeInfo.worktreePath;
        }
      });

      await updateRuntimeState(rootDir, {
        activeTasks: [task.name],
        progress: {
          [task.name]: {
            attempt: attemptNumber,
            strategy,
            startedAt: nowIso(),
          },
        },
      });
      await writeTaskCheckpoint(rootDir, task.name, {
        attempt: attemptNumber,
        strategy,
        state: TASK_STATUSES.STARTED,
      });

      await appendLine(logPath, `[${nowIso()}] Attempt ${attemptNumber} using strategy ${strategy}`);
      await appendLine(logPath, `[${nowIso()}] Investigation summary: ${investigation.summary}`);
      if (investigation.dbCommandResult) {
        await appendLine(
          logPath,
          `[${nowIso()}] DB introspection command exit=${investigation.dbCommandResult.code}`
        );
      }

      const preHook = await runHookIfAllowed({
        rootDir,
        taskName: task.name,
        taskWorkspace,
        hookType: "pre",
        config,
      });

      if (!preHook.skipped && preHook.result.code !== 0) {
        await appendLine(logPath, `[${nowIso()}] pre-hook failed: ${preHook.result.stderr || preHook.result.stdout}`);
      }

      const template =
        taskConfig?.executor?.commandTemplate ||
        DEFAULT_EXECUTOR_COMMAND_TEMPLATE;
      let command;
      try {
        command = await buildTaskCommand(template, rootDir, task.name, taskWorkspace, config);
      } catch (error) {
        if (error && error.waitingInput) {
          await appendLine(logPath, `[${nowIso()}] Waiting input: ${error.message}`);
          await setTaskWaitingInput(rootDir, stateManager, task.name, error.message, error.questions);
          await writeTaskResult(rootDir, task.name, {
            status: TASK_STATUSES.WAITING_INPUT,
            exitCode: 0,
            durationSec: 0,
            artifacts: [path.relative(rootDir, logPath).replace(/\\/g, "/")],
            researchSummary: investigation.summary,
            sourcesChecked: [...(investigation.keywordHits || []), ...(investigation.dbSources || [])].slice(0, 25),
            strategy,
            blockedReason: error.message,
            questions: error.questions || [],
          });
          return getTaskByName(stateManager.state, task.name);
        }

        throw error;
      }
      const beforeSnapshot = command.trim().startsWith("opencode run")
        ? await getGitStatusSnapshot(taskWorkspace)
        : null;
      const isOpencodeCommand = command.trim().startsWith("opencode run");
      const configuredInactivityTimeout = Number(config.opencodeInactivityTimeoutSec);
      const inactivityTimeoutSec =
        isOpencodeCommand && Number.isFinite(configuredInactivityTimeout) && configuredInactivityTimeout > 0
          ? Math.max(30, configuredInactivityTimeout)
          : 0;
      const streamLogger = createTaskStreamLogger(logPath);

      await appendLine(logPath, `[${nowIso()}] Running command: ${command}`);
      if (inactivityTimeoutSec > 0) {
        await appendLine(
          logPath,
          `[${nowIso()}] Inactivity timeout: ${inactivityTimeoutSec}s (applies when there is no stdout/stderr output)`
        );
      }

      const attemptStartedAt = nowIso();
      let commandPid = null;
      const heartbeatLogEveryMs = Math.max(30, Number(config.heartbeatSec || 15) * 2) * 1000;
      let lastHeartbeatLogAt = Date.now();

      const heartbeatInterval = setInterval(async () => {
        try {
          await stateManager.update((state) => {
            const current = getTaskByName(state, task.name);
            current.lastHeartbeatAt = nowIso();
            current.leaseExpiresAt = addSeconds(nowIso(), config.leaseTtlSec);
          });
          await refreshLock(lockHandle, config.lockTtlSec);
          await updateRuntimeState(rootDir, {
            activeTasks: [task.name],
          });

          if (Date.now() - lastHeartbeatLogAt >= heartbeatLogEveryMs) {
            await appendLine(
              logPath,
              `[${nowIso()}] heartbeat: command still running (pid=${commandPid || "-"})`
            );
            lastHeartbeatLogAt = Date.now();
          }
        } catch {
          // heartbeat best effort
        }
      }, Math.max(5, config.heartbeatSec) * 1000);

      const result = await runCommand({
        command,
        cwd: taskWorkspace,
        unsetEnv: isOpencodeCommand ? OPENCODE_ENV_UNSET_KEYS : [],
        timeoutSec: mergedTask.timeoutSec,
        idleTimeoutSec: inactivityTimeoutSec,
        onStdout: streamLogger.onStdout,
        onStderr: streamLogger.onStderr,
        onSpawn: async (pid) => {
          commandPid = pid;
          await appendLine(logPath, `[${nowIso()}] Process started with PID ${pid}`);
          await stateManager.update((state) => {
            const current = getTaskByName(state, task.name);
            current.processPid = pid;
          });
        },
      });

      clearInterval(heartbeatInterval);
      await streamLogger.flush();

      const postHook = await runHookIfAllowed({
        rootDir,
        taskName: task.name,
        taskWorkspace,
        hookType: "post",
        config,
      });

      const cleanStdout = stripAnsi(result.stdout || "");
      const cleanStderr = stripAnsi(result.stderr || "");
      const hasOpencodeError = /(error:|exception|failed|not found|no payment method|providermodelnotfounderror)/i.test(
        cleanStderr
      );
      const hasCompletionSignal = /(task complete|result:|done\b|created\b|updated\b|wrote\b|no changes needed)/i.test(
        cleanStdout
      );
      const extractedQuestions = extractHumanInputQuestions(cleanStdout, cleanStderr);
      const afterSnapshot = isOpencodeCommand
        ? await getGitStatusSnapshot(taskWorkspace)
        : null;
      const changedWorkspaceDuringAttempt =
        beforeSnapshot !== null && afterSnapshot !== null && beforeSnapshot !== afterSnapshot;
      const softOpencodeSuccess =
        isOpencodeCommand &&
        (result.code !== 0 || result.timedOut) &&
        !hasOpencodeError &&
        (hasCompletionSignal || (result.timedOut && changedWorkspaceDuringAttempt));

      let waitingInputReason = null;
      let waitingInputQuestions = [];
      if (!softOpencodeSuccess && !hasOpencodeError) {
        if (extractedQuestions.length > 0) {
          waitingInputReason = "Task requires human clarification.";
          waitingInputQuestions = extractedQuestions;
        } else if (result.idleTimedOut && !changedWorkspaceDuringAttempt) {
          waitingInputReason =
            `Task was interrupted after ${inactivityTimeoutSec}s without output. ` +
            "Please provide more explicit instructions or use a deterministic custom executor.";
          waitingInputQuestions = [
            "Should this task run with a custom command in task.json instead of __auto__?",
            "Please provide concrete acceptance criteria and exact target files.",
          ];
        } else if (result.timedOut && !changedWorkspaceDuringAttempt) {
          waitingInputReason = "Task timed out without visible progress. More context may be required.";
          waitingInputQuestions = [
            "Please provide more specific acceptance criteria or concrete output expectations.",
            "Add additional examples/files in context/ to unblock execution.",
          ];
        }
      }

      const commandSuccess = (result.code === 0 && !result.timedOut) || softOpencodeSuccess;
      const hasResearchSummary = !config.requireResearchSummary || Boolean(investigation.summary);
      let reviewResult = null;
      if (commandSuccess && !waitingInputReason) {
        reviewResult = await executeReview({
          rootDir,
          config,
          task,
          taskConfig,
          mergedTask,
          taskWorkspace,
          logPath,
          attemptNumber,
        });

        if (reviewResult.enabled) {
          await appendLine(
            logPath,
            `[${nowIso()}] Review verdict: ${reviewResult.verdict} summary=${reviewResult.summary}`
          );
        }
      }

      const reviewPassed = !reviewResult || !reviewResult.enabled || reviewResult.passed;
      const success = commandSuccess && hasResearchSummary && !waitingInputReason && reviewPassed;

      await appendLine(
        logPath,
        `[${nowIso()}] Exit diagnostics: code=${result.code} timedOut=${result.timedOut} idleTimedOut=${result.idleTimedOut} softOpencodeSuccess=${softOpencodeSuccess} commandSuccess=${commandSuccess}`
      );

      if (waitingInputReason) {
        await appendLine(logPath, `[${nowIso()}] Waiting input reason: ${waitingInputReason}`);
      }
      const attemptRecord = {
        attempt: attemptNumber,
        startedAt: attemptStartedAt,
        finishedAt: nowIso(),
        exitCode: success ? 0 : (reviewResult && !reviewPassed ? 1 : result.code),
        error: success
          ? null
          : waitingInputReason || (reviewResult && !reviewPassed ? `Review failed: ${reviewResult.summary}` : null) || result.stderr || result.stdout || "Task command failed",
        sourcesChecked: [...(investigation.keywordHits || []), ...(investigation.dbSources || [])].slice(0, 25),
        strategy,
        logFile: path.relative(rootDir, logPath).replace(/\\/g, "/"),
        review: reviewResult && reviewResult.enabled
          ? {
              verdict: reviewResult.verdict,
              summary: reviewResult.summary,
              issues: reviewResult.issues,
              reportFile: path.relative(rootDir, reviewResult.reportPath).replace(/\\/g, "/"),
            }
          : null,
      };

      if (result.stdout?.trim() && !streamLogger.sawStdout()) {
        await appendLine(logPath, `[${nowIso()}] stdout:\n${result.stdout}`);
      }

      if (result.stderr?.trim() && !streamLogger.sawStderr()) {
        await appendLine(logPath, `[${nowIso()}] stderr:\n${result.stderr}`);
      }

      if (!postHook.skipped && postHook.result.code !== 0) {
        await appendLine(logPath, `[${nowIso()}] post-hook failed: ${postHook.result.stderr || postHook.result.stdout}`);
      }

      await stateManager.update((state) => {
        const current = getTaskByName(state, task.name);
        current.attempts = current.attempts || [];
        current.attempts.push(attemptRecord);
        current.processPid = null;

        if (success) {
          current.status = TASK_STATUSES.FINISHED;
          current.finishedAt = nowIso();
          current.error = null;
          current.waitingSince = null;
          current.blockedReason = null;
          current.questions = [];
          current.leaseOwner = null;
          current.leaseExpiresAt = null;
        } else if (waitingInputReason) {
          current.status = TASK_STATUSES.WAITING_INPUT;
          current.waitingSince = nowIso();
          current.blockedReason = waitingInputReason;
          current.questions = waitingInputQuestions;
          current.error = waitingInputReason;
          current.leaseOwner = null;
          current.leaseExpiresAt = null;
        } else {
          current.retries = (current.retries || 0) + 1;
          const outOfRetries = current.retries > current.maxRetries;
          const outOfBudget = (current.investigationUsed || 0) >= current.investigationBudget;
          if (outOfRetries || outOfBudget || attemptNumber >= totalAttempts) {
            current.status = TASK_STATUSES.ERROR;
            current.finishedAt = nowIso();
            current.error = attemptRecord.error;
            current.leaseOwner = null;
            current.leaseExpiresAt = null;
          } else {
            current.status = TASK_STATUSES.PENDING;
            current.error = attemptRecord.error;
          }
        }
      });

      await updateRuntimeState(rootDir, {
        activeTasks: [],
      });

      await writeTaskCheckpoint(rootDir, task.name, {
        attempt: attemptNumber,
        strategy,
        state: success
          ? TASK_STATUSES.FINISHED
          : waitingInputReason
            ? TASK_STATUSES.WAITING_INPUT
            : TASK_STATUSES.PENDING,
      });

      const currentTask = getTaskByName(stateManager.state, task.name);
      if (currentTask.status === TASK_STATUSES.FINISHED) {
        if (useWorktree && config.autoCommit) {
          const commitResult = await autoCommit(taskWorkspace, task.name);
          if (commitResult.code !== 0) {
            await logger.warn(`Auto-commit failed for ${task.name}: ${commitResult.stderr || commitResult.stdout}`);
          }

          if (config.autoPR) {
            const pr = await maybeCreatePr(taskWorkspace, config, worktreeInfo.branch, worktreeInfo.baseBranch);
            if (!pr.created) {
              await logger.warn(`Auto-PR not created for ${task.name}: ${pr.reason}`);
            }
          }
        }

        await writeTaskResult(rootDir, task.name, {
          status: TASK_STATUSES.FINISHED,
          exitCode: 0,
          durationSec: Math.max(
            0,
            Math.round((new Date(currentTask.finishedAt).getTime() - new Date(currentTask.startedAt).getTime()) / 1000)
          ),
          artifacts: [
            path.relative(rootDir, logPath).replace(/\\/g, "/"),
            ...(attemptRecord.review?.reportFile ? [attemptRecord.review.reportFile] : []),
          ],
          researchSummary: investigation.summary,
          sourcesChecked: attemptRecord.sourcesChecked,
          strategy,
          review: attemptRecord.review,
        });

        return currentTask;
      }

      if (currentTask.status === TASK_STATUSES.ERROR) {
        await writeTaskResult(rootDir, task.name, {
          status: TASK_STATUSES.ERROR,
          exitCode: attemptRecord.exitCode ?? 1,
          durationSec: Math.max(
            0,
            Math.round((new Date(attemptRecord.finishedAt).getTime() - new Date(attemptRecord.startedAt).getTime()) / 1000)
          ),
          artifacts: [
            path.relative(rootDir, logPath).replace(/\\/g, "/"),
            ...(attemptRecord.review?.reportFile ? [attemptRecord.review.reportFile] : []),
          ],
          researchSummary: investigation.summary,
          sourcesChecked: attemptRecord.sourcesChecked,
          strategy,
          error: currentTask.error,
          review: attemptRecord.review,
        });
        return currentTask;
      }

      if (currentTask.status === TASK_STATUSES.WAITING_INPUT) {
        await fs.writeFile(
          getTaskQuestionsPath(rootDir, task.name),
          formatQuestionsMarkdown(task.name, waitingInputReason || currentTask.blockedReason, waitingInputQuestions),
          "utf8"
        );

        await writeTaskResult(rootDir, task.name, {
          status: TASK_STATUSES.WAITING_INPUT,
          exitCode: 0,
          durationSec: Math.max(
            0,
            Math.round((new Date(attemptRecord.finishedAt).getTime() - new Date(attemptRecord.startedAt).getTime()) / 1000)
          ),
          artifacts: [path.relative(rootDir, logPath).replace(/\\/g, "/")],
          researchSummary: investigation.summary,
          sourcesChecked: attemptRecord.sourcesChecked,
          strategy,
          blockedReason: waitingInputReason || currentTask.blockedReason,
          questions: waitingInputQuestions,
        });

        return currentTask;
      }

      await sleep(250);
    }

    return getTaskByName(stateManager.state, task.name);
  } finally {
    if (useWorktree && worktreeInfo) {
      const shouldKeep =
        config.cleanupPolicy === "keep_on_changes" && (await hasWorktreeChanges(worktreeInfo.worktreePath));

      if (!shouldKeep) {
        const force = config.cleanupPolicy === "stash";
        try {
          if (force && config.cleanupPolicy === "stash") {
            await runCommand({ command: "git stash --include-untracked", cwd: worktreeInfo.worktreePath });
          }
          await removeWorktree(rootDir, worktreeInfo.worktreePath, force);
        } catch (error) {
          await logger.warn(`Worktree cleanup failed for ${task.name}: ${error.message}`);
        }
      }
    }
  }
}

async function bootstrap(rootDir) {
  await ensureBaseStructure(rootDir);
  const config = await loadConfig(rootDir);
  const state = await loadState(rootDir);
  await syncTaskFoldersToState(rootDir, state, config);
  await loadTaskConfigs(rootDir, state, config);
  await saveState(rootDir, state);
  return { config, state };
}

async function validateStateIntegrity(state) {
  const errors = [];
  const names = new Set();

  for (const task of state.tasks) {
    if (names.has(task.name)) {
      errors.push(`Duplicate task name: ${task.name}`);
    }

    const nameError = validateTaskName(task.name);
    if (nameError) {
      errors.push(`Invalid task name '${task.name}': ${nameError}`);
    }

    names.add(task.name);
  }

  errors.push(...buildDependencyErrors(state.tasks));

  const cycles = detectDependencyCycles(state.tasks);
  for (const cycle of cycles) {
    errors.push(`Dependency cycle detected: ${cycle}`);
  }

  return errors;
}

async function cmdTask(rootDir, taskName) {
  const nameError = validateTaskName(taskName);
  if (nameError) {
    throw new Error(nameError);
  }

  const { config, state } = await bootstrap(rootDir);
  await ensureTaskDirectory(rootDir, taskName);

  if (!getTaskByName(state, taskName)) {
    state.tasks.push(createTaskRecord(taskName, config));
    await saveState(rootDir, state);
    return `Task '${taskName}' created.`;
  }

  await saveState(rootDir, state);
  return `Task '${taskName}' already exists (idempotent).`;
}

async function cmdStatus(rootDir) {
  const { state } = await bootstrap(rootDir);
  const lines = [];
  const header = "Name\tStatus\tPriority\tBranch\tRetries\tLease\tLastError";
  lines.push(header);

  for (const task of sortTasks(state.tasks)) {
    lines.push(
      [
        task.name,
        task.status,
        `${task.priority}`,
        task.branch || "-",
        `${task.retries || 0}/${task.maxRetries || 0}`,
        task.leaseExpiresAt || "-",
        (task.error || "-").replace(/\s+/g, " ").slice(0, 80),
      ].join("\t")
    );
  }

  return lines.join("\n");
}

async function cmdLogs(rootDir, taskName) {
  const logPath = getTaskLogPath(rootDir, taskName);
  if (!(await pathExists(logPath))) {
    throw new Error(`No log found for task '${taskName}'.`);
  }

  return fs.readFile(logPath, "utf8");
}

async function cmdQuestions(rootDir, taskName = null) {
  const { state } = await bootstrap(rootDir);

  if (taskName) {
    const task = getTaskByName(state, taskName);
    if (!task) {
      throw new Error(`Task '${taskName}' not found.`);
    }

    if (task.status !== TASK_STATUSES.WAITING_INPUT) {
      return `Task '${taskName}' is not waiting for input.`;
    }

    const questions = (task.questions || []).length > 0
      ? task.questions
      : ["Please add additional context or answer in context/answers.md."];

    return [
      `Task: ${taskName}`,
      `Status: ${task.status}`,
      `Reason: ${task.blockedReason || task.error || "-"}`,
      "Questions:",
      ...questions.map((question) => `- ${question}`),
      "",
      `Answer with: /slave-answer ${taskName} \"your answer\"`,
    ].join("\n");
  }

  const waitingTasks = sortTasks(state.tasks).filter((task) => task.status === TASK_STATUSES.WAITING_INPUT);
  if (waitingTasks.length === 0) {
    return "No tasks waiting for input.";
  }

  const lines = ["Tasks waiting for input:"];
  for (const task of waitingTasks) {
    lines.push(`- ${task.name}: ${(task.blockedReason || task.error || "-").replace(/\s+/g, " ").slice(0, 120)}`);
  }
  lines.push("", "Use /slave-questions {name} to see full questions.");
  return lines.join("\n");
}

async function cmdAnswer(rootDir, taskName, answerText) {
  const { state } = await bootstrap(rootDir);
  const task = getTaskByName(state, taskName);
  if (!task) {
    throw new Error(`Task '${taskName}' not found.`);
  }

  if (!answerText || !answerText.trim()) {
    throw new Error("Usage: slave-answer {name} \"your answer\"");
  }

  const answersPath = getTaskAnswersPath(rootDir, taskName);
  const entry = [
    `## ${nowIso()}`,
    answerText.trim(),
    "",
  ].join("\n");
  await appendLine(answersPath, entry);

  task.status = TASK_STATUSES.PENDING;
  task.error = null;
  task.waitingSince = null;
  task.blockedReason = null;
  task.questions = [];
  task.leaseOwner = null;
  task.leaseExpiresAt = null;
  task.processPid = null;
  await saveState(rootDir, state);

  const questionsPath = getTaskQuestionsPath(rootDir, taskName);
  if (await pathExists(questionsPath)) {
    await fs.rm(questionsPath, { force: true });
  }

  return `Answer stored for '${taskName}'. Task moved to pending.`;
}

async function cmdReset(rootDir, taskName) {
  const { state } = await bootstrap(rootDir);
  const task = getTaskByName(state, taskName);
  if (!task) {
    throw new Error(`Task '${taskName}' not found.`);
  }

  Object.assign(task, {
    status: TASK_STATUSES.PENDING,
    startedAt: null,
    finishedAt: null,
    lastHeartbeatAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    retries: 0,
    processPid: null,
    waitingSince: null,
    blockedReason: null,
    questions: [],
    error: null,
    attempts: [],
    researchSummary: null,
    investigationUsed: 0,
  });

  await saveState(rootDir, state);

  const logPath = getTaskLogPath(rootDir, taskName);
  if (await pathExists(logPath)) {
    await fs.writeFile(logPath, "", "utf8");
  }

  const questionsPath = getTaskQuestionsPath(rootDir, taskName);
  if (await pathExists(questionsPath)) {
    await fs.rm(questionsPath, { force: true });
  }

  const reviewFeedbackPath = getTaskReviewFeedbackPath(rootDir, taskName);
  if (await pathExists(reviewFeedbackPath)) {
    await fs.rm(reviewFeedbackPath, { force: true });
  }

  const reviewResultPath = getTaskReviewResultPath(rootDir, taskName);
  if (await pathExists(reviewResultPath)) {
    await fs.rm(reviewResultPath, { force: true });
  }

  return `Task '${taskName}' reset to pending.`;
}

async function cmdCancel(rootDir, taskName) {
  const { state } = await bootstrap(rootDir);
  const task = getTaskByName(state, taskName);
  if (!task) {
    throw new Error(`Task '${taskName}' not found.`);
  }

  if (task.processPid) {
    try {
      process.kill(task.processPid);
    } catch {
      // best effort
    }
  }

  task.status = TASK_STATUSES.CANCELLED;
  task.finishedAt = nowIso();
  task.waitingSince = null;
  task.blockedReason = null;
  task.questions = [];
  task.leaseOwner = null;
  task.leaseExpiresAt = null;
  task.processPid = null;
  await saveState(rootDir, state);

  return `Task '${taskName}' cancelled.`;
}

async function cmdConfig(rootDir, options = {}) {
  await ensureBaseStructure(rootDir);
  const config = await loadConfig(rootDir);
  let normalizationNote = null;

  function normalizeProviderModel(provider, model) {
    if (!provider || !model) {
      return { provider, model, note: null };
    }

    const lowProvider = provider.toLowerCase();
    const lowModel = model.toLowerCase();
    if (lowProvider === "openai" && (lowModel === "gpt-5.3-codex" || lowModel === "gpt-5.3-codex-spark")) {
      return {
        provider: "opencode",
        model,
        note: `Model '${provider}/${model}' is normalized to 'opencode/${model}' for this OpenCode CLI.`,
      };
    }

    return { provider, model, note: null };
  }

  if (options.clearModel) {
    config.opencodeProvider = null;
    config.opencodeModel = null;
    await saveConfig(rootDir, config);
    return "Slave config updated. Model selection cleared (uses OpenCode default).";
  }

  const hasProvider = typeof options.provider === "string" && options.provider.trim().length > 0;
  const hasModel = typeof options.model === "string" && options.model.trim().length > 0;

  if (hasProvider || hasModel) {
    if (hasModel && options.model.includes("/") && !hasProvider) {
      const [provider, model] = options.model.split("/", 2);
      const normalized = normalizeProviderModel(provider || null, model || null);
      config.opencodeProvider = normalized.provider;
      config.opencodeModel = normalized.model;
      normalizationNote = normalized.note;
    } else {
      if (hasProvider) {
        config.opencodeProvider = options.provider.trim();
      }
      if (hasModel) {
        config.opencodeModel = options.model.trim();
      }

      const normalized = normalizeProviderModel(config.opencodeProvider, config.opencodeModel);
      config.opencodeProvider = normalized.provider;
      config.opencodeModel = normalized.model;
      normalizationNote = normalized.note;
    }

    await saveConfig(rootDir, config);
  }

  const providerModel = getProviderModel(config);
  if (!providerModel) {
    return [
      "Current slave config:",
      "- Model: OpenCode default (no override)",
      "",
      "Usage:",
      "- /slave-config --model opencode/gpt-5.3-codex",
      "- /slave-config --provider opencode --model gpt-5.3-codex",
      "- /slave-config --clear-model",
    ].join("\n");
  }

  const lines = [
    "Current slave config:",
    `- Model override: ${providerModel}`,
    "",
    "Usage:",
    "- /slave-config --model opencode/gpt-5.3-codex",
    "- /slave-config --provider opencode --model gpt-5.3-codex",
    "- /slave-config --clear-model",
  ];

  if (normalizationNote) {
    lines.splice(2, 0, normalizationNote, "");
  }

  return lines.join("\n");
}

async function cmdValidate(rootDir) {
  const { state } = await bootstrap(rootDir);
  const errors = await validateStateIntegrity(state);

  if (errors.length === 0) {
    return "Validation passed.";
  }

  return `Validation failed:\n- ${errors.join("\n- ")}`;
}

async function cmdResume(rootDir) {
  const { state, config } = await bootstrap(rootDir);
  let recovered = 0;

  for (const task of state.tasks) {
    const leaseExpired = task.status === TASK_STATUSES.STARTED && isExpired(task.leaseExpiresAt);
    const hasPid = Boolean(task.processPid);
    const pidDead = hasPid && !isProcessAlive(task.processPid);
    const staleHeartbeatDeadline = addSeconds(
      task.lastHeartbeatAt || task.startedAt || nowIso(),
      Math.max(config.leaseTtlSec * 2, config.heartbeatSec * 4)
    );
    const heartbeatStale = task.status === TASK_STATUSES.STARTED && isExpired(staleHeartbeatDeadline);

    if (task.status === TASK_STATUSES.STARTED && (leaseExpired || pidDead || heartbeatStale)) {
      let recoveryReason = "Recovered from expired lease";
      if (pidDead) {
        recoveryReason = "Recovered from dead process";
      } else if (heartbeatStale) {
        recoveryReason = "Recovered from stale heartbeat";
      }

      if ((task.retries || 0) <= (task.maxRetries || 0)) {
        task.status = TASK_STATUSES.PENDING;
        task.error = recoveryReason;
      } else {
        task.status = TASK_STATUSES.ERROR;
        task.error = `${recoveryReason}; retries exhausted`;
      }
      task.leaseOwner = null;
      task.leaseExpiresAt = null;
      task.processPid = null;
      recovered += 1;
    }
  }

  await saveState(rootDir, state);
  return `Resume completed. Recovered tasks: ${recovered}.`;
}

async function cmdPruneWorktrees(rootDir) {
  const git = await isGitRepo(rootDir);
  if (!git) {
    throw new Error("Current directory is not a git repository.");
  }

  const result = await pruneWorktrees(rootDir);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Unable to prune worktrees.");
  }

  return "Worktrees pruned.";
}

async function cmdCleanFinished(rootDir, options = {}) {
  const { state } = await bootstrap(rootDir);
  const includeErrors = Boolean(options.includeErrors);
  const removableStatuses = new Set([
    TASK_STATUSES.FINISHED,
    TASK_STATUSES.CANCELLED,
    ...(includeErrors ? [TASK_STATUSES.ERROR] : []),
  ]);

  const toRemove = state.tasks.filter((task) => removableStatuses.has(task.status));
  const remaining = state.tasks.filter((task) => !removableStatuses.has(task.status));

  for (const task of toRemove) {
    const taskDir = getTaskDir(rootDir, task.name);
    if (await pathExists(taskDir)) {
      await fs.rm(taskDir, { recursive: true, force: true });
    }

    const checkpointPath = getTaskCheckpointPath(rootDir, task.name);
    if (await pathExists(checkpointPath)) {
      await fs.rm(checkpointPath, { force: true });
    }
  }

  state.tasks = remaining;
  await saveState(rootDir, state);

  return `Cleanup completed. Removed tasks: ${toRemove.length}. Remaining tasks: ${remaining.length}.`;
}

function buildDryRun(state) {
  const sorted = sortTasks(state.tasks);
  const lines = ["Dry run plan:"];

  for (const task of sorted) {
    const blocked = dependenciesFinished(task, state) ? "ready" : `blocked by ${task.dependsOn.join(",")}`;
    const mode = task.runInWorktree ? "worktree" : "current";
    const branchTarget = task.runInWorktree ? task.branchName || "(auto by branchPrefix + taskName)" : "-";
    const baseTarget = task.runInWorktree
      ? (task.useCurrentBranchAsBase ? "(current branch)" : task.baseBranch || "(global baseBranch)")
      : "-";
    lines.push(
      `- ${task.name}: ${task.status} (${blocked}, mode=${mode}, branch=${branchTarget}, base=${baseTarget}, review=${task.reviewMode || "none"})`
    );
  }

  return lines.join("\n");
}

async function runScheduler(rootDir, config, state, options) {
  const absolute = getAbsolutePaths(rootDir);
  const logger = createLogger(rootDir);
  const stateManager = createStateManager(rootDir, state);
  const schedulerStartedAtMs = Date.now();

  const exceededMaxRunHours = () => {
    if (!config.maxRunHours || config.maxRunHours <= 0) {
      return false;
    }

    const elapsedMs = Date.now() - schedulerStartedAtMs;
    return elapsedMs > config.maxRunHours * 3600 * 1000;
  };

  let stopReason = "finished";

  const lockHandle = await acquireLock(absolute.lockFile, config.lockTtlSec, 12000);
  try {
    await logger.info(`Scheduler started. parallel=${options.parallel} background=${options.background}`);
    await updateRuntimeState(rootDir, {
      workerPid: process.pid,
      stopReason: null,
    });

    const integrityErrors = await validateStateIntegrity(state);
    if (integrityErrors.length > 0) {
      throw new Error(`State validation failed:\n- ${integrityErrors.join("\n- ")}`);
    }

    if (options.dryRun) {
      return buildDryRun(state);
    }

      const runOneTask = async (taskName, useWorktree) => {
      const task = getTaskByName(state, taskName);
      if (!task) {
        return null;
      }

      try {
        return await executeTask({
          rootDir,
          config,
          stateManager,
          task,
          useWorktree,
          lockHandle,
          logger,
        });
      } catch (error) {
        await logger.error(`Task '${taskName}' crashed: ${error.message}`);
        await stateManager.update((nextState) => {
          const current = getTaskByName(nextState, taskName);
          if (!current) {
            return;
          }
          current.status = TASK_STATUSES.ERROR;
          current.error = error.message;
          current.finishedAt = nowIso();
          current.leaseOwner = null;
          current.leaseExpiresAt = null;
          current.processPid = null;
        });
        await writeTaskResult(rootDir, taskName, {
          status: TASK_STATUSES.ERROR,
          exitCode: 1,
          durationSec: 0,
          artifacts: [],
          error: error.message,
        });
        return getTaskByName(stateManager.state, taskName);
      }
    };

    if (options.singleTaskName) {
      const task = getTaskByName(state, options.singleTaskName);
      if (!task) {
        throw new Error(`Task '${options.singleTaskName}' not found.`);
      }

      await runOneTask(task.name, shouldUseWorktreeForTask(task, options));
      return `Task '${task.name}' finished with status ${task.status}.`;
    }

    if (!options.parallel) {
      let progressed = true;
      while (progressed) {
        if (exceededMaxRunHours()) {
          stopReason = "maxRunHours reached";
          await logger.warn("Scheduler reached maxRunHours and stopped.");
          break;
        }

        progressed = false;
        const candidates = sortTasks(
          state.tasks.filter(
            (task) => task.status === TASK_STATUSES.PENDING && dependenciesFinished(task, state)
          )
        );

        for (const task of candidates) {
          progressed = true;
          await runOneTask(task.name, shouldUseWorktreeForTask(task, options));
        }
      }

      return "Sequential run completed.";
    }

    const running = new Map();
    while (true) {
      if (exceededMaxRunHours()) {
        stopReason = "maxRunHours reached";
        await logger.warn("Scheduler reached maxRunHours and stopped.");
        break;
      }

      const eligible = sortTasks(
        state.tasks.filter(
          (task) =>
            task.status === TASK_STATUSES.PENDING &&
            dependenciesFinished(task, state) &&
            !running.has(task.name)
        )
      );

      while (running.size < config.maxParallel && eligible.length > 0) {
        const next = eligible.shift();
        const promise = runOneTask(next.name, shouldUseWorktreeForTask(next, options)).finally(() => {
            running.delete(next.name);
          });
        running.set(next.name, promise);
      }

      if (running.size === 0) {
        break;
      }

      await Promise.race([...running.values()]);
      await refreshLock(lockHandle, config.lockTtlSec);
    }

    return "Parallel run completed.";
  } finally {
    await updateRuntimeState(rootDir, {
      activeTasks: [],
      stopReason,
    });
    await releaseLock(lockHandle);
  }
}

function parseBackgroundArgs(options) {
  const workerEntrypoint = path.resolve(__dirname, "cli.js");
  const args = [workerEntrypoint, "__worker"];
  if (options.parallel) {
    args.push("--parallel");
  }
  if (options.singleTaskName) {
    args.push("--worktree", options.singleTaskName);
  }
  return args;
}

async function cmdStart(rootDir, options = {}) {
  const { config, state } = await bootstrap(rootDir);
  const absolute = getAbsolutePaths(rootDir);
  const hasPendingPerTaskWorktree = state.tasks.some(
    (task) => task.status === TASK_STATUSES.PENDING && task.runInWorktree
  );

  if (options.parallel || options.singleTaskName || hasPendingPerTaskWorktree) {
    const git = await isGitRepo(rootDir);
    if (!git) {
      throw new Error("Parallel/worktree mode requires a git repository.");
    }
  }

  if (options.background && !options.internalWorker) {
    await ensureBaseStructure(rootDir);

    const child = spawn(process.execPath, parseBackgroundArgs(options), {
      cwd: rootDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    await fs.writeFile(absolute.workerPid, `${child.pid}\n`, "utf8");
    await updateRuntimeState(rootDir, {
      workerPid: child.pid,
      activeTasks: [],
      stopReason: null,
    });

    return `Background worker started with PID ${child.pid}.`;
  }

  return runScheduler(rootDir, config, state, options);
}

module.exports = {
  cmdTask,
  cmdStatus,
  cmdLogs,
  cmdQuestions,
  cmdAnswer,
  cmdReset,
  cmdCancel,
  cmdConfig,
  cmdValidate,
  cmdResume,
  cmdPruneWorktrees,
  cmdCleanFinished,
  cmdStart,
};
