const test = require("node:test");
const assert = require("node:assert/strict");
const { validateTaskName, detectDependencyCycles } = require("../src/utils/validation");

test("validateTaskName accepts valid names", () => {
  assert.equal(validateTaskName("task-1"), null);
  assert.equal(validateTaskName("a_b"), null);
});

test("validateTaskName rejects invalid names", () => {
  assert.ok(validateTaskName("../task"));
  assert.ok(validateTaskName("Task"));
  assert.ok(validateTaskName("a"));
});

test("detectDependencyCycles finds cycle", () => {
  const cycles = detectDependencyCycles([
    { name: "a", dependsOn: ["b"] },
    { name: "b", dependsOn: ["c"] },
    { name: "c", dependsOn: ["a"] },
  ]);

  assert.ok(cycles.length > 0);
});
