const { spawn } = require("child_process");

function killProcessTree(pid) {
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => {
      // best effort
    });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // best effort
      }
    }, 5000);
  } catch {
    // best effort
  }
}

function isProcessAlive(pid) {
  const normalized = Number(pid);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    return false;
  }

  try {
    process.kill(normalized, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function runCommand({
  command,
  cwd,
  env,
  unsetEnv,
  timeoutSec = 0,
  idleTimeoutSec = 0,
  onStdout,
  onStderr,
  onSpawn,
}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...(env || {}) };
    for (const key of unsetEnv || []) {
      delete childEnv[key];
    }

    const child = spawn(command, {
      cwd,
      env: childEnv,
      shell: true,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let idleTimedOut = false;

    const clearTimer = (timer) => {
      if (timer) {
        clearTimeout(timer);
      }
    };

    let idleTimer = null;
    const armIdleTimer = () => {
      if (!idleTimeoutSec || idleTimeoutSec <= 0) {
        return;
      }

      clearTimer(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        idleTimedOut = true;
        killProcessTree(child.pid);
      }, idleTimeoutSec * 1000);
    };

    if (onSpawn) {
      Promise.resolve(onSpawn(child.pid)).catch(() => {
        // best effort
      });
    }

    const timeout =
      timeoutSec > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid);
          }, timeoutSec * 1000)
        : null;

    armIdleTimer();

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      armIdleTimer();
      if (onStdout) {
        onStdout(text);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      armIdleTimer();
      if (onStderr) {
        onStderr(text);
      }
    });

    child.on("close", (code, signal) => {
      clearTimer(timeout);
      clearTimer(idleTimer);

      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        idleTimedOut,
        pid: child.pid,
      });
    });

    child.on("error", (error) => {
      clearTimer(timeout);
      clearTimer(idleTimer);

      resolve({
        code: 1,
        signal: null,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        timedOut,
        idleTimedOut,
        pid: child.pid,
      });
    });
  });
}

module.exports = {
  isProcessAlive,
  runCommand,
};
