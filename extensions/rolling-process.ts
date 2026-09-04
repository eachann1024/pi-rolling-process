/**
 * Inline rolling-process transcript entry.
 * A process entry is appended only after this turn emits a tool or thinking
 * event, so text-only turns remain exactly user message → final answer.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { AssistantMessageComponent, getAgentDir, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Container, isKeyRelease, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "pi-rolling-process";
const CONFIG_PATH = `${getAgentDir()}/rolling-process.json`;
const DEFAULT_MAX_RECORDS = 6;

type Category = "builtin" | "skill" | "extension" | "subagent" | "thought";
type Status = "running" | "done" | "error" | "aborted";
interface Step { id: string; name: string; category: Category; status: Status; detail: string }
interface EntryData { steps: Step[]; expanded: boolean; maxRecords: number; finished: boolean; latest: string; tps?: number; cacheHit?: number; contextPercent?: number; contextWindow?: number }
interface Config { maxRecords: number; hideNativeTools: boolean; hideWorkingIndicator: boolean; hideThinkingLabel: boolean }

const DEFAULT_CATEGORY_COLORS: Record<Category, string> = {
  builtin: "muted", skill: "success", extension: "success", subagent: "accent", thought: "warning",
};

function loadConfig(): Config {
  const fallback: Config = { maxRecords: DEFAULT_MAX_RECORDS, hideNativeTools: true, hideWorkingIndicator: true, hideThinkingLabel: true };
  try {
    const value = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
    if (Number.isInteger(value.maxRecords) && value.maxRecords! >= 1 && value.maxRecords! <= 100) fallback.maxRecords = value.maxRecords!;
    for (const key of ["hideNativeTools", "hideWorkingIndicator", "hideThinkingLabel"] as const) if (typeof value[key] === "boolean") fallback[key] = value[key]!;
  } catch { /* first use */ }
  return fallback;
}
function saveConfig(config: Config) { writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8"); }
function category(toolName: string, args: Record<string, unknown> | undefined): Category {
  if (toolName === "subagent" || toolName === "subagent_supervisor") return "subagent";
  if (toolName === "read" && typeof args?.path === "string" && /(?:^|\/)SKILL\.md$/i.test(args.path)) return "skill";
  if (["bash", "read", "write", "edit", "grep", "find", "ls"].includes(toolName)) return "builtin";
  return "extension";
}
function compact(value: unknown, max = 120): string {
  if (typeof value !== "string") return "";
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
function toolDetail(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  if (["read", "write", "edit", "ls"].includes(toolName)) return compact(args.path);
  if (toolName === "grep") return [compact(args.pattern, 48), compact(args.path, 64)].filter(Boolean).join("  in  ");
  if (toolName === "find") return [compact(args.pattern, 48), compact(args.path, 64)].filter(Boolean).join("  in  ");
  if (toolName === "bash") return compact(args.command);
  if (toolName === "subagent") return compact(args.task);
  if (toolName === "web_search") return compact(args.query) || (Array.isArray(args.queries) ? compact(args.queries[0]) : "");
  if (toolName === "fetch_content") return compact(args.url) || (Array.isArray(args.urls) ? compact(args.urls[0]) : "");
  for (const key of ["path", "query", "url", "name", "command", "task", "message"]) {
    const detail = compact(args[key]);
    if (detail) return detail;
  }
  return "";
}
function mark(status: Status) { return status === "done" ? "✓" : status === "error" ? "✗" : status === "aborted" ? "!" : "·"; }
function statusText(data: EntryData) { return data.finished ? "Completed" : "Running"; }
function statusColor(data: EntryData): ThemeColor {
  if (data.steps.some((step) => step.status === "error")) return "error";
  if (data.steps.some((step) => step.status === "aborted")) return "warning";
  return data.finished ? "success" : "accent";
}
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}
function renderEntry(data: EntryData, theme: Theme): Component {
  return {
    render(width: number) {
      const recent = data.steps.slice(-data.maxRecords);
      const hidden = Math.max(0, data.steps.length - recent.length);
      const contentWidth = Math.max(1, width - 2);
      const body = new Container();
      const cache = data.cacheHit === undefined ? "" : `CH${data.cacheHit.toFixed(1)}%`;
      const context = data.contextPercent === undefined || data.contextWindow === undefined ? "" : `${data.contextPercent.toFixed(1)}%/${formatTokens(data.contextWindow)}`;
      const metricsLeft = theme.fg("muted", [cache, context].filter(Boolean).join("  "));
      const speed = !data.finished && data.tps && data.tps > 0 ? theme.fg("accent", `${data.tps.toFixed(1)} tok/s`) : "";
      const metricsGap = speed ? Math.max(1, contentWidth - visibleWidth(metricsLeft) - visibleWidth(speed)) : 0;
      body.addChild(new Text(truncateToWidth(`${metricsLeft}${speed ? `${" ".repeat(metricsGap)}${speed}` : ""}`, contentWidth, "…"), 0, 0));

      const disclosure = data.expanded ? "▾" : "▸";
      const latest = data.latest || statusText(data);
      const processLine = `${theme.fg(statusColor(data), disclosure)} ${theme.fg("customMessageLabel", "Process")}  ${theme.fg("customMessageText", latest)}`;
      body.addChild(new Text(truncateToWidth(processLine, contentWidth, "…"), 0, 0));

      if (data.expanded) {
        for (const step of recent) {
          const label = step.category === "thought" ? "Thinking" : step.name;
          const color = step.status === "error" ? "error" : step.status === "aborted" ? "warning" : DEFAULT_CATEGORY_COLORS[step.category] as ThemeColor;
          const marker = theme.fg(step.status === "done" ? "success" : color, mark(step.status));
          const name = theme.fg(color, label);
          const detail = step.detail ? theme.fg("dim", `  ${step.detail}`) : "";
          body.addChild(new Text(truncateToWidth(`  ${marker} ${name}${detail}`, contentWidth, "…"), 0, 0));
        }
        if (hidden) body.addChild(new Text(theme.fg("dim", `  └ ${hidden} older records`), 0, 0));
      }

      const background = typeof theme.bg === "function" ? (text: string) => theme.bg("customMessageBg", text) : undefined;
      const box = new Box(1, 0, background);
      box.addChild(body);
      return box.render(width);
    },
    invalidate() {},
  };
}

const NATIVE_TOOL_PATCH = Symbol.for("pi-rolling-process.native-tool-patch");
type NativeToolPatch = { hidden: boolean; originalRender: (this: ToolExecutionComponent, width: number) => string[] };

function setNativeToolCardsHidden(hidden: boolean, ctx?: ExtensionContext) {
  const prototype = ToolExecutionComponent.prototype as ToolExecutionComponent["render"] extends (...args: never[]) => never ? never : typeof ToolExecutionComponent.prototype & { [NATIVE_TOOL_PATCH]?: NativeToolPatch };
  let patch = prototype[NATIVE_TOOL_PATCH];
  if (!patch) {
    patch = { hidden: false, originalRender: prototype.render };
    prototype[NATIVE_TOOL_PATCH] = patch;
    prototype.render = function (width: number) { return patch!.hidden ? [] : patch!.originalRender.call(this, width); };
  }
  patch.hidden = hidden;
  // Pi refreshes every existing tool component through this public UI API.
  ctx?.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
}

const THINKING_PATCH = Symbol.for("pi-rolling-process.thinking-patch");
type ThinkingPatch = { hidden: boolean; originalUpdate: AssistantMessageComponent["updateContent"] };
function setNativeThinkingHidden(hidden: boolean) {
  const prototype = AssistantMessageComponent.prototype as typeof AssistantMessageComponent.prototype & { [THINKING_PATCH]?: ThinkingPatch };
  let patch = prototype[THINKING_PATCH];
  if (!patch) {
    patch = { hidden: false, originalUpdate: prototype.updateContent };
    prototype[THINKING_PATCH] = patch;
    prototype.updateContent = function (message, isStreaming) {
      if (!patch!.hidden) return patch!.originalUpdate.call(this, message, isStreaming);
      const filtered = { ...message, content: message.content.filter((part) => part.type !== "thinking") };
      return patch!.originalUpdate.call(this, filtered, isStreaming);
    };
  }
  patch.hidden = hidden;
}

function createExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  let current: EntryData | undefined;
  let inputDispose: (() => void) | undefined;
  let lastCtx: ExtensionContext | undefined;
  function refresh() {
    if (current && lastCtx) {
      const usage = lastCtx.getContextUsage();
      if (usage?.percent !== null && usage?.percent !== undefined) current.contextPercent = usage.percent;
      if (usage?.contextWindow) current.contextWindow = usage.contextWindow;
    }
    lastCtx?.ui.setWidget("pi-rolling-process-inline-refresh", undefined);
  }
  function add(step: Step) {
    if (!current) {
      const entry: EntryData = { steps: [], expanded: false, maxRecords: config.maxRecords, finished: false, latest: "" };
      current = entry;
      pi.appendEntry(ENTRY_TYPE, entry);
    }
    current!.steps.push(step);
    current!.latest = step.detail ? `${step.name}  ${step.detail}` : step.name;
    refresh();
  }
  function toggle() { if (current) { current.expanded = !current.expanded; refresh(); } }
  pi.registerEntryRenderer<EntryData>(ENTRY_TYPE, (entry, _options, theme) => entry.data ? renderEntry(entry.data, theme) : undefined);
  pi.registerCommand("process", {
    description: "Toggle process records or set the recent record count: /process [1-100]",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) { toggle(); return; }
      const count = Number.parseInt(raw, 10);
      if (!Number.isInteger(count) || count < 1 || count > 100) { ctx.ui.notify("Enter a record count from 1 to 100", "warning"); return; }
      config.maxRecords = count;
      if (current) current.maxRecords = count;
      saveConfig(config); refresh(); ctx.ui.notify(`Recent record count set to ${count}`, "info");
    },
  });
  pi.registerCommand("process-native", {
    description: "Show or hide native tool cards: /process-native on|off",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value !== "on" && value !== "off") { ctx.ui.notify(`Native tool cards: ${config.hideNativeTools ? "hidden" : "visible"}`, "info"); return; }
      config.hideNativeTools = value === "on"; saveConfig(config); setNativeToolCardsHidden(config.hideNativeTools, ctx);
    },
  });
  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    ctx.ui.setWorkingVisible(!config.hideWorkingIndicator);
    setNativeThinkingHidden(config.hideThinkingLabel);
    ctx.ui.setHiddenThinkingLabel(config.hideThinkingLabel ? "" : undefined);
    setNativeToolCardsHidden(config.hideNativeTools, ctx);
    inputDispose?.();
    inputDispose = ctx.ui.onTerminalInput((data) => {
      if (isKeyRelease(data) || !matchesKey(data, "ctrl+o")) return;
      toggle(); return { consume: true };
    });
  });
  let speedTimer: ReturnType<typeof setInterval> | undefined;
  let lastProviderOutput = 0;
  const tokenWindow: Array<{ time: number; count: number }> = [];
  function updateSpeed(now = Date.now()) {
    if (!current || current.finished) return;
    while (tokenWindow.length && tokenWindow[0]!.time < now - 1000) tokenWindow.shift();
    current.tps = tokenWindow.length
      ? 1000 * tokenWindow.reduce((sum, item) => sum + item.count, 0) / Math.max(50, now - tokenWindow[0]!.time)
      : undefined;
    refresh();
  }
  function startSpeedTimer() {
    if (speedTimer) return;
    speedTimer = setInterval(() => updateSpeed(), 50);
  }
  function stopSpeedTimer() {
    if (speedTimer) clearInterval(speedTimer);
    speedTimer = undefined;
  }
  pi.on("agent_start", (_event, ctx) => {
    lastCtx = ctx;
    current = undefined;
    tokenWindow.length = 0;
    lastProviderOutput = 0;
    startSpeedTimer();
  });
  function recordSpeed(delta: string, providerOutput?: number) {
    if (!current || current.finished) return;
    const now = Date.now();
    let count: number;
    if (providerOutput !== undefined && providerOutput > lastProviderOutput) {
      count = providerOutput - lastProviderOutput;
      lastProviderOutput = providerOutput;
    } else {
      count = Math.max(1, delta.match(/\w+|[^\s\w]/g)?.length ?? 1);
    }
    tokenWindow.push({ time: now, count });
    updateSpeed(now);
  }
  pi.on("message_update", (event) => {
    const value = event.assistantMessageEvent;
    if (value.type === "thinking_start") { tokenWindow.length = 0; add({ id: `thought-${Date.now()}`, name: "Thinking", category: "thought", status: "running", detail: "" }); }
    if ((value.type === "thinking_delta" || value.type === "text_delta") && current) {
      const usage = value.partial?.usage;
      if (usage) {
        const cacheBase = usage.input + usage.cacheRead;
        if (cacheBase > 0) current.cacheHit = 100 * usage.cacheRead / cacheBase;
      }
      recordSpeed(value.delta, usage?.output);
      if (value.type === "thinking_delta") {
        const step = [...current.steps].reverse().find((item) => item.category === "thought" && item.status === "running");
        if (step) { step.detail = compact(`${step.detail}${value.delta}`, 160); current.latest = step.detail || "Thinking"; }
      }
      refresh();
    }
    if (value.type === "thinking_end" && current) { const step = [...current.steps].reverse().find((item) => item.category === "thought" && item.status === "running"); if (step) step.status = "done"; }
  });
  pi.on("tool_execution_start", (event) => {
  const args = event.args as Record<string, unknown> | undefined;
  add({ id: event.toolCallId, name: event.toolName, category: category(event.toolName, args), status: "running", detail: toolDetail(event.toolName, args) });
});
  pi.on("tool_execution_end", (event) => { const step = current?.steps.find((item) => item.id === event.toolCallId); if (step) { step.status = event.isError ? "error" : "done"; } refresh(); });
  pi.on("agent_end", () => { stopSpeedTimer(); if (current) { current.finished = true; current.tps = undefined; current.latest = current.steps.some((step) => step.status === "error") ? "Failed" : "Completed"; for (const step of current.steps) if (step.status === "running") step.status = "aborted"; refresh(); } });
  pi.on("session_shutdown", () => { stopSpeedTimer(); inputDispose?.(); inputDispose = undefined; lastCtx = undefined; });
}
export default function (pi: ExtensionAPI) { createExtension(pi); }
