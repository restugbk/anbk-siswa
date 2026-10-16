#!/usr/bin/env node
/**
 * open-with-headers.mjs
 *
 * Launch Chrome/Edge and inject custom HTTP request headers into every request
 * of the tab - including after navigations, refreshes and new tabs.
 *
 * Zero dependencies: talks to the Chrome DevTools Protocol over the WebSocket
 * implementation bundled with Node.js 22+.
 *
 * IMPORTANT
 *   The injected headers live in the DevTools session, not in the tab. If this
 *   process exits, the session detaches and the headers stop applying. That is
 *   why the script stays attached after the first page load - just leave it
 *   running while you browse, and stop it with Ctrl+C when you are done.
 *
 * Defaults (edit DEFAULT_URL / DEFAULT_HEADERS below, or override from the CLI):
 *   url     = https://example.com/Auth/Login
 *   headers = the preset list in DEFAULT_HEADERS
 *
 * Usage:
 *   node open-with-headers.mjs
 *   node open-with-headers.mjs --url "https://example.com/dashboard" \
 *     --header "Authorization: Bearer <token>"
 *   node open-with-headers.mjs --headless --wait 15000     # auto-exit after 15s
 *   node open-with-headers.mjs --close                     # quit with the browser
 *
 * Only inject on certain URLs (the rest stay untouched):
 *   node open-with-headers.mjs \
 *     --pattern "https://example.com/api/*" \
 *     --pattern "*://*.example.com/graphql"
 *
 * Options:
 *   --url <url>        URL to open (default: the preset URL).
 *   --then <url|reload>
 *                      After the page loads, go here (or reload). Repeatable.
 *                      Mostly useful to verify the headers survive navigation.
 *   --header "N: V"    Header to inject. Repeatable. Overrides a preset of the
 *                      same name.
 *   --no-default-headers
 *                      Do not send the preset headers; send only --header ones.
 *   --pattern <glob>   CDP-ish urlPattern where the headers apply. Repeatable.
 *                      Defaults to "*" (every request). This path goes through
 *                      request interception, which is the only way to override
 *                      "Accept" as well.
 *   --global           Use Network.setExtraHTTPHeaders for the whole tab
 *                      instead of interception. Lighter, but Chrome wins on
 *                      "Accept" and other self-managed headers.
 *   --new-tabs         Also inject into tabs you open later (auto-attach).
 *   --chrome <path>    Explicit browser executable.
 *   --port <n>         Remote debugging port (default 9222).
 *   --profile <dir>    User data dir (default: a fresh temp dir, so it never
 *                      collides with an already-running Chrome).
 *   --headless         Run headless ("new" headless mode).
 *   --wait <ms>        Stay attached this long, then exit. Without it the
 *                      script stays attached until Ctrl+C.
 *   --close            Close the browser when this process exits.
 *   --dump             Print the URL and headers that would be sent, without
 *                      launching a browser.
 *   -h, --help         Show this help.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ---------------------------------------------------------------- presets */

const DEFAULT_URL = "https://anbk-siswa.pusmendik.kemendikdasmen.go.id/Auth/Login";

// Reproduces: curl 'https://example.com/Auth/Login' -H '...' --compressed
const DEFAULT_HEADERS = [
  "authority: anbk-siswa.pusmendik.kemendikdasmen.go.id",
  "cache-control: max-age=0",
  "accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
  "accept-language: en-US",
  "content-type: application/x-www-form-urlencoded",
  "origin: null",
  "sec-fetch-dest: document",
  "sec-fetch-mode: navigate",
  "sec-fetch-site: same-origin",
  "sec-fetch-user: ?1",
  "upgrade-insecure-requests: 1",
  "user-agent: WJHDM2JCBYRDR3A6WUCWQ9SDRN4FZ6UKUWGF3JHPQUXW5UAZRMZSKQ4R2ZKDPSY733TYLJUXZYM3NQZ4MM2JQEKHN24NEFECMZ2M4YJC5WSEZ6QM8H6MM24MVJVQLCLUKZFGQWLCFGY64ZH83NQCS97SYAVHJ2X6FFJYMTAR4RD8DFHQE6SZP4NUNSQA9VT5PCRSDTHBUQXACAXE4VT6PYV9STRVT6EXTFPDMHVMHNZQ95HQWRPZN8BLRRDGN4PV7KM83B5BP8Q5SWXUBFPKFFXNT79SPGENPSUXRUM757QHAU4X26YHLGR5ZNJZAVY6GW95UAR3N8ZUFDERZXJM9NS6HZDDWJTHSEYUGM2WRPSSALRV446DKK598C7MUE55",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const out = {
    headers: [],
    patterns: [],
    then: [],
    port: 9222,
    headless: false,
    close: false,
    useDefaults: true,
    dump: false,
    global: false,
    newTabs: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--url": out.url = val(); break;
      case "--then": out.then.push(val()); break;
      case "--header": out.headers.push(val()); break;
      case "--pattern": out.patterns.push(val()); break;
      case "--chrome": out.chrome = val(); break;
      case "--port": out.port = Number(val()); break;
      case "--profile": out.profile = val(); break;
      case "--wait": out.wait = Number(val()); break;
      case "--no-default-headers": out.useDefaults = false; break;
      case "--global": out.global = true; break;
      case "--new-tabs": out.newTabs = true; break;
      case "--dump": out.dump = true; break;
      case "--headless": out.headless = true; break;
      case "--close": out.close = true; break;
      case "-h":
      case "--help": out.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function parseHeaderLines(list) {
  // Map keyed by lowercased name so duplicates/casing collapse cleanly.
  const map = new Map();
  for (const raw of list) {
    const idx = raw.indexOf(":");
    if (idx < 1) throw new Error(`invalid --header (expected "Name: Value"): ${raw}`);
    const name = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    map.set(name.toLowerCase(), { name, value });
  }
  return map;
}

/* ------------------------------------------------------------ find browser */

function findBrowser(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`browser not found: ${explicit}`);
    return explicit;
  }
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe")
      : undefined,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error("could not find Chrome/Edge; pass --chrome <path>");
  return hit;
}

/* --------------------------------------------------------------- CDP glue */

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error("devtools websocket error")));
    });
    this.closed = new Promise((resolve) => {
      this.ws.addEventListener("close", () => resolve());
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
        return;
      }
      for (const fn of this.handlers.get(msg.method) ?? []) {
        Promise.resolve(fn(msg.params, msg.sessionId)).catch((e) =>
          console.error(`handler ${msg.method} failed: ${e.message}`),
        );
      }
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function waitForDevtools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(150);
  }
  throw new Error(`cannot reach devtools on port ${port}: ${lastErr?.message}`);
}

/* ------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("see the header comment of this file for usage");
    return;
  }

  const presetHeaders = args.useDefaults ? DEFAULT_HEADERS : [];
  const headerMap = parseHeaderLines([...presetHeaders, ...args.headers]);
  const url = args.url ?? DEFAULT_URL;
  if (headerMap.size === 0) {
    throw new Error("nothing to send: pass --header, or drop --no-default-headers");
  }

  const injected = Object.fromEntries([...headerMap.values()].map((h) => [h.name, h.value]));

  if (args.dump) {
    console.log("GET " + url);
    for (const { name, value } of headerMap.values()) console.log(`${name}: ${value}`);
    return;
  }

  const browser = findBrowser(args.chrome);
  const patterns = args.global ? [] : args.patterns.length ? args.patterns : ["*"];

  const profile = args.profile ?? mkdtempSync(join(tmpdir(), "cdp-headers-"));
  const chromeArgs = [
    `--remote-debugging-port=${args.port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (args.headless) chromeArgs.push("--headless=new", "--disable-gpu");
  chromeArgs.push("about:blank");

  const child = spawn(browser, chromeArgs, { stdio: "ignore", detached: !args.close });
  child.unref?.();

  const version = await waitForDevtools(args.port);
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;

  // The interception handler is global: it gets the right session id handed to
  // it, so it also covers tabs that were auto-attached later.
  if (patterns.length > 0) {
    cdp.on("Fetch.requestPaused", async (params, sid) => {
      const merged = new Map();
      for (const [n, v] of Object.entries(params.request.headers ?? {})) {
        merged.set(n.toLowerCase(), { name: n, value: v });
      }
      for (const [k, h] of headerMap) merged.set(k, h);
      await cdp.send(
        "Fetch.continueRequest",
        { requestId: params.requestId, headers: [...merged.values()] },
        sid,
      );
    });
  }

  // Applied per session. Called again for every new tab, so headers survive
  // navigations, refreshes and freshly opened tabs.
  async function configureSession(sessionId) {
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    if (patterns.length === 0) {
      await cdp.send("Network.setExtraHTTPHeaders", { headers: injected }, sessionId);
    } else {
      await cdp.send(
        "Fetch.enable",
        { patterns: patterns.map((p) => ({ urlPattern: p, requestStage: "Request" })) },
        sessionId,
      );
    }
  }

  const configured = new Set(); // sessionIds
  const configuredTargets = new Set(); // targetIds

  if (args.newTabs) {
    cdp.on("Target.attachedToTarget", async ({ sessionId, targetInfo }) => {
      if (targetInfo.type !== "page") return;
      if (configured.has(sessionId) || configuredTargets.has(targetInfo.targetId)) return;
      configured.add(sessionId);
      configuredTargets.add(targetInfo.targetId);
      await configureSession(sessionId);
      console.log(`[+] new tab instrumented: ${targetInfo.url || targetInfo.targetId}`);
    });
  }

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  configured.add(sessionId);
  configuredTargets.add(targetId);
  await configureSession(sessionId);

  if (args.newTabs) {
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "page", exclude: false }],
    });
  }

  if (patterns.length === 0) {
    console.log(`[+] injecting on ALL requests, global mode: ${Object.keys(injected).join(", ")}`);
  } else {
    console.log(`[+] injecting on ${patterns.join(", ")}: ${Object.keys(injected).join(", ")}`);
  }

  // Resolves on the next page load; the fallback timer is cleared so a stray
  // 20s timer can never keep the process alive after we are done.
  function waitForLoad() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 20000);
      cdp.on("Page.loadEventFired", finish);
    });
  }

  async function load(target) {
    const loaded = waitForLoad();
    await cdp.send("Page.navigate", { url: target }, sessionId);
    await loaded;
    console.log(`[+] opened ${target}`);
  }

  await load(url);

  for (const step of args.then) {
    await sleep(1200);
    if (step === "reload") {
      const loaded = waitForLoad();
      await cdp.send("Page.reload", {}, sessionId);
      await loaded;
      console.log("[+] reloaded");
    } else {
      await load(step);
    }
  }

  // ---------------------------------------------------------------- lifeline
  // Everything above only works while this process (and its WebSocket) is alive.
  if (args.close) {
    console.log("[i] --close given, shutting the browser down");
    try { await cdp.send("Browser.close"); } catch { /* ignore */ }
    return;
  }

  if (args.wait) {
    console.log(`[i] staying attached for ${args.wait} ms, headers stay active`);
    await Promise.race([sleep(args.wait), cdp.closed]);
    console.log("[i] detaching now - injected headers no longer apply");
    cdp.close();
    return;
  }

  console.log("[i] headers stay active while this process runs. Press Ctrl+C to stop.");

  const stop = () => { cdp.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await cdp.closed; // browser window closed by the user -> we are done
  console.log("[i] browser closed, exiting");
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
