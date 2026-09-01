import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

interface StepItem {
  id: string;
  index: number;
  type: "tool" | "thought";
  name: string;
  detail: string;
  status: "running" | "done" | "error" | "aborted";
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
type StylePreset = "box" | "panel" | "plain";
type BorderStyle = "single" | "rounded" | "double" | "none";

interface ProcessStyle {
  preset: StylePreset;
  border: BorderStyle;
  showHeader: boolean;
  showStepIndex: boolean;
  showKind: boolean;
  showDuration: boolean;
  showResult: boolean;
  icons: { done: string; error: string; running: string; aborted: string };
  colors: {
    border: string;
    header: string;
    kind: string;
    duration: string;
    done: string;
    error: string;
    running: string;
    aborted: string;
  };
}

interface ProcessConfig {
  maxVisibleLines: number;
  locale: LocalePref;
  style: ProcessStyle;
}

interface ProcessState {
  runId: string;
  steps: StepItem[];
  snapshots: Map<string, StepItem[]>;
  maxVisibleLines: number;
  localePref: LocalePref;
  style: ProcessStyle;
  isAgentRunning: boolean;
  workingStartedAt?: number;
  spinnerFrame: number;
  entryCreated: boolean;
  thoughtBuffer: string;
  lastThoughtHeading: string;
  processExpanded: boolean;
}

const ENTRY_TYPE = "pi-rolling-process";
const CONFIG_PATH = join(getAgentDir(), "rolling-process.json");
const SNAP_PATH = join(getAgentDir(), "rolling-process-runs.json");
const DURATION_COL = 6;
const ICON_COL = 2;
// Walking dot around a 2×3 braille cell (rows 1–3, both columns).
const SPINNER_FRAMES = ["⠁", "⠈", "⠐", "⠠", "⠄", "⠂"];

const DEFAULT_STYLE: ProcessStyle = {
  preset: "box",
  border: "single",
  showHeader: true,
  showStepIndex: false,
  showKind: true,
  showDuration: true,
  showResult: true,
  icons: { done: "✅", error: "❌", running: "⠁", aborted: "⚠️" },
  colors: {
    border: "border",
    header: "dim",
    kind: "muted",
    duration: "success",
    done: "success",
    error: "error",
    running: "warning",
    aborted: "warning",
  },
};

const BORDERS: Record<
  Exclude<BorderStyle, "none">,
  { tl: string; tr: string; bl: string; br: string; h: string; v: string }
> = {
  single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
};

const I18N = {
  zh: {
    title: "极简模式",
    folded: (n: number) => `已折叠 ${n}`,
    expandHint: "ctrl+o 展开 ctrl+alt+o 原始展开",
    collapseHint: "ctrl+o 收起 ctrl+alt+o 原始展开",
    thought: "思考",
    more: (n: number) => `··· +${n}`,
    linesOut: (n: number) => `${n} 行`,
    expanded: "已展开全部步骤",
    collapsed: (n: number) => `已收起（最新 ${n} 条）`,
    linesSet: (n: number) => `收起时显示最新 ${n} 条`,
    linesHelp: "请输入 1 到 20，例如: /process-lines 6",
    cmdProcess: "展开/收起极简模式（ctrl+o；原生工具展开为 ctrl+alt+o）",
    cmdLines: "设置收起时显示的条数（默认 6）",
    working: "执行中",
    cmdLang: "界面语言：auto / zh / en",
    langSet: (v: string) => `界面语言已设为 ${v}`,
    langHelp: "用法: /process-lang auto|zh|en",
    cmdStyle:
      "过程框样式：box / panel / plain，或 border single|rounded|double",
    styleSet: (v: string) => `过程样式已设为 ${v}`,
    styleNow: (v: string) => `当前样式 ${v}`,
    styleHelp:
      "用法: /process-style box|panel|plain  或  /process-style border single|rounded|double",
  },
  en: {
    title: "Minimal",
    folded: (n: number) => `${n} hidden`,
    expandHint: "ctrl+o expand ctrl+alt+o raw expand",
    collapseHint: "ctrl+o collapse ctrl+alt+o raw expand",
    thought: "think",
    more: (n: number) => `··· +${n}`,
    linesOut: (n: number) => `${n} lines`,
    expanded: "Process expanded",
    collapsed: (n: number) => `Collapsed (latest ${n})`,
    linesSet: (n: number) => `Collapsed view shows latest ${n}`,
    linesHelp: "Enter 1-20, e.g. /process-lines 6",
    cmdProcess:
      "Expand/collapse Minimal mode (ctrl+o; native tool dump is ctrl+alt+o)",
    cmdLines: "Rows shown when collapsed (default 6)",
    working: "working",
    cmdLang: "UI language: auto / zh / en",
    langSet: (v: string) => `UI language set to ${v}`,
    langHelp: "Usage: /process-lang auto|zh|en",
    cmdStyle:
      "Process style: box / panel / plain, or border single|rounded|double",
    styleSet: (v: string) => `Process style set to ${v}`,
    styleNow: (v: string) => `Current style ${v}`,
    styleHelp:
      "Usage: /process-style box|panel|plain  or  /process-style border single|rounded|double",
  },
} as const;

function isZhTag(value: string): boolean {
  return /^zh\b/i.test(value.trim().replace(/_/g, "-"));
}

function readAppleLocale(): string {
  if (process.platform !== "darwin") return "";
  try {
    return execSync("defaults read -g AppleLocale", {
      encoding: "utf8",
      timeout: 800,
    }).trim();
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
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) {
    const seconds = ms / 1000;
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

function padDuration(text: string): string {
  const pad = Math.max(0, DURATION_COL - visibleWidth(text));
  return " ".repeat(pad) + text;
}

function padIcon(text: string): string {
  const w = visibleWidth(text);
  if (w >= ICON_COL) return text;
  const gap = ICON_COL - w;
  const left = Math.ceil(gap / 2);
  const right = gap - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

function stepDurationText(step: StepItem): string {
  if (step.status === "running") {
    if (step.startTime > 0) return formatDuration(Date.now() - step.startTime);
    return "";
  }
  if (step.endTime !== undefined && step.startTime > 0)
    return formatDuration(step.endTime - step.startTime);
  return "";
}

const TOOL_KIND: Record<UiLang, Record<string, string>> = {
  zh: {
    bash: "命令",
    read: "读取",
    write: "写入",
    edit: "编辑",
    grep: "搜索",
    find: "查找",
    ls: "列表",
    bg_wait: "等待",
    wait: "等待",
    sleep: "等待",
    subagent: "子代理",
    thinking: "思考",
    think: "思考",
    powershell: "命令",
  },
  en: {
    bash: "bash",
    read: "read",
    write: "write",
    edit: "edit",
    grep: "grep",
    find: "find",
    ls: "ls",
    bg_wait: "wait",
    wait: "wait",
    sleep: "wait",
    subagent: "subagent",
    thinking: "think",
    think: "think",
    powershell: "powershell",
  },
};

function kindLabel(
  name: string,
  type: StepItem["type"],
  lang: UiLang,
  thought: string,
): string {
  if (type === "thought") return thought;
  return (
    TOOL_KIND[lang][name] ??
    TOOL_KIND[lang][name.toLowerCase()] ??
    name.replace(/_/g, " ")
  );
}

function cloneSteps(steps: StepItem[]): StepItem[] {
  return steps.map((s) => ({ ...s }));
}

function parseLocalePref(value: unknown): LocalePref | undefined {
  if (value === "auto" || value === "zh" || value === "en") return value;
  return undefined;
}

function asNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function parseStyle(raw: unknown): ProcessStyle {
  const src =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const icons =
    src.icons && typeof src.icons === "object"
      ? (src.icons as Record<string, unknown>)
      : {};
  const colors =
    src.colors && typeof src.colors === "object"
      ? (src.colors as Record<string, unknown>)
      : {};
  const preset =
    src.preset === "panel" || src.preset === "plain" || src.preset === "box"
      ? src.preset
      : DEFAULT_STYLE.preset;
  const border =
    src.border === "rounded" ||
    src.border === "double" ||
    src.border === "none" ||
    src.border === "single"
      ? src.border
      : DEFAULT_STYLE.border;
  return {
    preset,
    border,
    showHeader:
      typeof src.showHeader === "boolean"
        ? src.showHeader
        : DEFAULT_STYLE.showHeader,
    showStepIndex:
      typeof src.showStepIndex === "boolean"
        ? src.showStepIndex
        : DEFAULT_STYLE.showStepIndex,
    showKind:
      typeof src.showKind === "boolean" ? src.showKind : DEFAULT_STYLE.showKind,
    showDuration:
      typeof src.showDuration === "boolean"
        ? src.showDuration
        : DEFAULT_STYLE.showDuration,
    showResult:
      typeof src.showResult === "boolean"
        ? src.showResult
        : DEFAULT_STYLE.showResult,
    icons: {
      done: asNonEmptyString(icons.done, DEFAULT_STYLE.icons.done),
      error: asNonEmptyString(icons.error, DEFAULT_STYLE.icons.error),
      running: asNonEmptyString(icons.running, DEFAULT_STYLE.icons.running),
      aborted: asNonEmptyString(icons.aborted, DEFAULT_STYLE.icons.aborted),
    },
    colors: {
      border: asNonEmptyString(colors.border, DEFAULT_STYLE.colors.border),
      header: asNonEmptyString(colors.header, DEFAULT_STYLE.colors.header),
      kind: asNonEmptyString(colors.kind, DEFAULT_STYLE.colors.kind),
      duration: asNonEmptyString(
        colors.duration,
        DEFAULT_STYLE.colors.duration,
      ),
      done: asNonEmptyString(colors.done, DEFAULT_STYLE.colors.done),
      error: asNonEmptyString(colors.error, DEFAULT_STYLE.colors.error),
      running: asNonEmptyString(colors.running, DEFAULT_STYLE.colors.running),
      aborted: asNonEmptyString(colors.aborted, DEFAULT_STYLE.colors.aborted),
    },
  };
}

function loadConfig(): ProcessConfig {
  const fallback: ProcessConfig = {
    maxVisibleLines: 6,
    locale: "auto",
    style: {
      ...DEFAULT_STYLE,
      icons: { ...DEFAULT_STYLE.icons },
      colors: { ...DEFAULT_STYLE.colors },
    },
  };
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
      maxVisibleLines?: unknown;
      locale?: unknown;
      style?: unknown;
    };
    const n = Number(parsed.maxVisibleLines);
    if (Number.isInteger(n) && n >= 1 && n <= 20) fallback.maxVisibleLines = n;
    fallback.locale = parseLocalePref(parsed.locale) ?? "auto";
    fallback.style = parseStyle(parsed.style);
  } catch {
    // default
  }
  return fallback;
}

function saveConfig(config: ProcessConfig) {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function styleSummary(style: ProcessStyle): string {
  return `${style.preset} · border ${style.border}`;
}

function loadSnapshots(): Map<string, StepItem[]> {
  const map = new Map<string, StepItem[]>();
  try {
    const parsed = JSON.parse(readFileSync(SNAP_PATH, "utf8")) as {
      runs?: RunSnapshot[];
    };
    for (const run of parsed.runs ?? []) {
      if (run?.runId && Array.isArray(run.steps)) map.set(run.runId, run.steps);
    }
  } catch {
    // first run
  }
  return map;
}

function saveSnapshots(map: Map<string, StepItem[]>) {
  const runs = [...map.entries()]
    .slice(-80)
    .map(([runId, steps]) => ({ runId, steps }));
  writeFileSync(SNAP_PATH, `${JSON.stringify({ runs }, null, 2)}\n`, "utf8");
}

function getToolPreview(
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  const a = args ?? {};
  switch (name) {
    case "bash":
    case "powershell":
      return `$ ${cleanString(a.command || "...")}`;
    case "read": {
      const p = cleanString(a.path || "...");
      if (a.offset !== undefined || a.limit !== undefined) {
        const start = typeof a.offset === "number" ? a.offset : 1;
        const end = typeof a.limit === "number" ? start + a.limit - 1 : "";
        return `${p}:${start}${end ? `-${end}` : ""}`;
      }
      return p;
    }
    case "write":
    case "edit":
      return cleanString(a.path || "...");
    case "grep":
    case "find":
      return `"${cleanString(a.pattern || "...")}" ${cleanString(a.path || ".")}`;
    case "ls":
      return cleanString(a.path || ".");
    case "bg_wait":
    case "wait":
    case "sleep": {
      const timeout = a.timeout ?? a.ms ?? a.seconds;
      if (typeof timeout === "number")
        return `${timeout}${a.seconds === undefined ? "ms" : "s"}`;
      const run = cleanString(a.runId || a.id || "");
      return run ? run.slice(0, 8) : "";
    }
    case "subagent":
      return cleanString(a.prompt || a.task || a.name || a.description || "");
    default: {
      const keys = [
        "command",
        "query",
        "pattern",
        "path",
        "file",
        "url",
        "prompt",
        "text",
        "name",
      ];
      for (const k of keys) {
        const v = a[k];
        if (typeof v === "string" && v.trim()) return cleanString(v);
      }
      return "";
    }
  }
}

function createRollingProcessExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const state: ProcessState = {
    runId: "",
    steps: [],
    snapshots: loadSnapshots(),
    maxVisibleLines: config.maxVisibleLines,
    localePref: config.locale,
    style: config.style,
    isAgentRunning: false,
    spinnerFrame: 0,
    entryCreated: false,
    thoughtBuffer: "",
    lastThoughtHeading: "",
    processExpanded: false,
  };

  function t() {
    return I18N[detectUiLang(state.localePref)];
  }

  function persistConfig() {
    saveConfig({
      maxVisibleLines: state.maxVisibleLines,
      locale: state.localePref,
      style: state.style,
    });
  }

  function paintFg(theme: Theme, color: string, text: string): string {
    try {
      return theme.fg(color as Parameters<Theme["fg"]>[0], text);
    } catch {
      return theme.fg("text", text);
    }
  }

  function withLiveUi(ctx: ExtensionContext, fn: () => void) {
    try {
      if (!ctx.hasUI) return;
      fn();
    } catch {
      // Session was replaced (/new, /reload, fork). Drop the stale ctx.
    }
  }

  const LIVE_WIDGET = "pi-minimal-mode";
  let unsubTerminalInput: (() => void) | undefined;

  function showLiveWidget(ctx: ExtensionContext) {
    withLiveUi(ctx, () => {
      ctx.ui.setWidget(
        LIVE_WIDGET,
        (_tui, theme) => ({
          render: (width: number) =>
            renderProcess(
              state.steps,
              width,
              theme,
              state.processExpanded,
              true,
            ),
          invalidate: () => {},
        }),
        { placement: "aboveEditor" },
      );
    });
  }

  function hideLiveWidget(ctx: ExtensionContext) {
    withLiveUi(ctx, () => {
      ctx.ui.setWidget(LIVE_WIDGET, undefined);
    });
  }

  function bindCtrlO(ctx: ExtensionContext) {
    unsubTerminalInput?.();
    if (!ctx.hasUI) return;
    unsubTerminalInput = ctx.ui.onTerminalInput((data) => {
      if (!state.isAgentRunning) return;
      if (matchesKey(data, "ctrl+o")) {
        toggleProcessExpanded(ctx);
        return { consume: true };
      }
    });
  }

  function persistCurrentRun() {
    if (!state.runId || state.steps.length === 0) return;
    state.snapshots.set(state.runId, cloneSteps(state.steps));
    saveSnapshots(state.snapshots);
  }

  function stepsFor(runId: string | undefined): StepItem[] {
    if (runId && runId === state.runId) return state.steps;
    if (runId && state.snapshots.has(runId))
      return state.snapshots.get(runId) ?? [];
    return [];
  }

  function renderProcess(
    steps: StepItem[],
    width: number,
    theme: Theme,
    expanded: boolean,
    live: boolean,
  ): string[] {
    const ui = t();
    const style = state.style;
    const list = [...steps];
    const hasRunning = list.some((step) => step.status === "running");
    if (live && state.isAgentRunning && !hasRunning) {
      list.push({
        id: "working",
        index: steps.length + 1,
        type: "thought",
        name: "thinking",
        detail: ui.working,
        status: "running",
        startTime: state.workingStartedAt ?? Date.now(),
      });
    }
    const visible = expanded ? list : list.slice(-state.maxVisibleLines);
    const realShown = visible.filter((step) => step.id !== "working").length;
    const hiddenCount = Math.max(0, steps.length - realShown);
    const lines: string[] = [];

    if (style.showHeader) {
      const shown = expanded ? steps.length : realShown;
      const count = `${shown}/${steps.length}`;
      const parts = [`${ui.title} ${count}`];
      if (!expanded && hiddenCount > 0) parts.push(ui.folded(hiddenCount));
      parts.push(expanded ? ui.collapseHint : ui.expandHint);
      lines.push(paintFg(theme, style.colors.header, parts.join(" · ")));
    }

    for (const step of visible) {
      const durCol = paintFg(
        theme,
        style.colors.duration,
        padDuration(style.showDuration ? stepDurationText(step) : ""),
      );

      let iconText = style.icons.done;
      let iconColor = style.colors.done;
      if (step.status === "running") {
        iconText =
          SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length] ??
          style.icons.running;
        iconColor = style.colors.running;
      } else if (step.status === "error") {
        iconText = style.icons.error;
        iconColor = style.colors.error;
      } else if (step.status === "aborted") {
        iconText = style.icons.aborted;
        iconColor = style.colors.aborted;
      }
      const icon = paintFg(theme, iconColor, padIcon(iconText));

      const kind = style.showKind
        ? paintFg(
            theme,
            style.colors.kind,
            `${kindLabel(step.name, step.type, detectUiLang(state.localePref), ui.thought)} `,
          )
        : "";
      const index = style.showStepIndex ? `${step.index}. ` : "";
      const preview = step.detail
        ? step.type === "thought"
          ? paintFg(theme, "dim", step.detail)
          : step.detail
        : "";
      const extra =
        style.showResult && step.resultSummary
          ? paintFg(
              theme,
              "dim",
              `${preview ? " -> " : ""}${step.resultSummary}`,
            )
          : "";
      lines.push(`${durCol} ${icon} ${kind}${index}${preview}${extra}`);
    }

    if (live && !expanded) {
      const header = style.showHeader ? 1 : 0;
      while (lines.length - header < state.maxVisibleLines) lines.push("");
    }

    if (lines.length === 0) return [];
    if (style.preset === "panel")
      return paintPanel(lines, width, theme, panelBg(live, steps));
    if (style.preset === "plain" || style.border === "none")
      return lines.map((line) => fit(line, width));
    return paintBox(lines, width, theme, style);
  }

  function panelBg(
    live: boolean,
    steps: StepItem[],
  ): "toolPendingBg" | "toolSuccessBg" | "toolErrorBg" {
    if (live && state.isAgentRunning) return "toolPendingBg";
    if (steps.some((step) => step.status === "error")) return "toolErrorBg";
    return "toolSuccessBg";
  }

  function paintPanel(
    lines: string[],
    width: number,
    theme: Theme,
    bgKey: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg",
  ): string[] {
    const inner = Math.max(1, width);
    const bg = (text: string) => theme.bg(bgKey, text);
    const fill = (line: string) => {
      const fitted = fit(line, inner);
      return bg(fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted))));
    };
    const blank = bg(" ".repeat(inner));
    return [blank, ...lines.map(fill), blank];
  }

  function paintBox(
    lines: string[],
    width: number,
    theme: Theme,
    style: ProcessStyle,
  ): string[] {
    const border = BORDERS[style.border === "none" ? "single" : style.border];
    const inner = Math.max(1, width - 2);
    const color = (text: string) => paintFg(theme, style.colors.border, text);
    const topTitle = lines[0] ?? "";
    const body = style.showHeader ? lines.slice(1) : lines;
    const titlePlain = style.showHeader
      ? fit(` ${topTitle} `, Math.max(0, width - 4))
      : "";
    const titleWidth = visibleWidth(titlePlain);
    const topMid = Math.max(0, width - 3 - titleWidth);
    const top = style.showHeader
      ? color(`${border.tl}${border.h}`) +
        titlePlain +
        color(border.h.repeat(topMid) + border.tr)
      : color(
          `${border.tl}${border.h.repeat(Math.max(0, width - 2))}${border.tr}`,
        );
    const framed = body.map((line) => {
      const fitted = fit(line, inner);
      return (
        color(border.v) +
        fitted +
        " ".repeat(Math.max(0, inner - visibleWidth(fitted))) +
        color(border.v)
      );
    });
    const bottom = color(
      `${border.bl}${border.h.repeat(Math.max(0, width - 2))}${border.br}`,
    );
    return [top, ...framed, bottom];
  }

  function tick() {
    state.spinnerFrame = (state.spinnerFrame + 1) % SPINNER_FRAMES.length;
  }

  function upsertThought(heading: string) {
    if (!heading || heading.length < 2) return;
    if (heading === state.lastThoughtHeading) return;
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
    }
    tick();
  }

  function finishRunningThought() {
    const last = state.steps.at(-1);
    if (last && last.type === "thought" && last.status === "running") {
      last.status = "done";
      last.endTime = Date.now();
      tick();
    }
    state.thoughtBuffer = "";
  }

  function toggleProcessExpanded(ctx?: ExtensionContext) {
    state.processExpanded = !state.processExpanded;
    if (ctx) {
      withLiveUi(ctx, () => {
        ctx.ui.notify(
          state.processExpanded
            ? t().expanded
            : t().collapsed(state.maxVisibleLines),
          "info",
        );
      });
    }
  }

  const boot = t();

  pi.registerEntryRenderer<RunSnapshot>(ENTRY_TYPE, (entry, _opts, theme) => {
    return {
      render: (width: number) =>
        renderProcess(
          stepsFor(entry.data?.runId),
          width,
          theme,
          state.processExpanded,
          entry.data?.runId === state.runId,
        ),
      invalidate: () => {},
    };
  });

  pi.registerCommand("process", {
    description: boot.cmdProcess,
    handler: async (_args, ctx) => toggleProcessExpanded(ctx),
  });

  pi.registerShortcut("ctrl+o", {
    description: boot.cmdProcess,
    handler: (ctx) => toggleProcessExpanded(ctx),
  });

  pi.registerCommand("process-lines", {
    description: boot.cmdLines,
    handler: async (args, ctx) => {
      const num = Number.parseInt(args.trim(), 10);
      if (!Number.isNaN(num) && num >= 1 && num <= 20) {
        state.maxVisibleLines = num;
        persistConfig();
        ctx.ui.notify(t().linesSet(num), "info");
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
      ctx.ui.notify(
        t().langSet(next === "auto" ? `auto → ${detectUiLang("auto")}` : next),
        "info",
      );
    },
  });

  pi.registerCommand("process-style", {
    description: boot.cmdStyle,
    handler: async (args, ctx) => {
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        ctx.ui.notify(t().styleNow(styleSummary(state.style)), "info");
        return;
      }
      if (parts[0] === "box" || parts[0] === "panel" || parts[0] === "plain") {
        state.style.preset = parts[0];
        persistConfig();
        ctx.ui.notify(t().styleSet(styleSummary(state.style)), "info");
        return;
      }
      if (
        parts[0] === "border" &&
        (parts[1] === "single" ||
          parts[1] === "rounded" ||
          parts[1] === "double" ||
          parts[1] === "none")
      ) {
        state.style.border = parts[1];
        persistConfig();
        ctx.ui.notify(t().styleSet(styleSummary(state.style)), "info");
        return;
      }
      ctx.ui.notify(t().styleHelp, "warning");
    },
  });

  pi.on("session_shutdown", () => {
    unsubTerminalInput?.();
    unsubTerminalInput = undefined;
    state.isAgentRunning = false;
    state.workingStartedAt = undefined;
    state.steps = [];
    state.runId = "";
    state.entryCreated = false;
  });

  pi.on("session_start", (_event, ctx) => {
    state.steps = [];
    state.runId = "";
    state.entryCreated = false;
    state.isAgentRunning = false;
    state.workingStartedAt = undefined;
    const loaded = loadConfig();
    state.snapshots = loadSnapshots();
    state.maxVisibleLines = loaded.maxVisibleLines;
    state.localePref = loaded.locale;
    state.style = loaded.style;
    hideLiveWidget(ctx);
    bindCtrlO(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    persistCurrentRun();
    state.isAgentRunning = true;
    state.workingStartedAt = Date.now();
    state.runId = `run-${Date.now()}`;
    state.steps = [];
    state.entryCreated = false;
    state.thoughtBuffer = "";
    state.lastThoughtHeading = "";
    state.processExpanded = false;
    showLiveWidget(ctx);
  });

  function abortRunningSteps() {
    const now = Date.now();
    for (const step of state.steps) {
      if (step.status === "running") {
        step.status = "aborted";
        step.endTime = now;
      }
    }
    state.thoughtBuffer = "";
  }

  pi.on("agent_end", (_event, ctx) => {
    abortRunningSteps();
    persistCurrentRun();
    state.isAgentRunning = false;
    state.workingStartedAt = undefined;
    state.processExpanded = false;
    hideLiveWidget(ctx);
  });

  pi.on("tool_execution_start", (event) => {
    finishRunningThought();
    state.steps.push({
      id: event.toolCallId,
      index: state.steps.length + 1,
      type: "tool",
      name: event.toolName,
      detail: getToolPreview(
        event.toolName,
        event.args as Record<string, unknown> | undefined,
      ),
      status: "running",
      startTime: Date.now(),
    });
    tick();
  });

  pi.on("tool_execution_end", (event) => {
    const item = state.steps.find((s) => s.id === event.toolCallId);
    if (item) {
      item.status = event.isError ? "error" : "done";
      item.endTime = Date.now();
      const content = event.result?.content;
      const text = Array.isArray(content)
        ? content.find(
            (c: { type?: string; text?: string }) => c?.type === "text",
          )?.text
        : undefined;
      if (typeof text === "string" && text.trim()) {
        const lines = text.trim().split("\n").filter(Boolean);
        item.resultSummary =
          lines.length === 1
            ? cleanString(lines[0]).slice(0, 40)
            : t().linesOut(lines.length);
      }
    }
    tick();
  });

  pi.on("message_update", (event) => {
    const ev = event.assistantMessageEvent as
      | { type?: string; thinking?: string; delta?: string; content?: string }
      | undefined;
    if (!ev?.type) return;

    if (ev.type === "thinking_start") {
      state.thoughtBuffer = "";
      return;
    }

    if (
      ev.type === "thinking_delta" ||
      ev.type === "thinking_end" ||
      ev.type.startsWith("thinking")
    ) {
      const chunk = ev.delta ?? ev.thinking ?? ev.content ?? "";
      if (ev.type === "thinking_delta" && typeof chunk === "string")
        state.thoughtBuffer += chunk;
      else if (typeof ev.thinking === "string" && ev.thinking.trim())
        state.thoughtBuffer = ev.thinking;
      const heading = extractThoughtHeading(state.thoughtBuffer);
      if (heading) upsertThought(heading);
      if (ev.type === "thinking_end") finishRunningThought();
      return;
    }

    if (ev.type === "text_start" || ev.type === "text_end") {
      finishRunningThought();
    }
  });
}

export default function (pi: ExtensionAPI) {
  createRollingProcessExtension(pi);
}
