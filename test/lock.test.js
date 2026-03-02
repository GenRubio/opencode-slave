const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { acquireLock, releaseLock } = require("../src/lock");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "opencode-lock-"));
}

test("acquireLock replaces stale dead-process lock", async () => {
  const root = await makeTempDir();
  const lockFile = path.join(root, "tasks.lock");

  await fs.writeFile(
    lockFile,
    JSON.stringify(
      {
        owner: "dead-owner",
        pid: 999999,
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
      null,
      2
    ),
    "utf8"
  );

  const handle = await acquireLock(lockFile, 30, 5000);
  assert.ok(handle.owner);

  const content = JSON.parse(await fs.readFile(lockFile, "utf8"));
  assert.equal(content.owner, handle.owner);

  await releaseLock(handle);
});
