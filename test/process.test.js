const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { runCommand } = require("../src/utils/process");

test("runCommand enforces idle timeout", async () => {
  const result = await runCommand({
    command: "node -e \"setTimeout(() => {}, 5000)\"",
    cwd: path.resolve(__dirname, ".."),
    timeoutSec: 10,
    idleTimeoutSec: 1,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.idleTimedOut, true);
});

test("runCommand idle timer resets on output", async () => {
  const result = await runCommand({
    command:
      "node -e \"let n=0; const t=setInterval(()=>{console.log('tick'); n+=1; if(n===3){clearInterval(t);}}, 200)\"",
    cwd: path.resolve(__dirname, ".."),
    timeoutSec: 10,
    idleTimeoutSec: 1,
  });

  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.idleTimedOut, false);
  assert.match(result.stdout, /tick/);
});
