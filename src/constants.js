const path = require("path");

const SCHEMA_VERSION = 1;

const DEFAULT_EXECUTOR_COMMAND_TEMPLATE = "__auto__";

const OPENCODE_ENV_UNSET_KEYS = [
  "OPENCODE",
  "OPENCODE_CLIENT",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_URL",
  "OPENCODE_SESSION",
];

const TASK_STATUSES = {
  PENDING: "pending",
  STARTED: "started",
  WAITING_INPUT: "waiting_input",
  FINISHED: "finished",
  ERROR: "error",
  CANCELLED: "cancelled",
};

const DEFAULT_CONFIG = {
  schemaVersion: SCHEMA_VERSION,
  baseBranch: "main",
  autonomyMode: "high",
  reviewMode: "none",
  maxParallel: 2,
  defaultMaxRetries: 3,
  defaultInvestigationBudget: 8,
  requireResearchSummary: true,
  dbIntrospectionMode: "auto",
  dbIntrospectionCommand: null,
  maxRunHours: 8,
  defaultTimeoutSec: 1800,
  opencodeInactivityTimeoutSec: 300,
  heartbeatSec: 15,
  leaseTtlSec: 60,
  lockTtlSec: 120,
  worktreeBasePath: "../",
  branchPrefix: "slave/",
  autoCommit: false,
  autoPR: false,
  opencodeProvider: "opencode",
  opencodeModel: "gpt-5.3-codex",
  prProvider: "github",
  gitStrategy: "rebase",
  cleanupPolicy: "keep_on_changes",
  securityMode: "untrusted",
  logLevel: "info",
  maxLogSizeMb: 5,
  storeRawLogs: false,
};

const PATHS = {
  SLAVE_DIR: ".opencode-slave",
  CONFIG_JSON: path.join(".opencode-slave", "config.json"),
  TASKS_JSON: path.join(".opencode-slave", "tasks.json"),
  LOCK_FILE: path.join(".opencode-slave", "tasks.lock"),
  LOGS_DIR: path.join(".opencode-slave", "logs"),
  SCHEDULER_LOG: path.join(".opencode-slave", "logs", "scheduler.log"),
  TASKS_DIR: path.join(".opencode-slave", "tasks"),
  RUNTIME_DIR: path.join(".opencode-slave", "runtime"),
  RUNTIME_STATE: path.join(".opencode-slave", "runtime", "worker.state.json"),
  WORKER_PID: path.join(".opencode-slave", "runtime", "worker.pid"),
};

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_EXECUTOR_COMMAND_TEMPLATE,
  OPENCODE_ENV_UNSET_KEYS,
  TASK_STATUSES,
  DEFAULT_CONFIG,
  PATHS,
};
