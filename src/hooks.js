const path = require("path");
const { pathExists } = require("./utils/fs");

function platformCandidates(type) {
  if (process.platform === "win32") {
    return [`${type}-run.ps1`, `${type}-run.cmd`, `${type}-run.sh`];
  }

  return [`${type}-run.sh`, `${type}-run.ps1`, `${type}-run.cmd`];
}

async function resolveHook(taskDir, type) {
  const candidates = platformCandidates(type);

  for (const fileName of candidates) {
    const filePath = path.join(taskDir, fileName);
    if (await pathExists(filePath)) {
      return filePath;
    }
  }

  return null;
}

function buildHookCommand(hookPath) {
  if (!hookPath) {
    return null;
  }

  if (hookPath.endsWith(".ps1")) {
    return `powershell -ExecutionPolicy Bypass -File "${hookPath}"`;
  }

  if (hookPath.endsWith(".cmd")) {
    return `"${hookPath}"`;
  }

  return `sh "${hookPath}"`;
}

module.exports = {
  resolveHook,
  buildHookCommand,
};
