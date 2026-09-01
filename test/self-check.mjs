import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  matchesKey,
  ScrollView,
  Text,
} from "/home/eachann/.pi/agent/npm/node_modules/@earendil-works/pi-tui/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "extensions/rolling-process.ts"), "utf8");

function layout(view, contentHeight, viewportHeight) {
  view.updateLayout(contentHeight, viewportHeight, () => {});
}

// Pi follow-end re-latches if content shrinks back to the cursor.
{
  const view = new ScrollView(new Text("x"), { follow: "end" });
  layout(view, 200, 40);
  assert.equal(view.isFollowingEnd, true);
  view.scrollBy(-30);
  assert.equal(view.isFollowingEnd, false);
  layout(view, 170, 40);
  assert.equal(
    view.isFollowingEnd,
    true,
    "shrink must re-latch follow — this is why a transcript box breaks scroll",
  );
}

// Growing the transcript (insert process box) must not re-latch follow.
{
  const view = new ScrollView(new Text("x"), { follow: "end" });
  layout(view, 200, 40);
  view.scrollBy(-30);
  assert.equal(view.isFollowingEnd, false);
  layout(view, 208, 40);
  assert.equal(view.isFollowingEnd, false);
}

assert.doesNotMatch(src, /placement: "aboveEditor"/);
assert.match(src, /matchesKey\(data, "ctrl\+o"\)/);
assert.doesNotMatch(src, /setInterval/);
assert.doesNotMatch(src, /ToolExecutionComponent\.prototype/);
assert.doesNotMatch(src, /setWorkingVisible\(false\)/);
assert.doesNotMatch(src, /ensureNativeExpandRemap/);
assert.doesNotMatch(src, /AssistantMessageComponent/);
assert.match(src, /pi\.appendEntry/);
assert.match(src, /message_end/);

const handlers = new Map();
const uiCalls = [];
let renderer;
const pi = {
  appendEntry: (...args) => {
    uiCalls.push(["appendEntry", args]);
    return "e1";
  },
  registerEntryRenderer(_type, fn) {
    renderer = fn;
  },
  registerCommand() {},
  registerShortcut() {},
  on(name, fn) {
    handlers.set(name, fn);
  },
};

const require = createRequire(import.meta.url);
process.env.NODE_PATH = join(process.env.HOME, ".pi/agent/npm/node_modules");
require("module").Module._initPaths();

const ext = await import(
  join(root, "extensions/rolling-process.ts") + `?t=${Date.now()}`
);
const boot = ext.default;
assert.equal(typeof boot, "function");
boot(pi);

const theme = { fg: (_c, t) => t, bg: (_c, t) => t };
const ctx = {
  hasUI: true,
  ui: {
    notify: (msg) => uiCalls.push(["notify", msg]),
    setWidget: (...args) => uiCalls.push(["setWidget", ...args]),
    onTerminalInput: (fn) => {
      ctx._input = fn;
      return () => {};
    },
  },
};

function box(runId) {
  return renderer({ data: { runId } }, {}, theme);
}

handlers.get("session_start")({}, ctx);
assert.ok(ctx._input, "ctrl+o intercept must bind");
assert.equal(ctx._input("\x0f"), undefined, "idle ctrl+o is not consumed");
assert.equal(uiCalls.filter((c) => c[0] === "setWidget").length, 0);

handlers.get("agent_start")({}, ctx);
assert.equal(
  uiCalls.filter((c) => c[0] === "appendEntry").length,
  0,
  "agent_start must not insert before the user message",
);

handlers.get("message_end")({ message: { role: "user" } }, ctx);
assert.equal(
  uiCalls.filter((c) => c[0] === "appendEntry").length,
  1,
  "process box inserts after the user message",
);
const runId = uiCalls.find((c) => c[0] === "appendEntry")[1][1].runId;
const collapsed = box(runId).render(80);
assert.ok(collapsed.length >= 3);

const consumed = ctx._input("\x0f");
assert.equal(consumed?.consume, true);
assert.ok(matchesKey("\x0f", "ctrl+o"));
const expanded = box(runId).render(80);
assert.notEqual(expanded.length, collapsed.length, "ctrl+o must expand");

handlers.get("message_end")({ message: { role: "user" } }, ctx);
assert.equal(
  uiCalls.filter((c) => c[0] === "appendEntry").length,
  1,
  "same run must not insert twice",
);

handlers.get("agent_end")({}, ctx);
assert.equal(uiCalls.filter((c) => c[0] === "appendEntry").length, 1);
assert.equal(uiCalls.filter((c) => c[0] === "setWidget").length, 0);

console.log("self-check ok");
