import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";

const root = new URL("..", import.meta.url);
const sourcePath = new URL("../extensions/rolling-process.ts", import.meta.url);
const src = readFileSync(sourcePath, "utf8");
assert.match(src, /const DEFAULT_MAX_RECORDS = 6/);
assert.match(src, /pi\.appendEntry\(ENTRY_TYPE, entry\)/);
assert.match(src, /matchesKey\(data, "ctrl\+o"\)/);
assert.match(src, /registerCommand\("process"/);
assert.match(src, /registerCommand\("process-native"/);
assert.doesNotMatch(src, /aboveEditor|belowEditor|setWidget\(.*placement/s);
assert.doesNotMatch(src, /emoji|✅|📋|⚡|⏳|🔄/iu);

const agentDir = mkdtempSync(join(tmpdir(), "rolling-process-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const handlers = new Map();
const commands = new Map();
const transcript = [];
const entries = [];
let input;
const uiCalls = { working: [], thinking: [], tools: [], colors: [] };
const ui = {
  setWorkingVisible(value) { uiCalls.working.push(value); },
  setHiddenThinkingLabel(value) { uiCalls.thinking.push(value); }, notify() {},
  getToolsExpanded() { return false; },
  setToolsExpanded(value) { uiCalls.tools.push(value); },
  setWidget() {},
  onTerminalInput(fn) { input = fn; return () => {}; },
};
const pi = {
  on(name, fn) { handlers.set(name, fn); },
  registerCommand(name, command) { commands.set(name, command); },
  registerEntryRenderer(_name, renderer) { pi.renderer = renderer; },
  appendEntry(type, data) { const entry = { type, data }; entries.push(entry); transcript.push(entry); },
};
const piRoot = "/Users/eachann/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const tuiRoot = `${piRoot}/node_modules/@earendil-works/pi-tui`;
const piTestModule = `
export { getAgentDir } from ${JSON.stringify(pathToFileURL(`${piRoot}/dist/config.js`).href)};
export { AssistantMessageComponent } from ${JSON.stringify(pathToFileURL(`${piRoot}/dist/modes/interactive/components/assistant-message.js`).href)};
export { ToolExecutionComponent } from ${JSON.stringify(pathToFileURL(`${piRoot}/dist/modes/interactive/components/tool-execution.js`).href)};
export { initTheme } from ${JSON.stringify(pathToFileURL(`${piRoot}/dist/modes/interactive/theme/theme.js`).href)};
`;
const piTestUrl = `data:text/javascript,${encodeURIComponent(piTestModule)}`;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n){if(s==='@earendil-works/pi-coding-agent')return {shortCircuit:true,url:${JSON.stringify("__PI_TEST_URL__")}.replace('__PI_TEST_URL__',${JSON.stringify(piTestUrl)})};if(s==='@earendil-works/pi-tui')return {shortCircuit:true,url:${JSON.stringify(pathToFileURL(`${tuiRoot}/dist/index.js`).href)}};return n(s,c)}`)}`, import.meta.url);
const ext = await import(pathToFileURL(sourcePath.pathname).href + `?${Date.now()}`);
ext.default(pi);
const ctx = { ui, getContextUsage() { return undefined; } };
const emit = (name, event) => handlers.get(name)(event, ctx);
const theme = { fg: (color, text) => { uiCalls.colors.push(color); return text; } };

emit("session_start", { type: "session_start" });
assert.deepEqual(uiCalls.working, [false], "session start applies the native Working setting");
assert.deepEqual(uiCalls.thinking, [""], "session start applies the native Thinking setting");
assert.deepEqual(uiCalls.tools, [false], "session start hides native tool cards by default");
// Native tool card patch: installed on the shared ToolExecutionComponent
// prototype; hidden must render [] and visible must delegate to the original.
const { ToolExecutionComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");
const NATIVE_TOOL_PATCH = Symbol.for("pi-rolling-process.native-tool-patch");
const nativePatch = ToolExecutionComponent.prototype[NATIVE_TOOL_PATCH];
assert.ok(nativePatch, "native tool card patch is installed on the shared prototype");
assert.equal(nativePatch.hidden, true, "native tool cards are hidden by default");
const toolComponent = new ToolExecutionComponent("read", "tc-native", { path: "file.ts" }, {}, undefined, {}, "/tmp");
assert.deepEqual(toolComponent.render(100), [], "hidden native tool card renders as []");
// A: a text-only turn has no inserted entry or whitespace-producing widget.
emit("agent_start", { type: "agent_start" });
emit("agent_end", { type: "agent_end" });
assert.equal(entries.length, 0, "A conversation must not insert a process entry without events");

// B: model the observable transcript ordering: user → process entry → final assistant reply.
transcript.push({ type: "user", content: "inspect the repository" });
emit("agent_start", { type: "agent_start" });
emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "file.ts" } });
assert.equal(entries.length, 1, "B conversation inserts an entry only when it has content");
assert.equal(entries[0].type, "pi-rolling-process");
transcript.push({ type: "assistant", content: "final answer" });
assert.deepEqual(transcript.map((entry) => entry.type), ["user", "pi-rolling-process", "assistant"], "process entry is between user and final assistant messages");
for (let i = 2; i <= 8; i++) {
  emit("tool_execution_start", { type: "tool_execution_start", toolCallId: String(i), toolName: i === 3 ? "some_mcp_tool" : "bash", args: i === 8 ? { command: "npm test" } : {} });
  emit("tool_execution_end", { type: "tool_execution_end", toolCallId: String(i), toolName: "bash", isError: false, result: {} });
}
let lines = pi.renderer(entries[0], { expanded: false }, theme).render(100);
assert.ok(lines.length >= 1, "native message disclosure renders a collapsed summary row");
assert.ok(lines.some((line) => line.includes("Process")), "collapsed summary identifies the process entry");
assert.ok(lines.some((line) => line.includes("npm test")), "collapsed summary shows the latest record");
input("\x0f");
lines = pi.renderer(entries[0], { expanded: false }, theme).render(100);
assert.ok(lines.some((line) => line.includes("some_mcp_tool")), "extension tool name remains unchanged");
assert.ok(!lines.some((line) => line.includes("file.ts")), "older details stay hidden outside the recent-record window");
assert.ok(lines.some((line) => line.includes("npm test")), "expanded rows include a compact summary of tool arguments");
assert.ok(lines.some((line) => line.includes("2 older records")), "expanded view discloses older record count");
assert.ok(lines.some((line) => line.includes("✓")), "text symbols replace emoji");
assert.ok(!lines.some((line) => /[\u{1F300}-\u{1FAFF}]/u.test(line)), "render has no emoji");
assert.ok(uiCalls.colors.includes("muted"), "built-in rows use the configured category color");
assert.ok(uiCalls.colors.includes("success"), "extension rows use the configured category color");
const refreshCountBefore = uiCalls.tools.length;
await commands.get("process-native").handler("off", ctx);
assert.equal(nativePatch.hidden, false, "/process-native off restores the native render");
const restoredLines = toolComponent.render(100);
assert.ok(restoredLines.length > 0, "restored native tool card renders visible output");
assert.deepEqual(restoredLines, nativePatch.originalRender.call(toolComponent, 100), "restored native card matches the pristine render");
assert.ok(uiCalls.tools.length > refreshCountBefore, "/process-native off refreshes existing native cards");
await commands.get("process-native").handler("on", ctx);
assert.equal(nativePatch.hidden, true, "/process-native on hides native tool cards again");
assert.deepEqual(toolComponent.render(100), [], "re-hidden native tool card renders as []");
await commands.get("process").handler("3", ctx);
assert.equal(JSON.parse(readFileSync(join(agentDir, "rolling-process.json"), "utf8")).maxRecords, 3, "record limit persists in plugin config");
lines = pi.renderer(entries[0], { expanded: false }, theme).render(100);
assert.ok(lines.some((line) => line.includes("npm test")), "updated record limit keeps the newest record visible");
emit("agent_end", { type: "agent_end" });
assert.ok(pi.renderer(entries[0], { expanded: false }, theme).render(100).some((line) => line.includes("Completed")), "completed run reports its final state");
console.log("self-check ok");
