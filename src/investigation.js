const fs = require("fs/promises");
const path = require("path");
const { runCommand } = require("./utils/process");

const IGNORED_DIRS = new Set([".git", ".opencode-slave", "node_modules", "dist", "build"]);

async function walkFiles(rootDir, limit = 5000) {
  const results = [];

  async function walk(currentDir) {
    if (results.length >= limit) {
      return;
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(fullPath);
        }
        continue;
      }

      results.push(fullPath);
      if (results.length >= limit) {
        break;
      }
    }
  }

  await walk(rootDir);
  return results;
}

function scoreFile(filePath, keywords) {
  const low = filePath.toLowerCase();
  return keywords.reduce((score, keyword) => {
    if (keyword && low.includes(keyword)) {
      return score + 1;
    }
    return score;
  }, 0);
}

function toRelative(rootDir, filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}

async function runInvestigation(rootDir, task, taskConfig, globalConfig = {}) {
  const files = await walkFiles(rootDir);
  const keywords = task.name
    .split(/[-_]/g)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  const scored = files
    .map((filePath) => ({
      filePath,
      score: scoreFile(filePath, keywords),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((entry) => toRelative(rootDir, entry.filePath));

  const dbCandidates = files
    .filter((filePath) => {
      const low = filePath.toLowerCase();
      return (
        low.endsWith(".sql") ||
        low.includes("schema.prisma") ||
        low.includes("migration") ||
        low.includes("migrations")
      );
    })
    .slice(0, 20)
    .map((filePath) => toRelative(rootDir, filePath));

  const requireDbIntrospection = taskConfig.requireDbIntrospection || "auto";
  const shouldInspectDb = requireDbIntrospection === "required" || (requireDbIntrospection === "auto" && dbCandidates.length > 0);

  let dbCommandResult = null;
  if (shouldInspectDb && globalConfig.dbIntrospectionCommand) {
    const result = await runCommand({
      command: globalConfig.dbIntrospectionCommand,
      cwd: rootDir,
      timeoutSec: 120,
    });

    dbCommandResult = {
      code: result.code,
      summary: (result.stdout || result.stderr || "").trim().slice(0, 2000),
    };
  }

  return {
    inspectedAt: new Date().toISOString(),
    keywordHits: scored,
    dbSources: shouldInspectDb ? dbCandidates : [],
    dbCommandResult,
    summary: `Checked ${files.length} files. Found ${scored.length} task-related files${
      shouldInspectDb ? ` and ${dbCandidates.length} DB-related files.` : "."
    }`,
  };
}

module.exports = {
  runInvestigation,
};
