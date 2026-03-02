#!/usr/bin/env node
const path = require("path");
const {
  cmdCancel,
  cmdAnswer,
  cmdConfig,
  cmdCleanFinished,
  cmdLogs,
  cmdQuestions,
  cmdPruneWorktrees,
  cmdReset,
  cmdResume,
  cmdStart,
  cmdStatus,
  cmdTask,
  cmdValidate,
} = require("./engine");

function normalizeCommand(raw) {
  if (!raw) {
    return null;
  }

  let cleaned = raw.trim().replace(/^\/+/, "");
  if (cleaned.includes("/") || cleaned.includes("\\")) {
    cleaned = path.basename(cleaned);
  }
  return cleaned;
}

function parseArgs(argv) {
  const [rawCommand, ...rest] = argv;
  const command = normalizeCommand(rawCommand);

  const flags = {
    parallel: false,
    dryRun: false,
    background: false,
    singleTaskName: null,
    provider: null,
    model: null,
    clearModel: false,
    includeErrors: false,
    internalWorker: command === "__worker",
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--parallel") {
      flags.parallel = true;
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--background") {
      flags.background = true;
    } else if (arg === "--worktree") {
      flags.singleTaskName = rest[i + 1] || null;
      i += 1;
    } else if (arg === "--provider") {
      flags.provider = rest[i + 1] || null;
      i += 1;
    } else if (arg === "--model") {
      flags.model = rest[i + 1] || null;
      i += 1;
    } else if (arg === "--clear-model") {
      flags.clearModel = true;
    } else if (arg === "--include-errors") {
      flags.includeErrors = true;
    }
  }

  return {
    command,
    rest,
    flags,
  };
}

async function main() {
  const rootDir = process.cwd();
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.command;

  if (!command) {
    throw new Error("No command provided.");
  }

  if (command === "slave-task") {
    const taskName = parsed.rest[0];
    if (!taskName) {
      throw new Error("Usage: slave-task {name}");
    }
    const output = await cmdTask(rootDir, taskName);
    console.log(output);
    return;
  }

  if (command === "slave-start" || command === "__worker") {
    const output = await cmdStart(rootDir, parsed.flags);
    console.log(output);
    return;
  }

  if (command === "slave-status") {
    const output = await cmdStatus(rootDir);
    console.log(output);
    return;
  }

  if (command === "slave-logs") {
    const taskName = parsed.rest[0];
    if (!taskName) {
      throw new Error("Usage: slave-logs {name}");
    }
    const output = await cmdLogs(rootDir, taskName);
    console.log(output);
    return;
  }

  if (command === "slave-questions") {
    const taskName = parsed.rest[0] || null;
    const output = await cmdQuestions(rootDir, taskName);
    console.log(output);
    return;
  }

  if (command === "slave-answer") {
    const taskName = parsed.rest[0];
    const answer = parsed.rest.slice(1).join(" ").trim();
    if (!taskName || !answer) {
      throw new Error('Usage: slave-answer {name} "your answer"');
    }
    const output = await cmdAnswer(rootDir, taskName, answer);
    console.log(output);
    return;
  }

  if (command === "slave-reset") {
    const taskName = parsed.rest[0];
    if (!taskName) {
      throw new Error("Usage: slave-reset {name}");
    }
    const output = await cmdReset(rootDir, taskName);
    console.log(output);
    return;
  }

  if (command === "slave-cancel") {
    const taskName = parsed.rest[0];
    if (!taskName) {
      throw new Error("Usage: slave-cancel {name}");
    }
    const output = await cmdCancel(rootDir, taskName);
    console.log(output);
    return;
  }

  if (command === "slave-validate") {
    const output = await cmdValidate(rootDir);
    console.log(output);
    return;
  }

  if (command === "slave-resume") {
    const output = await cmdResume(rootDir);
    console.log(output);
    return;
  }

  if (command === "slave-prune-worktrees") {
    const output = await cmdPruneWorktrees(rootDir);
    console.log(output);
    return;
  }

  if (command === "slave-clean-finished") {
    const output = await cmdCleanFinished(rootDir, parsed.flags);
    console.log(output);
    return;
  }

  if (command === "slave-config") {
    const output = await cmdConfig(rootDir, parsed.flags);
    console.log(output);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
