const fs = require("fs/promises");
const path = require("path");

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const dirPath = path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await ensureDir(dirPath);
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function appendLine(filePath, line) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${line}\n`, "utf8");
}

async function removeIfExists(targetPath) {
  try {
    await fs.rm(targetPath, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

async function listSubdirectories(dirPath) {
  if (!(await pathExists(dirPath))) {
    return [];
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function listFilesRecursive(dirPath, options = {}) {
  const {
    maxFiles = 100,
    maxDepth = 6,
    currentDepth = 0,
  } = options;

  if (currentDepth > maxDepth || !(await pathExists(dirPath))) {
    return [];
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (files.length >= maxFiles) {
      break;
    }

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesRecursive(fullPath, {
        maxFiles: maxFiles - files.length,
        maxDepth,
        currentDepth: currentDepth + 1,
      });
      files.push(...nested);
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

module.exports = {
  pathExists,
  ensureDir,
  readJson,
  writeJsonAtomic,
  appendLine,
  removeIfExists,
  listSubdirectories,
  listFilesRecursive,
};
