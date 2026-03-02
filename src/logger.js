const path = require("path");
const { PATHS } = require("./constants");
const { appendLine } = require("./utils/fs");
const { nowIso } = require("./utils/time");

function redactSecrets(input) {
  if (!input) {
    return "";
  }

  return input
    .replace(/(api[_-]?key\s*[=:]\s*)([^\s"']+)/gi, "$1[REDACTED]")
    .replace(/(token\s*[=:]\s*)([^\s"']+)/gi, "$1[REDACTED]")
    .replace(/(password\s*[=:]\s*)([^\s"']+)/gi, "$1[REDACTED]")
    .replace(/(ghp_[a-zA-Z0-9]+)/g, "[REDACTED_GH_TOKEN]");
}

function createLogger(rootDir) {
  const schedulerLog = path.join(rootDir, PATHS.SCHEDULER_LOG);

  async function log(level, message) {
    const line = `[${nowIso()}] [${level}] ${redactSecrets(message)}`;
    await appendLine(schedulerLog, line);
  }

  return {
    info: async (message) => log("INFO", message),
    warn: async (message) => log("WARN", message),
    error: async (message) => log("ERROR", message),
  };
}

module.exports = {
  createLogger,
  redactSecrets,
};
