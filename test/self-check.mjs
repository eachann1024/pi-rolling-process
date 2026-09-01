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

// Our docked widget does not change transcript height, so follow stays off.
{
  const view = new ScrollView(new Text("x"), { follow: "end" });
  layout(view, 200, 40);
  view.scrollBy(-30);
  assert.equal(view.isFollowingEnd, false);
  layout(view, 200, 40);
  assert.equal(view.isFollowingEnd, false);
}

assert.match(src, /placement: "aboveEditor"/);
assert.match(src, /matchesKey\(data, "ctrl\+o"\)/);
assert.doesNotMatch(src, /setInterval/);
assert.doesNotMatch(src, /ToolExecutionComponent\.prototype/);
assert.doesNotMatch(src, /setWorkingVisible\(false\)/);
assert.doesNotMatch(src, /ensureNativeExpandRemap/);
assert.doesNotMatch(src, /AssistantMessageComponent/);
assert.doesNotMatch(src, /pi\.appendEntry/);
assert.match(src, /setWidget\(LIVE_WIDGET, undefined\)/);

const handlers = new Map();
const uiCalls = [];
let widget;
const pi = {
  appendEntry: (...args) => uiCalls.push(["appendEntry", args]),
  registerEntryRenderer() {},
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

const ctx = {
  hasUI: true,
  ui: {
    notify: (msg) => uiCalls.push(["notify", msg]),
    setWidget: (key, factory, opts) => {
      uiCalls.push(["setWidget", key, Boolean(factory), opts]);
      widget = factory
        ? factory(
            {},
            {
              fg: (_c, t) => t,
              bg: (_c, t) => t,
            },
          )
        : undefined;
    },
    onTerminalInput: (fn) => {
      uiCalls.push(["onTerminalInput"]);
      ctx._input = fn;
      return () => {};
    },
  },
};

handlers.get("session_start")({}, ctx);
assert.ok(ctx._input, "ctrl+o intercept must bind");
assert.equal(widget, undefined, "no empty box before a run");
assert.equal(ctx._input("\x0f"), undefined, "idle ctrl+o is not consumed");

handlers.get("agent_start")({}, ctx);
assert.ok(widget, "widget mounts on agent_start");
const collapsed = widget.render(80);
assert.ok(collapsed.length >= 3);

const consumed = ctx._input("\x0f");
assert.equal(consumed?.consume, true);
assert.ok(matchesKey("\x0f", "ctrl+o"));
assert.ok(
  uiCalls.some((c) => c[0] === "notify"),
  "ctrl+o must notify/toggle",
);
const expanded = widget.render(80);
assert.notEqual(
  expanded.length,
  collapsed.length,
  "ctrl+o must change box height",
);

handlers.get("agent_end")({}, ctx);
assert.equal(widget, undefined, "widget unmounts after agent_end");
assert.equal(uiCalls.filter((c) => c[0] === "appendEntry").length, 0);

console.log("self-check ok");
