const fs = require("fs/promises");
const os = require("os");
const { readJson, writeJsonAtomic, pathExists } = require("./utils/fs");
const { addSeconds, isExpired, nowIso, sleep } = require("./utils/time");

function buildOwnerId() {
  return `${os.hostname()}:${process.pid}:${Date.now()}`;
}

function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number") {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(lockFile, lockTtlSec, waitTimeoutMs = 10000) {
  const owner = buildOwnerId();
  const startedAt = Date.now();

  while (Date.now() - startedAt < waitTimeoutMs) {
    const payload = {
      owner,
      pid: process.pid,
      createdAt: nowIso(),
      expiresAt: addSeconds(nowIso(), lockTtlSec),
    };

    try {
      await fs.writeFile(lockFile, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });

      return {
        owner,
        lockFile,
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      const current = await readJson(lockFile, null);
      if (!current || isExpired(current.expiresAt) || !isProcessAlive(current.pid)) {
        await writeJsonAtomic(lockFile, payload);
        return {
          owner,
          lockFile,
        };
      }

      await sleep(250);
    }
  }

  throw new Error("Unable to acquire lock: timeout");
}

async function refreshLock(lockHandle, lockTtlSec) {
  if (!lockHandle) {
    return;
  }

  const hasLock = await pathExists(lockHandle.lockFile);
  if (!hasLock) {
    return;
  }

  const current = await readJson(lockHandle.lockFile, null);
  if (!current || current.owner !== lockHandle.owner) {
    return;
  }

  await writeJsonAtomic(lockHandle.lockFile, {
    ...current,
    expiresAt: addSeconds(nowIso(), lockTtlSec),
  });
}

async function releaseLock(lockHandle) {
  if (!lockHandle) {
    return;
  }

  try {
    const current = await readJson(lockHandle.lockFile, null);
    if (current && current.owner === lockHandle.owner) {
      await fs.rm(lockHandle.lockFile, { force: true });
    }
  } catch {
    // best effort
  }
}

module.exports = {
  acquireLock,
  refreshLock,
  releaseLock,
};
