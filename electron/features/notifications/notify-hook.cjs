const http = require("node:http");

const REQUEST_TIMEOUT_MS = 1500;
const MAX_BODY_BYTES = 8 * 1024;
const EVENT_NAMES = new Set(["idle", "running", "completed", "approval"]);

function getEvent(args) {
  if (!Array.isArray(args) || args.length === 0) return null;
  const source = args[0];
  if (source === "claude") {
    const event = args[1];
    return EVENT_NAMES.has(event) ? event : null;
  }
  if (source !== "codex") return null;
  const payloadText = args[args.length - 1];
  if (typeof payloadText !== "string") return null;
  let eventType = payloadText;
  if (payloadText.trimStart().startsWith("{")) {
    try {
      const payload = JSON.parse(payloadText);
      eventType = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.type : null;
    } catch {
      return null;
    }
  }
  return eventType === "agent-turn-complete" ? "completed" : null;
}

function getLocalNotifyAddress(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/notify") return null;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { hostname: "127.0.0.1", port, path: "/notify" };
  } catch {
    return null;
  }
}

function makePayload(environment, event) {
  const sessionId = environment.CIMLINE_SESSION_ID;
  const token = environment.CIMLINE_NOTIFY_TOKEN;
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 160 || typeof token !== "string" || !token || token.length > 256) return null;
  if (!EVENT_NAMES.has(event)) return null;
  return { token, event, sessionId };
}

function postNotify(address, payload) {
  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;
    let request = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve();
    };
    try {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      if (body.byteLength > MAX_BODY_BYTES) return finish();
      request = http.request({
        ...address,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
          connection: "close",
        },
      }, (response) => {
        response.resume();
        response.once("end", finish);
      });
      request.once("error", finish);
      timeout = setTimeout(() => {
        try { request.destroy(); } catch {}
        finish();
      }, REQUEST_TIMEOUT_MS);
      request.end(body);
    } catch {
      try { request?.destroy(); } catch {}
      finish();
    }
  });
}

async function run(environment = process.env, args = process.argv.slice(2)) {
  const event = getEvent(args);
  if (!event) return;
  const address = getLocalNotifyAddress(environment.CIMLINE_NOTIFY_URL);
  const payload = makePayload(environment, event);
  if (!address || !payload) return;
  await postNotify(address, payload);
}

function drainStdin() {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded || process.stdin.destroyed) return resolve();
    process.stdin.on("data", () => {});
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
    process.stdin.resume();
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  // Claude sends hook JSON on stdin. Drain it without retaining or parsing any byte.
  const input = args[0] === "claude" ? drainStdin() : Promise.resolve();
  const deadline = setTimeout(() => process.exit(0), REQUEST_TIMEOUT_MS);
  Promise.all([run(process.env, args), input]).catch(() => {}).finally(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
}

module.exports = { getEvent, getLocalNotifyAddress, makePayload, postNotify, run, drainStdin };
