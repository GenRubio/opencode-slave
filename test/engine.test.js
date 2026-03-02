const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cmdAnswer,
  cmdCleanFinished,
  cmdConfig,
  cmdQuestions,
  cmdResume,
  cmdStart,
  cmdStatus,
  cmdTask,
  cmdValidate,
} = require("../src/engine");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "opencode-slave-"));
}

test("cmdTask creates task and cmdStatus lists it", async () => {
  const root = await makeTempDir();

  await cmdTask(root, "my-task");
  const status = await cmdStatus(root);

  assert.match(status, /my-task/);
  assert.match(status, /pending/);

  const slaveGitignorePath = path.join(root, ".opencode-slave", ".gitignore");
  const gitignoreContent = await fs.readFile(slaveGitignorePath, "utf8");
  assert.equal(gitignoreContent, "*\n!.gitignore\n");

  const taskConfigPath = path.join(root, ".opencode-slave", "tasks", "my-task", "task.json");
  const taskConfig = JSON.parse(await fs.readFile(taskConfigPath, "utf8"));
  assert.equal(taskConfig.executor.commandTemplate, "__auto__");
  assert.equal(taskConfig.runInWorktree, false);
  assert.equal(taskConfig.branchName, null);
  assert.equal(taskConfig.baseBranch, null);
});

test("cmdStart requires git repo when task is configured to run in worktree", async () => {
  const root = await makeTempDir();
  const taskName = "worktree-task";
  await cmdTask(root, taskName);

  const taskConfigPath = path.join(root, ".opencode-slave", "tasks", taskName, "task.json");
  const taskConfig = JSON.parse(await fs.readFile(taskConfigPath, "utf8"));
  taskConfig.runInWorktree = true;
  await fs.writeFile(taskConfigPath, `${JSON.stringify(taskConfig, null, 2)}\n`, "utf8");

  await assert.rejects(
    () => cmdStart(root, { parallel: false, dryRun: false, background: false }),
    /Parallel\/worktree mode requires a git repository\./
  );
});

test("cmdValidate passes on clean state", async () => {
  const root = await makeTempDir();
  await cmdTask(root, "task-a");

  const output = await cmdValidate(root);
  assert.equal(output, "Validation passed.");
});

test("cmdStart executes task and writes result artifact", async () => {
  const root = await makeTempDir();
  const taskName = "run-once";
  await cmdTask(root, taskName);

  const taskConfigPath = path.join(root, ".opencode-slave", "tasks", taskName, "task.json");
  const taskConfig = JSON.parse(await fs.readFile(taskConfigPath, "utf8"));
  taskConfig.executor.commandTemplate = "node -e \"console.log('ok')\"";
  await fs.writeFile(taskConfigPath, `${JSON.stringify(taskConfig, null, 2)}\n`, "utf8");

  const output = await cmdStart(root, { parallel: false, dryRun: false, background: false });
  assert.equal(output, "Sequential run completed.");

  const status = await cmdStatus(root);
  assert.match(status, /run-once\tfinished/);

  const resultPath = path.join(root, ".opencode-slave", "tasks", taskName, "output", "result.json");
  const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  assert.equal(result.status, "finished");
  assert.equal(result.exitCode, 0);

  const logPath = path.join(root, ".opencode-slave", "tasks", taskName, "logs", "execution.log");
  const log = await fs.readFile(logPath, "utf8");
  assert.match(log, /stdout: ok/);
});

test("cmdResume recovers expired started task", async () => {
  const root = await makeTempDir();
  const taskName = "stale-task";
  await cmdTask(root, taskName);

  const tasksJsonPath = path.join(root, ".opencode-slave", "tasks.json");
  const state = JSON.parse(await fs.readFile(tasksJsonPath, "utf8"));
  const task = state.tasks.find((entry) => entry.name === taskName);
  task.status = "started";
  task.leaseExpiresAt = "2000-01-01T00:00:00.000Z";
  task.retries = 0;
  task.maxRetries = 1;
  await fs.writeFile(tasksJsonPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const output = await cmdResume(root);
  assert.match(output, /Recovered tasks: 1/);

  const status = await cmdStatus(root);
  assert.match(status, /stale-task\tpending/);
});

test("cmdResume recovers started task with dead pid", async () => {
  const root = await makeTempDir();
  const taskName = "dead-pid-task";
  await cmdTask(root, taskName);

  const tasksJsonPath = path.join(root, ".opencode-slave", "tasks.json");
  const state = JSON.parse(await fs.readFile(tasksJsonPath, "utf8"));
  const task = state.tasks.find((entry) => entry.name === taskName);
  task.status = "started";
  task.leaseExpiresAt = "2999-01-01T00:00:00.000Z";
  task.processPid = 999999;
  task.retries = 0;
  task.maxRetries = 1;
  await fs.writeFile(tasksJsonPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const output = await cmdResume(root);
  assert.match(output, /Recovered tasks: 1/);

  const status = await cmdStatus(root);
  assert.match(status, /dead-pid-task\tpending/);
  assert.match(status, /Recovered from dead process/);
});

test("legacy executor template is auto-migrated", async () => {
  const root = await makeTempDir();
  const taskName = "legacy-template";
  await cmdTask(root, taskName);

  const taskConfigPath = path.join(root, ".opencode-slave", "tasks", taskName, "task.json");
  const taskConfig = JSON.parse(await fs.readFile(taskConfigPath, "utf8"));
  taskConfig.executor.commandTemplate = 'opencode run --task-file "{taskFile}" --cd "{workspace}"';
  await fs.writeFile(taskConfigPath, `${JSON.stringify(taskConfig, null, 2)}\n`, "utf8");

  await cmdStatus(root);

  const migrated = JSON.parse(await fs.readFile(taskConfigPath, "utf8"));
  assert.equal(migrated.executor.commandTemplate, "__auto__");
});

test("cmdConfig sets and clears model override", async () => {
  const root = await makeTempDir();

  const setOutput = await cmdConfig(root, { model: "google/antigravity-gemini-3-flash" });
  assert.match(setOutput, /Model override: google\/antigravity-gemini-3-flash/);

  const configPath = path.join(root, ".opencode-slave", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.opencodeProvider, "google");
  assert.equal(config.opencodeModel, "antigravity-gemini-3-flash");

  const clearOutput = await cmdConfig(root, { clearModel: true });
  assert.match(clearOutput, /Model selection cleared/);

  const configAfterClear = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(configAfterClear.opencodeProvider, null);
  assert.equal(configAfterClear.opencodeModel, null);
});

test("auto executor moves task to waiting_input when context is missing", async () => {
  const root = await makeTempDir();
  const taskName = "empty-auto";
  await cmdTask(root, taskName);

  const output = await cmdStart(root, { parallel: false, dryRun: false, background: false });
  assert.equal(output, "Sequential run completed.");

  const status = await cmdStatus(root);
  assert.match(status, /empty-auto\twaiting_input/);

  const questions = await cmdQuestions(root, taskName);
  assert.match(questions, /Please describe the task goal in TASK\.md/);

  const answerOutput = await cmdAnswer(root, taskName, "Use existing layout and only adjust text.");
  assert.match(answerOutput, /moved to pending/);

  const statusAfterAnswer = await cmdStatus(root);
  assert.match(statusAfterAnswer, /empty-auto\tpending/);

  const answersPath = path.join(root, ".opencode-slave", "tasks", taskName, "context", "answers.md");
  const answersContent = await fs.readFile(answersPath, "utf8");
  assert.match(answersContent, /Use existing layout and only adjust text\./);
});

test("cmdCleanFinished removes finished task directories and state", async () => {
  const root = await makeTempDir();
  await cmdTask(root, "done-task");
  await cmdTask(root, "pending-task");

  const tasksJsonPath = path.join(root, ".opencode-slave", "tasks.json");
  const state = JSON.parse(await fs.readFile(tasksJsonPath, "utf8"));
  const doneTask = state.tasks.find((entry) => entry.name === "done-task");
  doneTask.status = "finished";
  await fs.writeFile(tasksJsonPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const cleanupOutput = await cmdCleanFinished(root, {});
  assert.match(cleanupOutput, /Removed tasks: 1/);

  const doneTaskDir = path.join(root, ".opencode-slave", "tasks", "done-task");
  await assert.rejects(() => fs.access(doneTaskDir));

  const status = await cmdStatus(root);
  assert.doesNotMatch(status, /done-task/);
  assert.match(status, /pending-task\tpending/);
});
