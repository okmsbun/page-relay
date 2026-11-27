// Shared Chrome launch and CDP WebSocket helper for browser tests.
// Uses --remote-debugging-port=0 and waits for Chrome's explicit DevTools
// readiness line on stderr instead of writing immediately to a raw FD pipe.
// Captures bounded stdout/stderr diagnostics and guarantees bounded cleanup.
const { spawn } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_CALL_TIMEOUT_MS = 15000;
const SIGTERM_GRACE_MS = 3000;
const SIGKILL_GRACE_MS = 2000;
const MAX_OUTPUT_CHARS = 16384;

const LINUX_CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

const MACOS_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function resolveChromeExecutable({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  if (env.CHROME_BIN) {
    const configured = env.CHROME_BIN.trim();
    if (!configured) {
      throw new Error("CHROME_BIN is set but empty");
    }
    if ((configured.includes("/") || configured.includes("\\")) && !exists(configured)) {
      throw new Error(`CHROME_BIN does not exist: ${configured}`);
    }
    return configured;
  }

  if (platform === "darwin") {
    return MACOS_CHROME_PATH;
  }

  if (platform === "linux") {
    for (const candidate of LINUX_CHROME_CANDIDATES) {
      if (exists(candidate)) return candidate;
    }
    return "google-chrome";
  }

  return "chrome";
}

function buildChromeArgs({
  profileDir,
  headless = true,
  allowFileAccess = true,
  disableExtensions = true,
  enableUnsafeExtensionDebugging = false,
  deviceScaleFactor,
  windowSize,
  windowPosition,
  url = "about:blank",
  env = process.env,
  extraArgs = [],
} = {}) {
  const args = [];
  if (headless) {
    args.push("--headless=new", "--disable-gpu");
  }
  if (deviceScaleFactor) {
    args.push(`--force-device-scale-factor=${deviceScaleFactor}`);
  }
  args.push(
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
  );
  if (disableExtensions) {
    args.push("--disable-extensions");
  }
  if (allowFileAccess) {
    args.push("--allow-file-access-from-files");
  }
  if (enableUnsafeExtensionDebugging) {
    args.push("--enable-unsafe-extension-debugging");
  }
  if (env.CI || env.CHROME_NO_SANDBOX === "1") {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }
  if (windowSize) {
    args.push(`--window-size=${windowSize}`);
  }
  if (windowPosition) {
    args.push(`--window-position=${windowPosition}`);
  }
  args.push(
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    ...extraArgs,
    url,
  );
  return args;
}

function createOutputTail(maxChars = MAX_OUTPUT_CHARS) {
  let text = "";
  return {
    append(chunk) {
      text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (text.length > maxChars) {
        text = text.slice(text.length - maxChars);
      }
    },
    text() {
      return text.trim();
    },
  };
}

function parseDevToolsUrl(text) {
  const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text);
  return match ? match[1] : null;
}

function formatDiagnostics({ executable, exitInfo, stderrTail, stdoutTail }) {
  const parts = [];
  if (executable) parts.push(`executable=${executable}`);
  if (exitInfo) {
    parts.push(`exitCode=${exitInfo.code ?? "null"}`, `signal=${exitInfo.signal ?? "null"}`);
  }
  const stderr = stderrTail?.text();
  if (stderr) parts.push(`chrome stderr:\n${stderr}`);
  const stdout = stdoutTail?.text();
  if (stdout) parts.push(`chrome stdout:\n${stdout}`);
  return parts.length ? `\n${parts.join("\n")}` : "";
}

async function terminateProcess(child, {
  sigtermGraceMs = SIGTERM_GRACE_MS,
  sigkillGraceMs = SIGKILL_GRACE_MS,
} = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const waitForExit = (timeoutMs) =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      child.once("exit", onExit);
    });

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  const exitedGracefully = await waitForExit(sigtermGraceMs);
  if (exitedGracefully) return;

  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await waitForExit(sigkillGraceMs);
}

function removeProfileDir(profileDir) {
  if (!profileDir) return;
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.warn(`Warning: failed to remove Chrome temp profile ${profileDir}: ${error.message}`);
  }
}

function waitForDevToolsUrl(child, {
  executable,
  stderrTail,
  stdoutTail,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let combinedStderr = "";

    const cleanup = () => {
      clearTimeout(timer);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    const fail = (message, exitInfo) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${message}${formatDiagnostics({ executable, exitInfo, stderrTail, stdoutTail })}`));
    };

    const onStderr = (chunk) => {
      combinedStderr += chunk.toString("utf8");
      const wsUrl = parseDevToolsUrl(combinedStderr);
      if (wsUrl && !settled) {
        settled = true;
        cleanup();
        resolve(wsUrl);
      }
    };

    const onError = (error) => {
      fail(`Failed to spawn Chrome: ${error.message}`);
    };

    const onExit = (code, signal) => {
      fail("Chrome exited before DevTools endpoint became ready", { code, signal });
    };

    const timer = setTimeout(() => {
      fail(`Timed out after ${startupTimeoutMs}ms waiting for Chrome DevTools endpoint`);
    }, startupTimeoutMs);
    timer.unref?.();

    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function connectWebSocket(wsUrl, child, {
  executable,
  stderrTail,
  stdoutTail,
  connectTimeoutMs = 10000,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      child.off("exit", onExit);
    };

    const fail = (message, exitInfo) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        ws.close();
      } catch {
        // Ignore close errors while rejecting connection attempt.
      }
      reject(new Error(`${message}${formatDiagnostics({ executable, exitInfo, stderrTail, stdoutTail })}`));
    };

    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ws);
    };

    const onError = (event) => {
      const detail = event?.message || event?.error?.message || "WebSocket connection error";
      fail(`Failed to connect to Chrome DevTools WebSocket (${wsUrl}): ${detail}`);
    };

    const onClose = (event) => {
      fail(`Chrome DevTools WebSocket closed before opening (code=${event?.code ?? "unknown"})`);
    };

    const onExit = (code, signal) => {
      fail("Chrome exited while connecting to DevTools WebSocket", { code, signal });
    };

    const timer = setTimeout(() => {
      fail(`Timed out after ${connectTimeoutMs}ms connecting to Chrome DevTools WebSocket (${wsUrl})`);
    }, connectTimeoutMs);
    timer.unref?.();

    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
    ws.addEventListener("close", onClose, { once: true });
    child.once("exit", onExit);
  });
}

async function launchChrome({
  prefix = "pagerelay-chrome-",
  headless = true,
  allowFileAccess = true,
  disableExtensions = true,
  enableUnsafeExtensionDebugging = false,
  deviceScaleFactor,
  windowSize,
  windowPosition,
  url = "about:blank",
  extraArgs = [],
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  env = process.env,
} = {}) {
  const executable = resolveChromeExecutable({ env });
  const profileDir = mkdtempSync(path.join(tmpdir(), prefix));
  const args = buildChromeArgs({
    profileDir,
    headless,
    allowFileAccess,
    disableExtensions,
    enableUnsafeExtensionDebugging,
    deviceScaleFactor,
    windowSize,
    windowPosition,
    url,
    env,
    extraArgs,
  });

  const stderrTail = createOutputTail();
  const stdoutTail = createOutputTail();
  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => stdoutTail.append(chunk));
  child.stderr?.on("data", (chunk) => stderrTail.append(chunk));

  let ws = null;
  let exitInfo = null;
  let closePromise = null;
  let serial = 0;
  const pending = new Map();

  const failPending = (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
    failPending(
      new Error(
        `Chrome exited unexpectedly${formatDiagnostics({ executable, exitInfo, stderrTail, stdoutTail })}`,
      ),
    );
  });

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      failPending(new Error("Chrome CDP session closed"));
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close();
        } catch {
          // Ignore close errors during teardown.
        }
      }
      await terminateProcess(child);
      removeProfileDir(profileDir);
    })();
    return closePromise;
  };

  try {
    const wsUrl = await waitForDevToolsUrl(child, {
      executable,
      stderrTail,
      stdoutTail,
      startupTimeoutMs,
    });
    ws = await connectWebSocket(wsUrl, child, {
      executable,
      stderrTail,
      stdoutTail,
    });

    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      } else {
        entry.resolve(message.result);
      }
    });

    ws.addEventListener("close", (event) => {
      failPending(
        new Error(
          `Chrome DevTools WebSocket closed (code=${event?.code ?? "unknown"})${formatDiagnostics({
            executable,
            exitInfo,
            stderrTail,
            stdoutTail,
          })}`,
        ),
      );
    });

    ws.addEventListener("error", (event) => {
      const detail = event?.message || event?.error?.message || "WebSocket error";
      failPending(
        new Error(
          `Chrome DevTools WebSocket error: ${detail}${formatDiagnostics({
            executable,
            exitInfo,
            stderrTail,
            stdoutTail,
          })}`,
        ),
      );
    });

    function call(method, params = {}, sessionId, timeoutMs = callTimeoutMs) {
      if (exitInfo) {
        return Promise.reject(
          new Error(
            `Cannot call ${method}: Chrome already exited${formatDiagnostics({
              executable,
              exitInfo,
              stderrTail,
              stdoutTail,
            })}`,
          ),
        );
      }
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(
          new Error(
            `Cannot call ${method}: Chrome DevTools WebSocket is not open${formatDiagnostics({
              executable,
              exitInfo,
              stderrTail,
              stdoutTail,
            })}`,
          ),
        );
      }
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              `${method} timed out after ${timeoutMs}ms${formatDiagnostics({
                executable,
                exitInfo,
                stderrTail,
                stdoutTail,
              })}`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { method, resolve, reject, timer });
        try {
          ws.send(
            JSON.stringify({
              id,
              method,
              params,
              ...(sessionId ? { sessionId } : {}),
            }),
          );
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    }

    return {
      child,
      ws,
      wsUrl,
      executable,
      profileDir,
      call,
      close,
      getStderr: () => stderrTail.text(),
      getStdout: () => stdoutTail.text(),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = {
  buildChromeArgs,
  createOutputTail,
  launchChrome,
  parseDevToolsUrl,
  removeProfileDir,
  resolveChromeExecutable,
  terminateProcess,
};
