import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const base = process.argv[2];
if (!base) throw new Error("Usage: node scripts/verify-browser.mjs <base-url>");
const chromePath = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
assert.ok(existsSync(chromePath), "Headless Chrome executable is unavailable");
const profile = mkdtempSync(join(tmpdir(), "alphatrack-browser-"));
const chrome = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, base
], { stdio: "ignore", windowsHide: true });

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(operation, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch {}
    await pause(100);
  }
  throw new Error("Headless browser verification timed out");
}

let socket;
try {
  const port = await until(() => {
    const path = join(profile, "DevToolsActivePort");
    return existsSync(path) ? Number(readFileSync(path, "utf8").split(/\r?\n/)[0]) : null;
  });
  const target = await until(async () => {
    const tabs = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
    return tabs.find(tab => tab.type === "page" && tab.webSocketDebuggerUrl);
  });
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error("Browser page script failed");
    return response.result.value;
  };
  await send("Runtime.enable");
  await until(async () => await evaluate("document.body?.innerText.includes('INSTANT DEMO ACCOUNT SIGN-IN')"));
  await evaluate("document.querySelector('.demo-button').click()");
  await until(async () => await evaluate("document.body?.innerText.includes('PAPER ORDER') && document.body?.innerText.includes('SIGN OUT')"));
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const workstation = await until(async () => {
    const state = await evaluate(`(() => {
      const chart = document.querySelector('.chart-panel')?.getBoundingClientRect();
      const ticket = document.querySelector('.order-ticket')?.getBoundingClientRect();
      const dock = document.querySelector('.bottom-dock')?.getBoundingClientRect();
      const main = document.querySelector('main');
      return { route: location.hash, chartWidth: chart?.width, sideBySide: !!chart && !!ticket && ticket.left >= chart.right,
        dockBelow: !!dock && !!chart && dock.top >= chart.bottom, dockVisible: !!dock && dock.bottom <= innerHeight,
        noPageScroll: !!main && main.scrollHeight <= main.clientHeight + 2,
        candles: !!document.querySelector('.chart-modes button:last-child') };
    })()`);
    return state.chartWidth && state.sideBySide && state.dockBelow && state.dockVisible && state.noPageScroll && state.candles ? state : null;
  });
  assert.equal(workstation.route, "#/terminal");
  await evaluate("document.querySelector('.chart-modes button:last-child').click()");
  assert.ok(await evaluate("document.querySelector('svg[aria-label*=" + JSON.stringify("Candlestick") + "]') !== null"));
  await evaluate("Array.from(document.querySelectorAll('nav button')).find(button => button.innerText.includes('System')).click()");
  await until(async () => await evaluate("document.body?.innerText.includes('LIVE D1 ORDER STATES') && document.body?.innerText.includes('AUTHENTICATION AND RATE LIMITS')"));
  const visible = await until(async () => {
    const state = await evaluate("({ title: document.querySelector('main h1')?.innerText, d1: document.body.innerText.includes('API / D1'), iex: document.body.innerText.includes('IEX'), user: document.body.innerText.includes('SIGNED-IN USER'), orderStates: ['PENDING','PROCESSING','FILLED','REJECTED'].every(state => document.body.innerText.includes(state)) })");
    return state.d1 && state.iex && state.user && state.orderStates ? state : null;
  });
  assert.equal(visible.title, "System health");
  assert.ok(visible.d1 && visible.iex && visible.user && visible.orderStates);
  console.log(JSON.stringify({ base: new URL(base).origin, headlessChrome: "ok", demoSignIn: "ok", workstation: "ok", systemView: "ok", ...visible }));
} finally {
  socket?.close();
  chrome.kill();
  const absolute = resolve(profile);
  assert.ok(absolute.startsWith(resolve(tmpdir()) + sep), "Refusing to remove a browser profile outside the temp directory");
  await pause(250);
  rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
