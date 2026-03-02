const TASK_NAME_REGEX = /^[a-z0-9][a-z0-9-_]{1,62}$/;

function validateTaskName(taskName) {
  if (!taskName || typeof taskName !== "string") {
    return "Task name is required.";
  }

  if (!TASK_NAME_REGEX.test(taskName)) {
    return "Task name must match ^[a-z0-9][a-z0-9-_]{1,62}$";
  }

  if (taskName.includes("..") || taskName.includes("/") || taskName.includes("\\")) {
    return "Task name cannot include path separators or '..'.";
  }

  return null;
}

function buildDependencyErrors(tasks) {
  const taskNames = new Set(tasks.map((task) => task.name));
  const missing = [];

  for (const task of tasks) {
    for (const dependency of task.dependsOn || []) {
      if (!taskNames.has(dependency)) {
        missing.push(`Task '${task.name}' depends on missing task '${dependency}'.`);
      }
    }
  }

  return missing;
}

function detectDependencyCycles(tasks) {
  const graph = new Map();
  for (const task of tasks) {
    graph.set(task.name, task.dependsOn || []);
  }

  const visiting = new Set();
  const visited = new Set();
  const cycles = [];

  function visit(node, stack) {
    if (visiting.has(node)) {
      const cycleStart = stack.indexOf(node);
      const cycle = stack.slice(cycleStart).concat(node);
      cycles.push(cycle.join(" -> "));
      return;
    }

    if (visited.has(node)) {
      return;
    }

    visiting.add(node);
    stack.push(node);

    const dependencies = graph.get(node) || [];
    for (const dep of dependencies) {
      if (graph.has(dep)) {
        visit(dep, stack);
      }
    }

    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      visit(node, []);
    }
  }

  return cycles;
}

module.exports = {
  TASK_NAME_REGEX,
  validateTaskName,
  buildDependencyErrors,
  detectDependencyCycles,
};
