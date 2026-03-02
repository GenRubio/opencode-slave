const fs = require("fs/promises");
const path = require("path");
const {
  DEFAULT_CONFIG,
  DEFAULT_EXECUTOR_COMMAND_TEMPLATE,
  PATHS,
  SCHEMA_VERSION,
  TASK_STATUSES,
} = require("./constants");
const { ensureDir, listSubdirectories, pathExists, readJson, writeJsonAtomic } = require("./utils/fs");
const { nowIso } = require("./utils/time");

function getAbsolutePaths(rootDir) {
  return {
    slaveDir: path.join(rootDir, PATHS.SLAVE_DIR),
    configJson: path.join(rootDir, PATHS.CONFIG_JSON),
    tasksJson: path.join(rootDir, PATHS.TASKS_JSON),
    lockFile: path.join(rootDir, PATHS.LOCK_FILE),
    logsDir: path.join(rootDir, PATHS.LOGS_DIR),
    schedulerLog: path.join(rootDir, PATHS.SCHEDULER_LOG),
    tasksDir: path.join(rootDir, PATHS.TASKS_DIR),
    runtimeDir: path.join(rootDir, PATHS.RUNTIME_DIR),
    runtimeState: path.join(rootDir, PATHS.RUNTIME_STATE),
    workerPid: path.join(rootDir, PATHS.WORKER_PID),
    templatesDir: path.join(rootDir, PATHS.SLAVE_DIR, "templates"),
    prTemplate: path.join(rootDir, PATHS.SLAVE_DIR, "templates", "pr.md"),
  };
}

function createTaskRecord(taskName, config) {
  return {
    name: taskName,
    status: TASK_STATUSES.PENDING,
    priority: 100,
    dependsOn: [],
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    lastHeartbeatAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    retries: 0,
    maxRetries: config.defaultMaxRetries,
    investigationBudget: config.defaultInvestigationBudget,
    investigationUsed: 0,
    researchSummary: null,
    timeoutSec: config.defaultTimeoutSec,
    runInWorktree: false,
    branchName: null,
    baseBranch: null,
    branch: null,
    worktree: null,
    processPid: null,
    waitingSince: null,
    blockedReason: null,
    questions: [],
    error: null,
    tags: [],
    attempts: [],
  };
}

async function ensureBaseStructure(rootDir) {
  const absolute = getAbsolutePaths(rootDir);

  await ensureDir(absolute.slaveDir);
  await ensureDir(absolute.logsDir);
  await ensureDir(absolute.tasksDir);
  await ensureDir(absolute.runtimeDir);
  await ensureDir(path.join(absolute.runtimeDir, "checkpoints"));
  await ensureDir(absolute.templatesDir);

  const slaveGitignore = path.join(absolute.slaveDir, ".gitignore");
  const hasSlaveGitignore = await pathExists(slaveGitignore);
  if (!hasSlaveGitignore) {
    await fs.writeFile(slaveGitignore, "*\n!.gitignore\n", "utf8");
  }

  const hasConfig = await pathExists(absolute.configJson);
  if (!hasConfig) {
    await writeJsonAtomic(absolute.configJson, DEFAULT_CONFIG);
  }

  const hasTasks = await pathExists(absolute.tasksJson);
  if (!hasTasks) {
    await writeJsonAtomic(absolute.tasksJson, {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: nowIso(),
      tasks: [],
    });
  }

  const hasTemplate = await pathExists(absolute.prTemplate);
  if (!hasTemplate) {
    const body = [
      "## Summary",
      "- Task completed by opencode-slave",
      "",
      "## Validation",
      "- [ ] Tests passed",
      "- [ ] Manual verification done",
      "",
    ].join("\n");
    await fs.writeFile(absolute.prTemplate, body, "utf8");
  }

  return absolute;
}

function mergeConfig(rawConfig) {
  return {
    ...DEFAULT_CONFIG,
    ...(rawConfig || {}),
  };
}

async function loadConfig(rootDir) {
  const absolute = getAbsolutePaths(rootDir);
  const rawConfig = await readJson(absolute.configJson, {});
  return mergeConfig(rawConfig);
}

async function saveConfig(rootDir, config) {
  const absolute = getAbsolutePaths(rootDir);
  await writeJsonAtomic(absolute.configJson, {
    ...DEFAULT_CONFIG,
    ...config,
  });
}

async function loadState(rootDir) {
  const absolute = getAbsolutePaths(rootDir);
  const state = await readJson(absolute.tasksJson, {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: nowIso(),
    tasks: [],
  });

  if (!Array.isArray(state.tasks)) {
    state.tasks = [];
  }

  if (!state.schemaVersion) {
    state.schemaVersion = SCHEMA_VERSION;
  }

  return state;
}

async function saveState(rootDir, state) {
  const absolute = getAbsolutePaths(rootDir);
  const payload = {
    ...state,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: nowIso(),
  };
  await writeJsonAtomic(absolute.tasksJson, payload);
}

async function ensureTaskDirectory(rootDir, taskName) {
  const absolute = getAbsolutePaths(rootDir);
  const taskDir = path.join(absolute.tasksDir, taskName);
  await ensureDir(taskDir);
  await ensureDir(path.join(taskDir, "context"));
  await ensureDir(path.join(taskDir, "output"));
  await ensureDir(path.join(taskDir, "logs"));

  const taskFile = path.join(taskDir, "TASK.md");
  if (!(await pathExists(taskFile))) {
    const template = [
      `# Task: ${taskName}`,
      "",
      "## Descripcion",
      "<!-- Que debe hacer el agente -->",
      "",
      "## Contexto",
      "<!-- Archivos relevantes y decisiones previas -->",
      "",
      "## Fuentes obligatorias de investigacion",
      "<!-- Tablas DB, rutas del codigo, logs, docs internas, PRs previos -->",
      "",
      "## Criterios de exito",
      "<!-- Condiciones concretas para marcar finished -->",
      "",
      "## Comandos de verificacion",
      "<!-- Pruebas, build, lint, etc -->",
      "",
      "## Limites de escalado humano",
      "<!-- Cuando SI puede preguntar y cuando NO -->",
      "",
    ].join("\n");
    await fs.writeFile(taskFile, template, "utf8");
  }

  const taskConfigFile = path.join(taskDir, "task.json");
  if (!(await pathExists(taskConfigFile))) {
    await writeJsonAtomic(taskConfigFile, {
      priority: 100,
      dependsOn: [],
      maxRetries: 3,
      timeoutSec: 1800,
      runInWorktree: false,
      branchName: null,
      baseBranch: null,
      investigationBudget: 8,
      requireDbIntrospection: "auto",
      tags: [],
      executor: {
        commandTemplate: DEFAULT_EXECUTOR_COMMAND_TEMPLATE,
      },
    });
  }

  return taskDir;
}

async function readTaskConfig(rootDir, taskName) {
  const absolute = getAbsolutePaths(rootDir);
  const taskConfigFile = path.join(absolute.tasksDir, taskName, "task.json");
  const taskConfig = await readJson(taskConfigFile, {});

  const currentTemplate = taskConfig?.executor?.commandTemplate;
  if (
    typeof currentTemplate === "string" &&
    (
      currentTemplate.includes("opencode run --task-file") ||
      currentTemplate.includes("opencode run -f") ||
      currentTemplate.includes("Execute the task defined in {taskFile}")
    )
  ) {
    taskConfig.executor = {
      ...(taskConfig.executor || {}),
      commandTemplate: DEFAULT_EXECUTOR_COMMAND_TEMPLATE,
    };
    await writeJsonAtomic(taskConfigFile, taskConfig);
  }

  return taskConfig;
}

async function syncTaskFoldersToState(rootDir, state, config) {
  const absolute = getAbsolutePaths(rootDir);
  const taskNames = await listSubdirectories(absolute.tasksDir);
  const known = new Set(state.tasks.map((task) => task.name));

  for (const taskName of taskNames) {
    if (!known.has(taskName)) {
      state.tasks.push(createTaskRecord(taskName, config));
      known.add(taskName);
    }
  }

  return state;
}

module.exports = {
  getAbsolutePaths,
  createTaskRecord,
  ensureBaseStructure,
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  ensureTaskDirectory,
  readTaskConfig,
  syncTaskFoldersToState,
};
