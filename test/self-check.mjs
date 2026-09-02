/**
 * Self-check for extensions/rolling-process.ts
 *
 * Node v22.22.3: import .ts needs the experimental strip-types flag.
 * Run: node --experimental-strip-types test/self-check.mjs
 * This file re-invokes itself with that flag so `npm test` works on Node 22.6+.
 * Node 23+/24: node test/self-check.mjs
 * Older Node: load the extension via pi's bundled jiti.
 */
import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir, homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const { nodeMajor, nodeMinor } = parseNodeVersion();
const hasStripFlag = process.execArgv.some(
  (arg) =>
    arg === "--experimental-strip-types" ||
    arg.startsWith("--experimental-strip-types="),
);
const stripTypesMode = stripTypesSupport(nodeMajor, nodeMinor);

if (stripTypesMode === "flag" && !hasStripFlag) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", ...process.argv.slice(1)],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "extensions/rolling-process.ts"), "utf8");
const piAgentDir = findPiCodingAgent();
const piTuiDir = join(piAgentDir, "node_modules/@earendil-works/pi-tui");
assert.ok(existsSync(join(piTuiDir, "dist/index.js")), "pi-tui dist/index.js");

const nodePathEntries = [dirname(piAgentDir), join(piAgentDir, "node_modules")];
process.env.NODE_PATH = nodePathEntries.join(delimiter);
createRequire(import.meta.url)("module").Module._initPaths();
installBareSpecifierAliases(piAgentDir, piTuiDir);

isolateAgentDir();

const tui = await import(pathToFileURL(join(piTuiDir, "dist/index.js")).href);
const { Container, ScrollView, Text, visibleWidth, matchesKey } = tui;

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

assert.match(src, /"⠀⢀"/);
assert.match(src, /"⡀⠀"/);
assert.doesNotMatch(src, /placement: "aboveEditor"/);
assert.match(src, /matchesKey\(data, "ctrl\+o"\)/);
assert.match(src, /onTerminalInput/);
assert.doesNotMatch(src, /registerShortcut\("ctrl\+o",/);
assert.match(src, /ToolExecutionComponent\.prototype/);
assert.match(src, /AssistantMessageComponent\.prototype/);
assert.match(src, /compactAssistantText/);
assert.match(src, /assistantLineIcon/);
assert.match(src, /maxVisibleLines: 8/);
assert.doesNotMatch(src, /maxVisibleAssistantLines/);
assert.doesNotMatch(src, /process-assistant-lines/);
assert.doesNotMatch(src, /renderShell: "self"/);
assert.doesNotMatch(src, /createReadToolDefinition/);
assert.doesNotMatch(src, /registerMarkdownTransformer/);
assert.match(src, /pi\.appendEntry/);
assert.match(src, /message_end/);
assert.match(src, /clearInterval/);
assert.match(src, /appleLocaleMemo/);
assert.match(src, /SNAPSHOT_KEEP/);
assert.match(src, /THOUGHT_HEADING_MAX/);
assert.match(src, /renderCache/);
assert.doesNotMatch(src, /readAppleLocale\(\),\s*\]/);

const TUI_PROBE_KEY = "pi-rolling-process-tui-probe";

const intervalFns = [];
let setIntervalCalls = 0;
let clearIntervalCalls = 0;
let activeIntervals = 0;
globalThis.setInterval = (fn, _ms, ...args) => {
  setIntervalCalls += 1;
  activeIntervals += 1;
  const wrapped = () => fn(...args);
  intervalFns.push(wrapped);
  return { unref() {} };
};
globalThis.clearInterval = (_id) => {
  clearIntervalCalls += 1;
  if (activeIntervals > 0) activeIntervals -= 1;
};

const handlers = new Map();
const shortcuts = new Map();
const uiCalls = [];
const workingVisibleCalls = [];
const hiddenThinkingLabelCalls = [];
let renderer;
let lastEntry;
let requestRenderCount = 0;
let widgetComponent;
const widgets = new Map();

const theme = {
  fg: (c, t) => `\u0001${c}\u0002${t}\u0003`,
  bg: (_c, t) => t,
  bold: (t) => t,
};

const fakeTui = {
  requestRender() {
    requestRenderCount += 1;
  },
};

const pi = {
  appendEntry(_type, data) {
    lastEntry = { data };
    uiCalls.push(["appendEntry", data]);
    return "e1";
  },
  registerEntryRenderer(_type, fn) {
    renderer = fn;
  },
  registerCommand() {},
  registerShortcut(id, opts) {
    shortcuts.set(id, opts);
  },
  registerTool() {},
  on(name, fn) {
    handlers.set(name, fn);
  },
};

const ext = await loadExtension(join(root, "extensions/rolling-process.ts"));
const boot = ext.default;
assert.equal(typeof boot, "function");
boot(pi);

const { AssistantMessageComponent, ToolExecutionComponent } = await import(
  "@earendil-works/pi-coding-agent"
);
{
  const fake = Object.create(ToolExecutionComponent.prototype);
  fake.expanded = false;
  assert.deepEqual(fake.render(80), []);
}

// Patched: shrinking content while scrolled up must not re-latch follow.
{
  const view = new ScrollView(new Text("x"), { follow: "end" });
  layout(view, 200, 40);
  assert.equal(view.isFollowingEnd, true);
  view.scrollBy(-30);
  assert.equal(view.isFollowingEnd, false);
  layout(view, 170, 40);
  assert.equal(
    view.isFollowingEnd,
    false,
    "patched: shrink to cursor must not re-latch follow",
  );
  assert.equal(view.scrollTop, 130);
  layout(view, 150, 40);
  assert.equal(
    view.isFollowingEnd,
    false,
    "patched: repeated shrink must not re-latch follow",
  );
}

// Patched: user scrolling back to the bottom still re-latches follow.
{
  const view = new ScrollView(new Text("x"), { follow: "end" });
  layout(view, 200, 40);
  view.scrollBy(-30);
  assert.equal(view.isFollowingEnd, false);
  view.scrollBy(30);
  assert.equal(view.isFollowingEnd, true, "scrollBy to end must re-latch");
  layout(view, 170, 40);
  assert.equal(view.isFollowingEnd, true);
}

// Patch is idempotent across extension reloads.
{
  const wrapped = ScrollView.prototype.updateLayout;
  const dummyPi = {
    appendEntry() {
      return "x";
    },
    registerEntryRenderer() {},
    registerCommand() {},
    registerShortcut() {},
    registerTool() {},
    on() {},
  };
  const extReload = await loadExtension(join(root, "extensions/rolling-process.ts"));
  extReload.default(dummyPi);
  assert.equal(
    ScrollView.prototype.updateLayout,
    wrapped,
    "updateLayout must not be wrapped twice",
  );
}

const ctx = {
  hasUI: true,
  cwd: process.cwd(),
  ui: {
    theme,
    setWorkingVisible(v) {
      workingVisibleCalls.push(v);
    },
    setHiddenThinkingLabel(v) {
      hiddenThinkingLabelCalls.push(v);
    },
    notify: (msg) => uiCalls.push(["notify", msg]),
    setWidget: (key, content) => {
      uiCalls.push(["setWidget", key]);
      if (content === undefined) {
        widgets.delete(key);
        return;
      }
      if (typeof content === "function") {
        widgetComponent = content(fakeTui, theme);
        widgets.set(key, widgetComponent);
      }
    },
    onTerminalInput: (fn) => {
      ctx._input = fn;
      return () => {};
    },
  },
};

function emit(name, event) {
  const fn = handlers.get(name);
  assert.ok(fn, `missing handler: ${name}`);
  return fn(event, ctx);
}

{
  const ASSISTANT_COMPACT_GETTER = Symbol.for(
    "pi-rolling-process.assistantCompactGetter",
  );
  const ASSISTANT_ICON_GETTER = Symbol.for(
    "pi-rolling-process.assistantLineIconGetter",
  );
  const weatherBlock = src.match(
    /const ASSISTANT_WEATHER_ICONS = \[([\s\S]*?)\];/,
  );
  const weatherIcons = [...(weatherBlock?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(weatherIcons.length >= 4, "weather icon sequence");
  const weatherPrefix = (i) => ` ${weatherIcons[i % weatherIcons.length]}  `;
  const sampleLines = ["hello", "", "  ", "\x1b[32m  \x1b[0m", "world"];
  const compactExpected = [
    `${weatherPrefix(0)}hello`,
    `${weatherPrefix(1)}world`,
  ];
  const origContainerRender = Container.prototype.render;
  const renderAssistant = (lines, hasToolCalls = false) => {
    Container.prototype.render = () => lines.slice();
    try {
      const fake = Object.create(AssistantMessageComponent.prototype);
      fake.hasToolCalls = hasToolCalls;
      return fake
        .render(80)
        .map((l) => l.replace(/\x1b\]133;[ABC]\x07/g, ""));
    } finally {
      Container.prototype.render = origContainerRender;
    }
  };

  // Intermediate messages (with toolCalls) move into the process box.
  assert.deepEqual(
    renderAssistant(sampleLines, true),
    [],
    "intermediate assistant message must render nothing in transcript",
  );
  // Final answers keep the compact weather prefix.
  assert.deepEqual(renderAssistant(sampleLines), compactExpected);

  {
    const width = 20;
    let seenWidth;
    Container.prototype.render = (w) => {
      seenWidth = w;
      return ["x".repeat(w)];
    };
    try {
      const fake = Object.create(AssistantMessageComponent.prototype);
      fake.hasToolCalls = false;
      const out = fake.render(width);
      assert.equal(seenWidth, width - visibleWidth(weatherPrefix(0)));
      assert.ok(out.length >= 1);
      assert.ok(
        visibleWidth(out[0]) <= width,
        `compact assistant line ${visibleWidth(out[0])} > ${width}: ${out[0]}`,
      );
    } finally {
      Container.prototype.render = origContainerRender;
    }
  }

  const proto = AssistantMessageComponent.prototype;
  const prevGetter = proto[ASSISTANT_COMPACT_GETTER];
  proto[ASSISTANT_COMPACT_GETTER] = () => false;
  try {
    assert.deepEqual(renderAssistant(sampleLines), sampleLines);
    assert.deepEqual(
      renderAssistant(sampleLines, true),
      sampleLines,
      "compact off (e.g. /process-native off style) must restore native render",
    );
  } finally {
    proto[ASSISTANT_COMPACT_GETTER] = prevGetter;
  }

  const prevIcon = proto[ASSISTANT_ICON_GETTER];
  proto[ASSISTANT_ICON_GETTER] = () => "";
  try {
    assert.deepEqual(renderAssistant(sampleLines), ["hello", "world"]);
  } finally {
    proto[ASSISTANT_ICON_GETTER] = prevIcon;
  }

  // Legacy configs may store the icon with VS16; it must still cycle.
  proto[ASSISTANT_ICON_GETTER] = () => "☀️";
  try {
    assert.deepEqual(
      renderAssistant(sampleLines),
      compactExpected,
      "VS16 weather icon from old config must still be treated as cycle",
    );
  } finally {
    proto[ASSISTANT_ICON_GETTER] = prevIcon;
  }

  const renderOnce = AssistantMessageComponent.prototype.render;
  const dummyPi = {
    appendEntry() {
      return "x";
    },
    registerEntryRenderer() {},
    registerCommand() {},
    registerShortcut() {},
    registerTool() {},
    on() {},
  };
  const ext2 = await loadExtension(join(root, "extensions/rolling-process.ts"));
  ext2.default(dummyPi);
  assert.equal(AssistantMessageComponent.prototype.render, renderOnce);
  assert.deepEqual(renderAssistant(sampleLines), compactExpected);
}

assert.doesNotMatch(src, /assistantFoldRuns|foldAssistantWindow/);

function stripRenderDecorations(line) {
  let out = line;
  for (let i = 0; i < 256 && /\u0001[^\u0002]+\u0002/.test(out); i++) {
    const next = out.replace(/\u0001([^\u0002]+)\u0002([^\u0003]*)\u0003/, "$2");
    if (next === out) break;
    out = next;
  }
  return out.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLineWidth(line) {
  return visibleWidth(stripRenderDecorations(line));
}

function collapsedRender(width) {
  assert.ok(renderer, "registerEntryRenderer must run");
  assert.ok(lastEntry, "appendEntry must have created an entry");
  const comp = renderer(lastEntry, { expanded: false }, theme);
  const lines = comp.render(width);
  assert.ok(Array.isArray(lines), `render(${width}) must return string[]`);
  for (const line of lines) {
    assert.ok(
      visibleLineWidth(line) <= width,
      `visibleWidth ${visibleLineWidth(line)} > ${width}: ${line}`,
    );
  }
  return lines;
}

function collapsedLines() {
  return collapsedRender(80);
}

function stripBoxChrome(line) {
  return line.replace(/^[│║]/u, "").replace(/[│║]$/u, "");
}

function prefixVisibleWidth(line, mark) {
  const plain = stripRenderDecorations(stripBoxChrome(line));
  const idx = plain.indexOf(mark);
  assert.ok(idx >= 0, `mark ${mark} not in: ${plain}`);
  return visibleWidth(plain.slice(0, idx));
}

function recordHeight(heights) {
  heights.push(collapsedLines().length);
}

function assertLineHasColoredSubstring(line, substring, color) {
  const idx = line.indexOf(substring);
  assert.ok(idx >= 0, `substring ${substring} not in: ${line}`);
  for (const m of line.matchAll(/\u0001([^\u0002]+)\u0002([^\u0003]*)\u0003/g)) {
    if (m[2].includes(substring)) {
      assert.equal(
        m[1],
        color,
        `expected color ${color} for ${substring}, got ${m[1]}`,
      );
      return;
    }
  }
  assert.fail(`no fg wrapper for ${substring}`);
}

function findStepLine(lines, needle) {
  const line = lines.find((l) => l.includes(needle));
  assert.ok(line, `no line containing ${needle}`);
  return line;
}

emit("session_start", { type: "session_start", reason: "startup" });
assert.ok(
  workingVisibleCalls.includes(false),
  "session_start must call setWorkingVisible(false)",
);
assert.ok(
  hiddenThinkingLabelCalls.includes(""),
  'session_start must call setHiddenThinkingLabel("")',
);
assert.ok(
  uiCalls.some((c) => c[0] === "setWidget"),
  "session_start must call setWidget",
);
assert.ok(widgetComponent, "setWidget factory must be called");
assert.deepEqual(widgetComponent.render(), [], "probe widget render() must be []");
if (
  /function captureTui[\s\S]{0,800}setWidget\(\s*TUI_PROBE_KEY\s*,\s*undefined\s*\)/.test(
    src,
  )
) {
  assert.ok(
    !widgets.has(TUI_PROBE_KEY),
    "probe widget must be removed after captureTui",
  );
} else {
  console.log(
    "skip probe-removed assertion: source has no setWidget(TUI_PROBE_KEY, undefined) in captureTui yet",
  );
}

assert.equal(
  uiCalls.filter((c) => c[0] === "appendEntry").length,
  0,
  "session_start must not appendEntry",
);

emit("agent_start", { type: "agent_start" });
assert.equal(
  uiCalls.filter((c) => c[0] === "appendEntry").length,
  0,
  "agent_start must not insert before the user message",
);
assert.ok(setIntervalCalls >= 1, "agent_start must start a spinner interval");
assert.ok(intervalFns.length >= 1, "an interval callback must be active");
const spinnerTick = intervalFns.at(-1);

const rendersBeforeTick = requestRenderCount;
for (const fn of intervalFns) fn();
await Promise.resolve();
assert.ok(
  requestRenderCount > rendersBeforeTick,
  "interval callback must call requestRender",
);

emit("message_end", { type: "message_end", message: { role: "user" } });
assert.equal(
  uiCalls.filter((c) => c[0] === "appendEntry").length,
  1,
  "process box inserts after the user message",
);

const heights = [];
recordHeight(heights);

emit("tool_execution_start", {
  type: "tool_execution_start",
  toolName: "read",
  toolCallId: "c1",
  args: { path: "/Users/x/.agents/skills/browser-use/SKILL.md" },
});
recordHeight(heights);

emit("tool_execution_end", {
  type: "tool_execution_end",
  toolCallId: "c1",
  isError: false,
  result: { content: [{ type: "text", text: "hello" }] },
});
recordHeight(heights);

emit("tool_execution_start", {
  type: "tool_execution_start",
  toolName: "subagent",
  toolCallId: "c2",
  args: { action: "list" },
});
recordHeight(heights);

emit("tool_execution_end", {
  type: "tool_execution_end",
  toolCallId: "c2",
  isError: false,
  result: { content: [{ type: "text", text: "ok" }] },
});
recordHeight(heights);

emit("tool_execution_start", {
  type: "tool_execution_start",
  toolName: "some_mcp_tool",
  toolCallId: "c3",
  args: {},
});
recordHeight(heights);

emit("tool_execution_end", {
  type: "tool_execution_end",
  toolCallId: "c3",
  isError: false,
  result: { content: [{ type: "text", text: "mcp" }] },
});
recordHeight(heights);

emit("tool_execution_start", {
  type: "tool_execution_start",
  toolName: "bash",
  toolCallId: "c4",
  args: { command: "ls" },
});
recordHeight(heights);

emit("tool_execution_end", {
  type: "tool_execution_end",
  toolCallId: "c4",
  isError: false,
  result: { content: [{ type: "text", text: "x\ny\nz" }] },
});
recordHeight(heights);

emit("message_update", {
  type: "message_update",
  message: { role: "assistant" },
  assistantMessageEvent: {
    type: "thinking_delta",
    delta: "Considering the approach in detail",
  },
});
recordHeight(heights);

emit("message_end", {
  type: "message_end",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "先读文档\n第二行" },
      {
        type: "toolCall",
        id: "c5",
        name: "read",
        arguments: { path: "a" },
      },
    ],
  },
});
recordHeight(heights);

emit("message_end", {
  type: "message_end",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "甲\n\n乙\n  \n丙" },
      {
        type: "toolCall",
        id: "c6",
        name: "read",
        arguments: { path: "b" },
      },
    ],
  },
});
recordHeight(heights);

const heightBeforeTextOnly = heights.at(-1);
emit("message_end", {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "仅文本，无 toolCall" }],
  },
});
recordHeight(heights);
assert.equal(
  heights.at(-1),
  heightBeforeTextOnly,
  "assistant message_end with text-only must not add lines",
);

const heightBeforeEnd = heights.at(-1);
emit("agent_end", { type: "agent_end", messages: [] });
recordHeight(heights);

for (let i = 1; i < heights.length; i++) {
  assert.ok(
    heights[i] >= heights[i - 1],
    `collapsed height dropped ${heights[i - 1]} → ${heights[i]} at step ${i}`,
  );
}
assert.ok(
  heights.at(-1) >= heightBeforeEnd,
  "agent_end must not shrink collapsed height",
);
assert.ok(clearIntervalCalls >= 1, "agent_end must clearInterval");

const clearsAfterEnd = clearIntervalCalls;
assert.doesNotThrow(() => spinnerTick(), "stale interval after agent_end");
assert.ok(
  clearIntervalCalls >= clearsAfterEnd,
  "clearInterval count must not decrease after stale tick",
);

const lines80 = collapsedLines();
assert.doesNotMatch(
  lines80[0] ?? "",
  /已折叠|\bhidden\b/,
  "collapsed header must not show hidden-step count",
);
for (const width of [12, 20, 40]) {
  let lines;
  assert.doesNotThrow(() => {
    lines = collapsedRender(width);
  }, `render(${width}) must not throw`);
  assert.equal(
    lines.length,
    lines80.length,
    `collapsed line count at width ${width} must match render(80)`,
  );
}

{
  const skillNeedle = lines80.some((l) => l.includes("技能")) ? "技能" : "skill";
  const skillLine = findStepLine(lines80, skillNeedle);
  assertLineHasColoredSubstring(skillLine, skillNeedle, "success");

  const subNeedle = lines80.some((l) => l.includes("子代理"))
    ? "子代理"
    : "subagent";
  const subLine = findStepLine(lines80, subNeedle);
  assertLineHasColoredSubstring(subLine, subNeedle, "accent");

  const mcpLine = findStepLine(lines80, "some_mcp_tool");
  assertLineHasColoredSubstring(mcpLine, "some_mcp_tool", "success");

  const bashNeedle = lines80.some((l) => l.includes("命令")) ? "命令" : "bash";
  const bashLine = findStepLine(lines80, bashNeedle);
  assertLineHasColoredSubstring(bashLine, bashNeedle, "muted");

  const noteLine = lines80.find(
    (l) =>
      (l.includes("说明") || l.includes("note")) && l.includes("先读文档"),
  );
  assert.ok(
    noteLine,
    "assistant message_end must render a note line with 先读文档",
  );
  const noteLabel = noteLine.includes("说明") ? "说明" : "note";
  assertLineHasColoredSubstring(noteLine, noteLabel, "warning");

  // Each non-empty line of an intermediate message becomes its own note step.
  const noteTextOf = (needle) =>
    lines80.find(
      (l) =>
        (l.includes("说明") || l.includes("note")) && l.includes(needle),
    );
  const noteSecond = noteTextOf("第二行");
  assert.ok(noteSecond, "second line must become its own note step");
  const noteJia = noteTextOf("甲");
  const noteYi = noteTextOf("乙");
  const noteBing = noteTextOf("丙");
  assert.ok(noteJia && noteYi && noteBing, "3 non-empty lines → 3 note steps");
  const noteOrder = [noteJia, noteYi, noteBing].map((l) =>
    lines80.indexOf(l),
  );
  assert.ok(
    noteOrder[0] < noteOrder[1] && noteOrder[1] < noteOrder[2],
    "note steps must keep line order",
  );

  // Note steps rotate weather icons (not ✅) with a consistent prefix width.
  const weatherIcons = [
    ...(src
      .match(/const ASSISTANT_WEATHER_ICONS = \[([\s\S]*?)\];/)?.[1] ?? "")
      .matchAll(/"([^"]+)"/g),
  ].map((m) => m[1]);
  for (const icon of weatherIcons) {
    assert.equal(
      visibleWidth(icon),
      2,
      `weather icon must measure 2 columns: ${icon}`,
    );
  }
  // padIcon pads every icon to the same column, whatever its bare width.
  const padded = new Set(
    weatherIcons.map(
      (icon) =>
        visibleWidth(
          ` ${icon}${" ".repeat(Math.max(0, 2 - visibleWidth(icon)))}`,
        ),
    ),
  );
  assert.equal(padded.size, 1, "padded weather icons must share one width");
  const noteLines = [noteLine, noteSecond, noteJia, noteYi, noteBing];
  for (const l of noteLines) {
    assert.ok(
      weatherIcons.some((icon) => l.includes(icon)),
      `note step must use a weather icon: ${l}`,
    );
    assert.ok(!l.includes("✅"), `note step must not use ✅: ${l}`);
  }
  const prefixWidths = noteLines.map((l) => prefixVisibleWidth(l, noteLabel));
  assert.ok(
    prefixWidths.every((w) => w === prefixWidths[0]),
    `note icon columns must align: ${prefixWidths}`,
  );
}

{
  const intervalsBefore = setIntervalCalls;
  const clearsBefore = clearIntervalCalls;
  emit("agent_start", { type: "agent_start" });
  assert.ok(
    setIntervalCalls > intervalsBefore,
    "second agent_start must start an interval",
  );
  assert.ok(activeIntervals >= 1, "interval must be active after agent_start");
  emit("session_shutdown", { type: "session_shutdown" });
  assert.ok(
    clearIntervalCalls > clearsBefore,
    "session_shutdown must clearInterval",
  );
  assert.equal(activeIntervals, 0, "session_shutdown must leave no interval");
  emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(
    activeIntervals,
    0,
    "session_start after shutdown must leave no leftover interval",
  );
}

assert.doesNotMatch(src, /working:\s*"/);

{
  const doneLine = lines80.find(
    (line) =>
      line.includes("✅") && (line.includes("完成") || line.includes("Done")),
  );
  const stepLine = lines80.find(
    (line) =>
      line.includes("✅") &&
      !line.includes("完成") &&
      !line.includes("Done"),
  );
  assert.ok(doneLine, "collapsed render must include a done status line");
  assert.ok(stepLine, "collapsed render must include a step line");
  assert.equal(
    prefixVisibleWidth(doneLine, "✅"),
    prefixVisibleWidth(stepLine, "✅"),
    "status and step text should start at the same visible column",
  );
}

{
  const snapPath = join(
    process.env.PI_CODING_AGENT_DIR,
    "rolling-process-runs.json",
  );
  assert.ok(existsSync(snapPath), "agent_end must write run snapshots");
  const snapRaw = readFileSync(snapPath, "utf8");
  assert.match(snapRaw, /^\{"runs":/);
  assert.doesNotMatch(
    snapRaw,
    /\n  "/,
    "snapshots must be compact JSON, not pretty-printed",
  );
}

{
  emit("agent_start", { type: "agent_start" });
  emit("message_end", {
    type: "message_end",
    message: { role: "user" },
  });
  emit("message_update", {
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_start" },
  });
  const flood = "x".repeat(4000);
  for (let i = 0; i < 40; i++) {
    emit("message_update", {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: flood },
    });
  }
  emit("message_update", {
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_end" },
  });
  for (let i = 0; i < 24; i++) {
    emit("tool_execution_start", {
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: `flood-${i}`,
      args: { command: `echo ${i} ${"n".repeat(400)}` },
    });
    emit("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: `flood-${i}`,
      isError: false,
      result: { content: [{ type: "text", text: "ok" }] },
    });
  }
  emit("agent_end", { type: "agent_end", messages: [] });
  const entryMany = lastEntry;
  const collapsedMany = renderer(entryMany, { expanded: false }, theme).render(
    80,
  );
  assert.ok(
    collapsedMany.length < 30,
    `collapsed flood run should stay short, got ${collapsedMany.length}`,
  );

  const t0 = performance.now();
  for (let i = 0; i < 80; i++) {
    renderer(entryMany, { expanded: false }, theme).render(80);
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 400, `80 cached collapsed renders took ${ms}ms`);

  // state.runId is "" after agent_end: ctrl+o targets the last process entry.
  {
    assert.equal(typeof ctx._input, "function", "ctrl+o input binding");
    const collapsedLen = renderer(entryMany, { expanded: false }, theme).render(
      80,
    ).length;
    ctx._input("\x0f");
    const expandedLen = renderer(entryMany, { expanded: false }, theme).render(
      80,
    ).length;
    assert.ok(
      expandedLen > collapsedLen,
      "ctrl+o with empty runId must expand the last process entry",
    );
    ctx._input("\x0f");
    assert.equal(
      renderer(entryMany, { expanded: false }, theme).render(80).length,
      collapsedLen,
      "second ctrl+o must restore the collapsed state",
    );
  }

  emit("agent_start", { type: "agent_start" });
  emit("message_end", {
    type: "message_end",
    message: { role: "user" },
  });
  emit("tool_execution_start", {
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "live-1",
    args: { command: "true" },
  });
  const entryLive = lastEntry;
  const liveComp = renderer(entryLive, { expanded: false }, theme);
  const realDateNow = Date.now;
  const fixedNow = 1_700_000_000_000;
  Date.now = () => fixedNow;
  const liveRender1 = liveComp.render(80);
  const liveRender2 = liveComp.render(80);
  assert.deepEqual(
    liveRender2,
    liveRender1,
    "consecutive live renders must match with fixed Date.now",
  );
  liveComp.invalidate();
  const liveRenderAfterInvalidate = liveComp.render(80);
  assert.deepEqual(
    liveRenderAfterInvalidate,
    liveRender1,
    "live render after invalidate must match hot-path cache",
  );
  emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "live-1",
    isError: false,
    result: { content: [{ type: "text", text: "live-result-ok" }] },
  });
  const liveRender3 = liveComp.render(80);
  assert.ok(
    liveRender3.length >= liveRender1.length,
    "tool end must not shrink live render height",
  );
  assert.ok(
    liveRender3.some((line) => line.includes("live-result-ok")),
    "tool_execution_end must show resultSummary in render output",
  );
  emit("tool_execution_start", {
    type: "tool_execution_start",
    toolName: "read",
    toolCallId: "live-2",
    args: { path: "x.ts" },
  });
  const liveRender4 = liveComp.render(80);
  assert.ok(
    liveRender4.length > liveRender3.length,
    "new tool_execution_start must increase live render line count",
  );
  Date.now = realDateNow;

  assert.ok(matchesKey("\x0f", "ctrl+o"), "ctrl+o must match \\x0f");
  const toggle = () => ctx._input("\x0f");
  const beforeHist = renderer(entryMany, { expanded: false }, theme).render(80)
    .length;
  const beforeLive = renderer(entryLive, { expanded: false }, theme).render(80);
  toggle();
  const afterHist = renderer(entryMany, { expanded: false }, theme).render(80)
    .length;
  assert.equal(
    afterHist,
    beforeHist,
    "ctrl+o must expand only the current run, not historical blocks",
  );
  const liveExpanded = renderer(entryLive, { expanded: false }, theme).render(
    80,
  );
  assert.ok(
    liveExpanded.some((line) => line.includes("true") || line.includes("$")),
    "current run must still render after ctrl+o",
  );
  toggle();
  assert.equal(
    renderer(entryLive, { expanded: false }, theme).render(80).length,
    beforeLive.length,
    "second ctrl+o must collapse back to the original state",
  );
  emit("agent_end", { type: "agent_end", messages: [] });
}

console.log("self-check ok");

function parseNodeVersion() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  return { nodeMajor: maj, nodeMinor: min };
}

function stripTypesSupport(maj, min) {
  if (maj >= 23) return "default";
  if (maj === 22 && min >= 6) return "flag";
  return "none";
}

function isPiCodingAgentDir(dir) {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    return (
      JSON.parse(readFileSync(pkgPath, "utf8")).name ===
      "@earendil-works/pi-coding-agent"
    );
  } catch {
    return false;
  }
}

function walkToPi(start) {
  let dir = start;
  for (;;) {
    if (isPiCodingAgentDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findPiCodingAgent() {
  try {
    const which = execSync("which pi", { encoding: "utf8" }).trim();
    if (which) {
      const found = walkToPi(dirname(realpathSync(which)));
      if (found) return found;
    }
  } catch {
    // fall through
  }

  try {
    const npmRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    const candidate = join(npmRoot, "@earendil-works", "pi-coding-agent");
    if (isPiCodingAgentDir(candidate)) return candidate;
  } catch {
    // fall through
  }

  const fallback = join(
    homedir(),
    ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent",
  );
  if (isPiCodingAgentDir(fallback)) return fallback;

  throw new Error("cannot locate @earendil-works/pi-coding-agent");
}

function installBareSpecifierAliases(agentDir, tuiDir) {
  const agentUrl = pathToFileURL(join(agentDir, "dist/index.js")).href;
  const tuiUrl = pathToFileURL(join(tuiDir, "dist/index.js")).href;
  const src = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-coding-agent") {
    return { shortCircuit: true, url: ${JSON.stringify(agentUrl)} };
  }
  if (specifier === "@earendil-works/pi-tui") {
    return { shortCircuit: true, url: ${JSON.stringify(tuiUrl)} };
  }
  return nextResolve(specifier, context);
}
`;
  register(`data:text/javascript,${encodeURIComponent(src)}`, import.meta.url);
}

function isolateAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-rolling-self-check-"));
  writeFileSync(
    join(dir, "rolling-process.json"),
    `${JSON.stringify({ hideNativeTools: true, maxVisibleLines: 20 }, null, 2)}\n`,
    "utf8",
  );
  process.env.PI_CODING_AGENT_DIR = dir;
}

async function loadExtension(extPath) {
  if (stripTypesMode !== "none") {
    return import(pathToFileURL(extPath).href + `?t=${Date.now()}`);
  }

  const jitiEntry = join(piAgentDir, "node_modules/jiti/lib/jiti.mjs");
  assert.ok(existsSync(jitiEntry), `jiti missing at ${jitiEntry}`);
  const { createJiti } = await import(pathToFileURL(jitiEntry).href);
  const jiti = createJiti(import.meta.url);
  return jiti.import(extPath);
}
