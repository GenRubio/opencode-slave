#!/usr/bin/env node
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

function toPosixPath(input) {
  return input.replace(/\\/g, "/");
}

function commandTemplate({ description, body }) {
  return `---\ndescription: ${description}\n---\n${body}\n`;
}

async function writeFileSafe(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function buildCommands(wrapperPathPosix) {
  const installerCommand = `npm --prefix \"${toPosixPath(path.resolve(__dirname, ".."))}\" run install:opencode`;
  const run = (subcommand, argsExpression = "$ARGUMENTS") =>
    `node \"${wrapperPathPosix}\" ${subcommand}${argsExpression ? ` ${argsExpression}` : ""}`;

  return {
    "slave-install.md": commandTemplate({
      description: "Install or refresh slave commands in OpenCode",
      body: [
        "Install or refresh all `/slave-*` commands in your OpenCode profile.",
        "",
        "Rules:",
        `1) Run this command exactly once with Bash: \`${installerCommand}\`.`,
        "2) Return the command output as plain text.",
      ].join("\n"),
    }),

    "slave-task.md": commandTemplate({
      description: "Create an autonomous task in current project",
      body: [
        "Create a task inside the current repository using opencode-slave.",
        "",
        "Input arguments: `$ARGUMENTS`",
        "",
        "Rules:",
        "1) If there are no arguments, explain usage: `/slave-task {name}`.",
        `2) Run this command exactly once with Bash: \`${run("/slave-task")}\`.`,
        "3) Return the command output as plain text.",
      ].join("\n"),
    }),

    "slave-config.md": commandTemplate({
      description: "Configure provider/model for autonomous tasks",
      body: [
        "Configure model override for task execution in the current repository.",
        "",
        "Input arguments: `$ARGUMENTS` (optional)",
        "",
        "Rules:",
        `1) Run this command exactly once with Bash: \`${run("/slave-config")}\`.`,
        "2) Return the command output as plain text.",
        "",
        "Examples:",
        "- /slave-config --model opencode/gpt-5.3-codex",
        "- /slave-config --provider opencode --model gpt-5.3-codex",
        "- /slave-config --clear-model",
      ].join("\n"),
    }),

    "slave-start.md": commandTemplate({
      description: "Start autonomous task execution",
      body: [
        "Start autonomous task execution in the current repository.",
        "",
        "Input arguments: `$ARGUMENTS` (optional, e.g. `--dry-run`, `--parallel`, `--background`, `--worktree my-task`)",
        "",
        "Rules:",
        "1) If there are no input arguments, run in background mode to avoid terminal timeouts.",
        `2) If there are no input arguments, run exactly once with Bash: \`${run("/slave-start", "--background")}\`.`,
        `3) If there are input arguments, run exactly once with Bash: \`${run("/slave-start")}\`.`,
        "4) Return the command output as plain text.",
      ].join("\n"),
    }),

    "slave-status.md": commandTemplate({
      description: "Show autonomous task status table",
      body: [
        "Show task status for the current repository.",
        "",
        "Rules:",
        `1) Run this command exactly once with Bash: \`${run("/slave-status", "")}\`.`,
        "2) Return the command output as plain text.",
      ].join("\n"),
    }),

    "slave-logs.md": commandTemplate({
      description: "Show logs for one autonomous task",
      body: [
        "Show task logs for the current repository.",
        "",
        "Input arguments: `$ARGUMENTS`",
        "",
        "Rules:",
        "1) If there are no arguments, explain usage: `/slave-logs {name}`.",
        `2) Run this command exactly once with Bash: \`${run("/slave-logs")}\`.`,
        "3) Return the command output as plain text.",
      ].join("\n"),
    }),

    "slave-questions.md": commandTemplate({
      description: "Show questions for blocked tasks",
      body: [
        "Show tasks waiting for human input, or questions for one task.",
        "",
        "Input arguments: `$ARGUMENTS` (optional task name)",
        "",
        "Rules:",
        `1) Run this command exactly once with Bash: \`${run("/slave-questions")}\`.`,
        "2) Return the command output as plain text.",
      ].join("\n"),
    }),

    "slave-answer.md": commandTemplate({
      description: "Answer a blocked task and resume",
      body: [
        "Provide a human answer for a task blocked in waiting_input.",
        "",
        "Input arguments: `$ARGUMENTS`",
        "",
        "Rules:",
        "1) If no arguments, explain usage: /slave-answer {name} \"your answer\".",
        `2) Run this command exactly once with Bash: \`${run("/slave-answer")}\`.`,
        "3) Return the command output as plain text.",
      ].join("\n"),
    }),

    "slave-reset.md": commandTemplate({
      description: "Reset autonomous task to pending",
      body: [
        "Reset a task to `pending` in the current repository.",
        "",
        "Input arguments: `$ARGUMENTS`",
        "",
        "Rules:",
        "1) If there are no arguments, explain usage: `/slave-reset {name}`.",
        `2) Run this command exactly once with Bash: \`${run("/slave-reset")}\`.`,
        "3) Return the command output as plain text.",
      ].join("\n"),
    }),

    "slave-cancel.md": commandTemplate({
      description: "Cancel a running autonomous task",
      body: [
        "Cancel a running task in the current repository.",
        "",
        "Input arguments: `$ARGUMENTS`",
        "",
        "Rules:",
        "1) If there are no arguments, explain usage: `/slave-cancel {name}`.",
        `2) Run this command exactly once with Bash: \`${run("/slave-cancel")}\`.`,
        "3) Return the command output as plain text.",
      ].join("\n"),
    }),

    "slave-validate.md": commandTemplate({
      description: "Validate autonomous task graph and state",
      body: [
        "Validate state integrity for the current repository.",
        "",
        "Rules:",
        `1) Run this command exactly once with Bash: \`${run("/slave-validate", "")}\`.`,
        "2) Return the command output as plain text.",
      ].join("\n"),
    }),

    "slave-resume.md": commandTemplate({
      description: "Recover tasks after interrupted run",
      body: [
        "Recover stale `started` tasks in the current repository.",
        "",
        "Rules:",
        `1) Run this command exactly once with Bash: \`${run("/slave-resume", "")}\`.`,
        "2) Return the command output as plain text.",
      ].join("\n"),
    }),

    "slave-prune-worktrees.md": commandTemplate({
      description: "Prune stale git worktree references",
      body: [
        "Prune stale worktree metadata in the current repository.",
        "",
        "Rules:",
        `1) Run this command exactly once with Bash: \`${run("/slave-prune-worktrees", "")}\`.`,
        "2) Return the command output as plain text.",
      ].join("\n"),
    }),

    "slave-clean-finished.md": commandTemplate({
      description: "Remove completed task artifacts",
      body: [
        "Remove finished/cancelled task folders and state entries in the current repository.",
        "",
        "Input arguments: `$ARGUMENTS` (optional: `--include-errors`)",
        "",
        "Rules:",
        `1) Run this command exactly once with Bash: \`${run("/slave-clean-finished")}\`.`,
        "2) Return the command output as plain text.",
      ].join("\n"),
    }),
  };
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const cliPath = path.join(projectRoot, "src", "cli.js");

  const opencodeRoot = path.join(os.homedir(), ".config", "opencode");
  const commandsDir = path.join(opencodeRoot, "commands");
  const scriptsDir = path.join(opencodeRoot, "scripts");

  const wrapperPath = path.join(scriptsDir, "opencode-slave.js");
  const wrapperPathPosix = toPosixPath(wrapperPath);
  const cliPathPosix = toPosixPath(cliPath);

  const wrapperSource = `#!/usr/bin/env node
const { spawn } = require("child_process");

const cliPath = ${JSON.stringify(cliPathPosix)};
const args = process.argv.slice(2);

const child = spawn(process.execPath, [cliPath, ...args], {
  cwd: process.cwd(),
  stdio: "inherit",
  windowsHide: true,
});

child.on("close", (code) => process.exit(code || 0));
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
`;

  await writeFileSafe(wrapperPath, wrapperSource);

  const commandFiles = buildCommands(wrapperPathPosix);
  for (const [fileName, content] of Object.entries(commandFiles)) {
    await writeFileSafe(path.join(commandsDir, fileName), content);
  }

  console.log("Installed opencode-slave commands into OpenCode.");
  console.log(`- Wrapper: ${wrapperPath}`);
  console.log(`- Commands: ${Object.keys(commandFiles).length}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
