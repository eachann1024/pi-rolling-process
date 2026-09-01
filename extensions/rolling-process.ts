import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, getAgentDir, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface StepItem {
  id: string;
  index: number;
  type: "tool" | "thought";
  name: string;
  detail: string;
  status: "running" | "done" | "error";
  startTime: number;
  endTime?: number;
  resultSummary?: string;
}

interface RunSnapshot {
  runId: string;
  steps: StepItem[];
}

type LocalePref = "auto" | "zh" | "en";
type UiLang = "zh" | "en";

interface ProcessConfig {
  maxVisibleLines: number;
  locale: LocalePref;
}

interface ProcessState {
  runId: string;
  steps: StepItem[];
  snapshots: Map<string, StepItem[]>;
  maxVisibleLines: number;
  localePref: LocalePref;
  isAgentRunning: boolean;
  entryCreated: boolean;
  spinnerFrame: number;
  spinnerTimer?: ReturnType<typeof setInterval>;
  thoughtBuffer: string;
  lastThoughtHeading: string;
  hideTranscriptTools: boolean;
  tui?: { requestRender: () => void };
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ENTRY_TYPE = "pi-rolling-process";
const HIDE_TOOLS_KEY = Symbol.for("pi-rolling-process.hide-transcript-tools");
const HIDE_THINKING_KEY = Symbol.for("pi-rolling-process.hide-thinking-labels");
const CONFIG_PATH = join(getAgentDir(), "rolling-process.json");
const SNAP_PATH = join(getAgentDir(), "rolling-process-runs.json");
const TICK_WIDGET = "pi-rolling-process-tick";

const I18N = {
  zh: {
    more: (n: number) => `··· +${n}`,
    linesOut: (n: number) => `${n} 行`,
    expanded: "已展开全部步骤",
    collapsed: (n: number) => `已收起（最新 ${n} 条）`,
    linesSet: (n: number) => `收起时显示最新 ${n} 条`,
    linesHelp: "请输入 1 到 20，例如: /process-lines 5",
    cmdProcess: "展开/收起执行过程（等同 ctrl+o）",
    cmdLines: "设置收起时显示的条数（默认 5）",
    cmdLang: "界面语言：auto / zh / en",
    langSet: (v: string) => `界面语言已设为 ${v}`,
    langHelp: "用法: /process-lang auto|zh|en",
  },
  en: {
    more: (n: number) => `··· +${n}`,
    linesOut: (n: number) => `${n} lines`,
    expanded: "Process expanded",
    collapsed: (n: number) => `Collapsed (latest ${n})`,
    linesSet: (n: number) => `Collapsed view shows latest ${n}`,
    linesHelp: "Enter 1-20, e.g. /process-lines 5",
    cmdProcess: "Expand/collapse process (same as ctrl+o)",
    cmdLines: "Rows shown when collapsed (default 5)",
    cmdLang: "UI language: auto / zh / en",
    langSet: (v: string) => `UI language set to ${v}`,
    langHelp: "Usage: /process-lang auto|zh|en",
  },
} as const;

function isZhTag(value: string): boolean {
  return /^zh\b/i.test(value.trim().replace(/_/g, "-"));
}

function readAppleLocale(): string {
  if (process.platform !== "darwin") return "";
  try {
    return execSync("defaults read -g AppleLocale", { encoding: "utf8", timeout: 800 }).trim();
  } catch {
    return "";
  }
}

function detectUiLang(pref: LocalePref): UiLang {
  if (pref === "zh" || pref === "en") return pref;
  const candidates = [
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale,
    readAppleLocale(),
  ];
  for (const item of candidates) {
    if (item && isZhTag(item)) return "zh";
  }
  return "en";
}

function fit(line: string, width: number): string {
  const max = Math.max(0, width);
  if (max <= 0) return "";
  let out = truncateToWidth(line, max);
  let guard = 0;
  while (visibleWidth(out) > max && guard < 12) {
    out = truncateToWidth(out, Math.max(0, max - 1 - guard));
    guard++;
  }
  return out;
}

function cleanString(str: unknown): string {
  return String(str ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractThoughtHeading(text: unknown): string {
  if (typeof text !== "string") return "";
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) return "";
  return cleanString(firstLine)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^__(.+)__$/, "$1")
    .replace(/^`(.+)`$/, "$1");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "";
  return `${(ms / 1000).toFixed(1)}s`;
}

function cloneSteps(steps: StepItem[]): StepItem[] {
  return steps.map((s) => ({ ...s }));
}

function parseLocalePref(value: unknown): LocalePref | undefined {
  if (value === "auto" || value === "zh" || value === "en") return value;
  return undefined;
}

function loadConfig(): ProcessConfig {
  const fallback: ProcessConfig = { maxVisibleLines: 5, locale: "auto" };
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
      maxVisibleLines?: unknown;
      locale?: unknown;
    };
    const n = Number(parsed.maxVisibleLines);
    if (Number.isInteger(n) && n >= 1 && n <= 20) fallback.maxVisibleLines = n;
    fallback.locale = parseLocalePref(parsed.locale) ?? "auto";
  } catch {
    // default
  }
  return fallback;
}

function saveConfig(config: ProcessConfig) {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function loadSnapshots(): Map<string, StepItem[]> {
  const map = new Map<string, StepItem[]>();
  try {
    const parsed = JSON.parse(readFileSync(SNAP_PATH, "utf8")) as { runs?: RunSnapshot[] };
    for (const run of parsed.runs ?? []) {
      if (run?.runId && Array.isArray(run.steps)) map.set(run.runId, run.steps);
    }
  } catch {
    // first run
  }
  return map;
}

function saveSnapshots(map: Map<string, StepItem[]>) {
  const runs = [...map.entries()].slice(-80).map(([runId, steps]) => ({ runId, steps }));
  writeFileSync(SNAP_PATH, `${JSON.stringify({ runs }, null, 2)}\n`, "utf8");
}

function getToolPreview(name: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  switch (name) {
    case "bash":
      return `$ ${cleanString(a.command || "...")}`;
    case "read": {
      const p = cleanString(a.path || "...");
      if (a.offset !== undefined || a.limit !== undefined) {
        const start = typeof a.offset === "number" ? a.offset : 1;
        const end = typeof a.limit === "number" ? start + a.limit - 1 : "";
        return `read ${p}:${start}${end ? `-${end}` : ""}`;
      }
      return `read ${p}`;
    }
    case "write":
      return `write ${cleanString(a.path || "...")}`;
    case "edit":
      return `edit ${cleanString(a.path || "...")}`;
    case "grep":
      return `grep "${cleanString(a.pattern || "...")}" ${cleanString(a.path || ".")}`;
    case "find":
      return `find "${cleanString(a.pattern || "...")}" ${cleanString(a.path || ".")}`;
    case "ls":
      return `ls ${cleanString(a.path || ".")}`;
    default: {
      const keys = ["command", "query", "pattern", "path", "file", "url", "prompt", "text", "name"];
      for (const k of keys) {
        const v = a[k];
        if (typeof v === "string" && v.trim()) return `${name} ${cleanString(v)}`;
      }
      return name;
    }
  }
}

function patchHideTranscriptTools(enabled: boolean) {
  const proto = ToolExecutionComponent.prototype as unknown as {
    render: (width: number) => string[];
    [key: symbol]: unknown;
  };
  if (typeof proto.render !== "function") return;
  const existing = proto[HIDE_TOOLS_KEY] as { previous: typeof proto.render } | undefined;
  if (existing) {
    proto.render = existing.previous;
    delete proto[HIDE_TOOLS_KEY];
  }
  if (!enabled) return;
  const previous = proto.render;
  proto.render = function patchedRender(_width: number) {
    void previous;
    return [];
  };
  proto[HIDE_TOOLS_KEY] = { previous };
}

function applyMarkdownTransformers(
  markdown: string,
  transformers: Array<(md: string, ctx: { messageType: string; isStreaming: boolean; availableWidth: number }) => string> | undefined,
  isStreaming: boolean,
  availableWidth: number,
): string {
  let out = markdown;
  for (const transformer of transformers ?? []) {
    try {
      const next = transformer(out, { messageType: "assistant", isStreaming, availableWidth });
      if (typeof next === "string") out = next;
    } catch {
      // keep current
    }
  }
  return out;
}

function patchHideThinkingLabels() {
  const proto = AssistantMessageComponent.prototype as unknown as {
    updateContent: (message: unknown, isStreaming?: boolean) => void;
    [key: symbol]: unknown;
  };
  if (typeof proto.updateContent !== "function") return;
  const existing = proto[HIDE_THINKING_KEY] as { original: typeof proto.updateContent } | undefined;
  const original = existing?.original ?? proto.updateContent;

  proto.updateContent = function patchedUpdateContent(
    this: {
      hideThinkingBlock?: boolean;
      contentContainer?: { clear: () => void; addChild: (c: unknown) => void };
      lastMessage?: unknown;
      isStreaming?: boolean;
      hasToolCalls?: boolean;
      outputPad?: number;
      markdownTheme?: unknown;
      markdownTransformers?: Array<(md: string, ctx: { messageType: string; isStreaming: boolean; availableWidth: number }) => string>;
    },
    message: { content?: Array<{ type?: string; text?: string }>; stopReason?: string; errorMessage?: string },
    isStreaming?: boolean,
  ) {
    if (!this.hideThinkingBlock || !this.contentContainer || !Array.isArray(message?.content)) {
      return original.call(this, message, isStreaming);
    }

    this.lastMessage = message;
    this.isStreaming = isStreaming ?? this.isStreaming;
    this.contentContainer.clear();
    this.hasToolCalls = message.content.some((c) => c.type === "toolCall");

    const texts = message.content.filter((c) => c.type === "text" && c.text?.trim());
    if (texts.length > 0) {
      this.contentContainer.addChild(new Spacer(1));
      for (const content of texts) {
        this.contentContainer.addChild(
          new Markdown(content.text!.trim(), this.outputPad ?? 0, 0, this.markdownTheme as never, undefined, {
            transform: (markdown: string, availableWidth: number) =>
              applyMarkdownTransformers(markdown, this.markdownTransformers, this.isStreaming ?? false, availableWidth),
          }),
        );
      }
    }

    if (message.stopReason === "length") {
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(new Text("Response was truncated before completion.", this.outputPad ?? 0, 0));
    } else if (texts.length === 0 && (message.stopReason === "aborted" || message.stopReason === "error")) {
      return original.call(this, message, isStreaming);
    }
  };

  proto[HIDE_THINKING_KEY] = { original };
}

function createRollingProcessExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const state: ProcessState = {
    runId: "",
    steps: [],
    snapshots: loadSnapshots(),
    maxVisibleLines: config.maxVisibleLines,
    localePref: config.locale,
    isAgentRunning: false,
    entryCreated: false,
    spinnerFrame: 0,
    thoughtBuffer: "",
    lastThoughtHeading: "",
    hideTranscriptTools: true,
  };

  function t() {
    return I18N[detectUiLang(state.localePref)];
  }

  function persistConfig() {
    saveConfig({ maxVisibleLines: state.maxVisibleLines, locale: state.localePref });
  }

  function spinner(): string {
    return SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length] ?? "⠋";
  }

  function withLiveUi(ctx: ExtensionContext, fn: () => void) {
    try {
      if (!ctx.hasUI) return;
      fn();
    } catch {
      // Session was replaced (/new, /reload, fork). Drop the stale ctx.
    }
  }

  function hideChrome(ctx: ExtensionContext) {
    withLiveUi(ctx, () => {
      ctx.ui.setWorkingVisible(false);
      ctx.ui.setHiddenThinkingLabel("");
      ctx.ui.setWidget("rolling-process", undefined);
    });
  }

  function captureTui(ctx: ExtensionContext) {
    withLiveUi(ctx, () => {
      ctx.ui.setWidget(TICK_WIDGET, (tui) => {
        state.tui = tui;
        return { render: () => [], invalidate: () => {} };
      });
    });
  }

  function requestRender() {
    state.tui?.requestRender();
  }

  function persistCurrentRun() {
    if (!state.runId || state.steps.length === 0) return;
    state.snapshots.set(state.runId, cloneSteps(state.steps));
    saveSnapshots(state.snapshots);
  }

  function stepsFor(runId: string | undefined): StepItem[] {
    if (runId && runId === state.runId) return state.steps;
    if (runId && state.snapshots.has(runId)) return state.snapshots.get(runId) ?? [];
    return [];
  }

  function renderProcess(steps: StepItem[], width: number, theme: Theme, expanded: boolean): string[] {
    if (steps.length === 0) return [];
    const ui = t();
    const visible = expanded ? steps : steps.slice(-state.maxVisibleLines);
    const hiddenCount = Math.max(0, steps.length - visible.length);
    const lines: string[] = [];

    if (hiddenCount > 0) {
      lines.push(fit(theme.fg("dim", `  ${ui.more(hiddenCount)}`), width));
    }

    for (const step of visible) {
      let icon = theme.fg("success", "✓ ");
      if (step.status === "running") icon = theme.fg("accent", `${spinner()} `);
      else if (step.status === "error") icon = theme.fg("error", "✗ ");

      const ms = (step.endTime ?? (step.status === "running" ? Date.now() : 0)) - step.startTime;
      const dur = formatDuration(ms);
      const extra = step.resultSummary && step.resultSummary.length <= 40 ? `  ${step.resultSummary}` : "";
      const meta = dur ? theme.fg("dim", `  ${dur}`) : "";
      const preview =
        step.type === "thought"
          ? theme.fg("dim", `· ${step.detail}`)
          : theme.fg(step.status === "error" ? "error" : "text", step.detail);
      lines.push(fit(`  ${icon}${preview}${extra}${meta}`, width));
    }

    return lines.map((line) => fit(line, width));
  }

  function startSpinner() {
    if (state.spinnerTimer) return;
    state.spinnerTimer = setInterval(() => {
      state.spinnerFrame = (state.spinnerFrame + 1) % SPINNER_FRAMES.length;
      requestRender();
    }, 120);
    state.spinnerTimer.unref?.();
  }

  function stopSpinner() {
    if (state.spinnerTimer) {
      clearInterval(state.spinnerTimer);
      state.spinnerTimer = undefined;
    }
    requestRender();
  }

  function ensureTranscriptEntry() {
    if (state.entryCreated || !state.runId) return;
    state.entryCreated = true;
    pi.appendEntry<RunSnapshot>(ENTRY_TYPE, { runId: state.runId, steps: [] });
  }

  function refresh() {
    requestRender();
  }

  function upsertThought(heading: string) {
    if (!heading || heading.length < 2) return;
    if (heading === state.lastThoughtHeading) {
      const last = state.steps.at(-1);
      if (last?.type === "thought" && last.status === "running") last.detail = heading;
      refresh();
      return;
    }
    state.lastThoughtHeading = heading;
    const last = state.steps.at(-1);
    if (last && last.type === "thought" && last.status === "running") {
      last.detail = heading;
    } else {
      state.steps.push({
        id: `thought-${Date.now()}`,
        index: state.steps.length + 1,
        type: "thought",
        name: "thinking",
        detail: heading,
        status: "running",
        startTime: Date.now(),
      });
      ensureTranscriptEntry();
    }
    refresh();
  }

  function finishRunningThought() {
    const last = state.steps.at(-1);
    if (last && last.type === "thought" && last.status === "running") {
      last.status = "done";
      last.endTime = Date.now();
      refresh();
    }
    state.thoughtBuffer = "";
  }

  function toggleExpanded(ctx: ExtensionContext) {
    const next = !ctx.ui.getToolsExpanded();
    ctx.ui.setToolsExpanded(next);
    ctx.ui.notify(next ? t().expanded : t().collapsed(state.maxVisibleLines), "info");
    refresh();
  }

  const boot = t();

  pi.registerEntryRenderer<RunSnapshot>(ENTRY_TYPE, (entry, { expanded }, theme) => {
    return {
      render: (width: number) => renderProcess(stepsFor(entry.data?.runId), width, theme, expanded),
      invalidate: () => {},
    };
  });

  pi.registerCommand("process", {
    description: boot.cmdProcess,
    handler: async (_args, ctx) => toggleExpanded(ctx),
  });

  pi.registerCommand("process-lines", {
    description: boot.cmdLines,
    handler: async (args, ctx) => {
      const num = Number.parseInt(args.trim(), 10);
      if (!Number.isNaN(num) && num >= 1 && num <= 20) {
        state.maxVisibleLines = num;
        persistConfig();
        ctx.ui.notify(t().linesSet(num), "info");
        refresh();
      } else {
        ctx.ui.notify(t().linesHelp, "warning");
      }
    },
  });

  pi.registerCommand("process-lang", {
    description: boot.cmdLang,
    handler: async (args, ctx) => {
      const next = parseLocalePref(args.trim().toLowerCase());
      if (!next) {
        ctx.ui.notify(t().langHelp, "warning");
        return;
      }
      state.localePref = next;
      persistConfig();
      ctx.ui.notify(t().langSet(next === "auto" ? `auto → ${detectUiLang("auto")}` : next), "info");
      refresh();
    },
  });

  pi.on("session_shutdown", () => {
    if (state.spinnerTimer) {
      clearInterval(state.spinnerTimer);
      state.spinnerTimer = undefined;
    }
    state.tui = undefined;
    state.isAgentRunning = false;
    state.steps = [];
    state.runId = "";
    state.entryCreated = false;
  });

  pi.on("session_start", (_event, ctx) => {
    state.steps = [];
    state.runId = "";
    state.entryCreated = false;
    state.isAgentRunning = false;
    const loaded = loadConfig();
    state.snapshots = loadSnapshots();
    state.maxVisibleLines = loaded.maxVisibleLines;
    state.localePref = loaded.locale;
    patchHideTranscriptTools(state.hideTranscriptTools);
    patchHideThinkingLabels();
    hideChrome(ctx);
    captureTui(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    persistCurrentRun();
    state.isAgentRunning = true;
    state.runId = `run-${Date.now()}`;
    state.steps = [];
    state.entryCreated = false;
    state.thoughtBuffer = "";
    state.lastThoughtHeading = "";
    patchHideTranscriptTools(state.hideTranscriptTools);
    hideChrome(ctx);
    captureTui(ctx);
    startSpinner();
  });

  pi.on("agent_end", (_event, ctx) => {
    finishRunningThought();
    persistCurrentRun();
    state.isAgentRunning = false;
    hideChrome(ctx);
    stopSpinner();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    finishRunningThought();
    hideChrome(ctx);
    state.steps.push({
      id: event.toolCallId,
      index: state.steps.length + 1,
      type: "tool",
      name: event.toolName,
      detail: getToolPreview(event.toolName, event.args as Record<string, unknown> | undefined),
      status: "running",
      startTime: Date.now(),
    });
    ensureTranscriptEntry();
    captureTui(ctx);
    refresh();
  });

  pi.on("tool_execution_end", (event) => {
    const item = state.steps.find((s) => s.id === event.toolCallId);
    if (item) {
      item.status = event.isError ? "error" : "done";
      item.endTime = Date.now();
      const content = event.result?.content;
      const text = Array.isArray(content)
        ? content.find((c: { type?: string; text?: string }) => c?.type === "text")?.text
        : undefined;
      if (typeof text === "string" && text.trim()) {
        const lines = text.trim().split("\n").filter(Boolean);
        item.resultSummary = lines.length === 1 ? cleanString(lines[0]).slice(0, 40) : t().linesOut(lines.length);
      }
    }
    refresh();
  });

  pi.on("message_update", (event, ctx) => {
    hideChrome(ctx);
    const ev = event.assistantMessageEvent as
      | { type?: string; thinking?: string; delta?: string; content?: string }
      | undefined;
    if (!ev?.type) return;

    if (ev.type === "thinking_start") {
      state.thoughtBuffer = "";
      return;
    }

    if (ev.type === "thinking_delta" || ev.type === "thinking_end" || ev.type.startsWith("thinking")) {
      const chunk = ev.delta ?? ev.thinking ?? ev.content ?? "";
      if (ev.type === "thinking_delta" && typeof chunk === "string") state.thoughtBuffer += chunk;
      else if (typeof ev.thinking === "string" && ev.thinking.trim()) state.thoughtBuffer = ev.thinking;
      const heading = extractThoughtHeading(state.thoughtBuffer);
      if (heading) upsertThought(heading);
      if (ev.type === "thinking_end") finishRunningThought();
      return;
    }

    if (ev.type === "text_start" || ev.type === "text_delta" || ev.type === "text_end") {
      finishRunningThought();
    }
  });
}

export default function (pi: ExtensionAPI) {
  createRollingProcessExtension(pi);
}
