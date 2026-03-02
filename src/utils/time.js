function nowIso() {
  return new Date().toISOString();
}

function addSeconds(isoString, seconds) {
  const value = new Date(isoString);
  return new Date(value.getTime() + seconds * 1000).toISOString();
}

function isExpired(isoString) {
  if (!isoString) {
    return false;
  }

  return Date.now() > new Date(isoString).getTime();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

module.exports = {
  nowIso,
  addSeconds,
  isExpired,
  sleep,
};
