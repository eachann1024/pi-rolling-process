/**
 * Rolling process TUI block: user message → step list → assistant reply.
 * Collapsed height is monotonic within a run; ScrollView.updateLayout is
 * patched so layout shrinks no longer re-latch pi's follow-end scroll.
 * Native tool cards are hidden via ToolExecutionComponent.render patch
 * (ctrl+alt+o / app.tools.expand still shows the raw dump).
 * Assistant replies drop blank lines and get a line icon via
 * AssistantMessageComponent.render patch.
 */
import {
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  promises as fsPromises,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  getAgentDir,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  matchesKey,
  ScrollView,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

type StepCategory =
  | "builtin"
  | "skill"
  | "extension"
  | "subagent"
  | "thought"
  | "note";

interface StepItem {
  id: string;
  index: number;
  type: "tool" | "thought" | "note";
  category: StepCategory;
  name: string;
  detail: string;
  status: "running" | "done" | "error" | "aborted";
  startTime: number;
  endTime?: number;
  resultSummary?: string;
  noteSeq?: number;
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
    categories: Record<StepCategory, string>;
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
  hideNativeTools: boolean;
  hideWorkingIndicator: boolean;
  hideThinkingLabel: boolean;
  compactAssistantText: boolean;
  assistantLineIcon: string;
}

interface ProcessState {
  runId: string;
  steps: StepItem[];
  stepById: Map<string, StepItem>;
  snapshots: Map<string, StepItem[]>;
  runningToolStepIndex: number;
  hasError: boolean;
  hasAborted: boolean;
  maxVisibleLines: number;
  localePref: LocalePref;
  style: ProcessStyle;
  hideNativeTools: boolean;
  hideWorkingIndicator: boolean;
  hideThinkingLabel: boolean;
  compactAssistantText: boolean;
  assistantLineIcon: string;
  isAgentRunning: boolean;
  workingStartedAt?: number;
  workingEndedAt?: number;
  entryCreated: boolean;
  thoughtBuffer: string;
  thoughtLineLocked: boolean;
  lastThoughtHeading: string;
  expandedRunId: string;
  lastEntryRunId: string;
}

const ENTRY_TYPE = "pi-rolling-process";
const TUI_PROBE_KEY = "pi-rolling-process-tui-probe";
const CONFIG_PATH = join(getAgentDir(), "rolling-process.json");
const SNAP_PATH = join(getAgentDir(), "rolling-process-runs.json");
const SNAPSHOT_KEEP = 80;
const SNAPSHOT_FLUSH_MS = 200;
const PREVIEW_MAX = 240;
const THOUGHT_HEADING_MAX = 240;
const DURATION_COL = 6;
const ICON_COL = 2;
// 4×4 dot square across two braille cells, clockwise from top-left.
const SPINNER_FRAMES = [
  "⠁⠀",
  "⠈⠀",
  "⠀⠁",
  "⠀⠈",
  "⠀⠐",
  "⠀⠠",
  "⠀⢀",
  "⠀⡀",
  "⢀⠀",
  "⡀⠀",
  "⠄⠀",
  "⠂⠀",
];
const SPINNER_INTERVAL_MS = 100;
const BUILTIN_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
]);
const SKILL_PATH_RE = /\/skills\/|SKILL\.md|\/\.agents\//;
const PATCH_FLAG = Symbol.for("pi-rolling-process.toolRenderPatched");
const HIDDEN_GETTER = Symbol.for("pi-rolling-process.toolHiddenGetter");
const SCROLL_FOLLOW_PATCH_FLAG = Symbol.for(
  "pi-rolling-process.scrollFollowPatched",
);
const ASSISTANT_PATCH_FLAG = Symbol.for(
  "pi-rolling-process.assistantRenderPatched",
);
const ASSISTANT_COMPACT_GETTER = Symbol.for(
  "pi-rolling-process.assistantCompactGetter",
);
const ASSISTANT_ICON_GETTER = Symbol.for(
  "pi-rolling-process.assistantLineIconGetter",
);

const DEFAULT_CATEGORY_COLORS: Record<StepCategory, string> = {
  builtin: "muted",
  skill: "success",
  extension: "success",
  subagent: "accent",
  thought: "dim",
  note: "warning",
};

const EMPTY_COMPONENT: Component = {
  render: () => [],
  invalidate: () => {},
};

let themeEpoch = 0;
let lastSeenTheme: Theme | undefined;
const padIconMemo = new Map<string, string>();

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
    categories: { ...DEFAULT_CATEGORY_COLORS },
    duration: "success",
    done: "success",
    error: "error",
    running: "warning",
    aborted: "warning",
  },
};

const ASSISTANT_WEATHER_ICONS = [
  "☀️",
  "🌤️",
  "⛅",
  "🌥️",
  "☁️",
  "🌦️",
  "🌧️",
  "⛈️",
  "🌩️",
  "🌨️",
] as const;

const DEFAULT_ASSISTANT_LINE_ICON = ASSISTANT_WEATHER_ICONS[0];

function assistantLinePrefix(icon: string): string {
  return icon ? `${icon} ` : "";
}

function isWeatherCycleIcon(icon: string): boolean {
  const bare = icon.trim().replace(/️/g, "");
  return (ASSISTANT_WEATHER_ICONS as readonly string[]).some(
    (cycle) => cycle.replace(/️/g, "") === bare,
  );
}

function weatherLinePrefix(index: number): string {
  const glyph =
    ASSISTANT_WEATHER_ICONS[index % ASSISTANT_WEATHER_ICONS.length] ?? "☀️";
  return ` ${glyph}  `;
}

function assistantPrefixFor(icon: string, index: number): string {
  if (!icon) return "";
  if (isWeatherCycleIcon(icon)) return weatherLinePrefix(index);
  return assistantLinePrefix(icon);
}

function parseAssistantLineIcon(
  value: unknown,
  fallback = DEFAULT_ASSISTANT_LINE_ICON,
): string {
  if (typeof value !== "string") return fallback;
  return value.trim() === "" ? fallback : value;
}

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
    expandHint: "ctrl+o 展开 ctrl+alt+o 原始展开",
    collapseHint: "ctrl+o 收起 ctrl+alt+o 原始展开",
    thought: "思考",
    skill: "技能",
    subagent: "子代理",
    note: "说明",
    more: (n: number) => `··· +${n}`,
    linesOut: (n: number) => `${n} 行`,
    linesSet: (n: number) => `收起时显示最新 ${n} 条`,
    linesHelp: "请输入 1 到 20，例如: /process-lines 5",
    cmdProcess: "展开/收起极简模式（ctrl+o；原生工具展开为 ctrl+alt+o）",
    cmdLines: "设置收起时显示的条数（默认 8）",
    thinkingNow: "思考中…",
    statusDone: (n: number) => `完成 · ${n} 步`,
    statusError: (n: number) => `出错 · ${n} 步`,
    statusAborted: (n: number) => `已中止 · ${n} 步`,
    cmdLang: "界面语言：auto / zh / en",
    langSet: (v: string) => `界面语言已设为 ${v}`,
    langHelp: "用法: /process-lang auto|zh|en",
    cmdStyle:
      "过程框样式：box / panel / plain，或 border single|rounded|double",
    styleSet: (v: string) => `过程样式已设为 ${v}`,
    styleNow: (v: string) => `当前样式 ${v}`,
    styleHelp:
      "用法: /process-style box|panel|plain  或  /process-style border single|rounded|double",
    cmdNative: "隐藏/显示工具卡片（折叠时生效，即时切换）",
    nativeSet: (hidden: boolean) =>
      hidden ? "已隐藏工具卡片" : "已显示工具卡片",
    nativeNow: (hidden: boolean) =>
      hidden ? "当前隐藏工具卡片" : "当前显示工具卡片",
    nativeHelp: "用法: /process-native on|off",
  },
  en: {
    title: "Minimal",
    expandHint: "ctrl+o expand ctrl+alt+o raw expand",
    collapseHint: "ctrl+o collapse ctrl+alt+o raw expand",
    thought: "think",
    skill: "skill",
    subagent: "subagent",
    note: "note",
    more: (n: number) => `··· +${n}`,
    linesOut: (n: number) => `${n} lines`,
    linesSet: (n: number) => `Collapsed view shows latest ${n}`,
    linesHelp: "Enter 1-20, e.g. /process-lines 5",
    cmdProcess:
      "Expand/collapse Minimal mode (ctrl+o; native tool dump is ctrl+alt+o)",
    cmdLines: "Rows shown when collapsed (default 8)",
    thinkingNow: "Thinking…",
    statusDone: (n: number) => `Done · ${n} steps`,
    statusError: (n: number) => `Error · ${n} steps`,
    statusAborted: (n: number) => `Aborted · ${n} steps`,
    cmdLang: "UI language: auto / zh / en",
    langSet: (v: string) => `UI language set to ${v}`,
    langHelp: "Usage: /process-lang auto|zh|en",
    cmdStyle:
      "Process style: box / panel / plain, or border single|rounded|double",
    styleSet: (v: string) => `Process style set to ${v}`,
    styleNow: (v: string) => `Current style ${v}`,
    styleHelp:
      "Usage: /process-style box|panel|plain  or  /process-style border single|rounded|double",
    cmdNative: "Hide/show tool cards when collapsed (instant toggle)",
    nativeSet: (hidden: boolean) =>
      hidden ? "Tool cards hidden" : "Tool cards shown",
    nativeNow: (hidden: boolean) =>
      hidden ? "Tool cards are hidden" : "Tool cards are shown",
    nativeHelp: "Usage: /process-native on|off",
  },
} as const;

function isZhTag(value: string): boolean {
  return /^zh\b/i.test(value.trim().replace(/_/g, "-"));
}

let appleLocaleMemo: string | undefined;
let autoLangMemo: UiLang | undefined;
let appleLocaleAllowed = false;

function readAppleLocale(): string {
  if (appleLocaleMemo !== undefined) return appleLocaleMemo;
  if (process.platform !== "darwin") {
    appleLocaleMemo = "";
    return appleLocaleMemo;
  }
  try {
    const { execSync } = createRequire(import.meta.url)(
      "node:child_process",
    ) as typeof import("node:child_process");
    appleLocaleMemo = execSync("defaults read -g AppleLocale", {
      encoding: "utf8",
      timeout: 800,
    }).trim();
  } catch {
    appleLocaleMemo = "";
  }
  return appleLocaleMemo;
}

function detectUiLang(pref: LocalePref): UiLang {
  if (pref === "zh" || pref === "en") return pref;
  if (autoLangMemo !== undefined) return autoLangMemo;
  const candidates = [
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale,
  ];
  for (const item of candidates) {
    if (item && isZhTag(item)) {
      autoLangMemo = "zh";
      return autoLangMemo;
    }
  }
  if (!appleLocaleAllowed) return "en";
  const apple = readAppleLocale();
  autoLangMemo = apple && isZhTag(apple) ? "zh" : "en";
  return autoLangMemo;
}

function capLine(text: string, max = PREVIEW_MAX): string {
  return text.length <= max ? text : text.slice(0, max);
}

function fitMeasured(line: string, width: number): { text: string; width: number } {
  const max = Math.max(0, width);
  if (max <= 0) return { text: "", width: 0 };
  let out = truncateToWidth(line, max);
  let measured = visibleWidth(out);
  let guard = 0;
  while (measured > max && guard < 12) {
    out = truncateToWidth(out, Math.max(0, max - 1 - guard));
    measured = visibleWidth(out);
    guard++;
  }
  return { text: out, width: measured };
}

function fit(line: string, width: number): string {
  return fitMeasured(line, width).text;
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
  const hit = padIconMemo.get(text);
  if (hit !== undefined) return hit;
  const w = visibleWidth(text);
  const out =
    w >= ICON_COL ? ` ${text}` : ` ${text}${" ".repeat(Math.max(0, ICON_COL - w))}`;
  padIconMemo.set(text, out);
  return out;
}

function stepDurationText(step: StepItem): string {
  if (step.category === "note") return "";
  if (step.status === "running") {
    if (step.startTime > 0) return formatDuration(Date.now() - step.startTime);
    return "";
  }
  if (step.endTime !== undefined && step.startTime > 0)
    return formatDuration(step.endTime - step.startTime);
  return "";
}

function currentSpinnerFrame(): string {
  return (
    SPINNER_FRAMES[
      Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length
    ] ?? "⠁"
  );
}

function hasRequestRender(
  tui: unknown,
): tui is { requestRender: () => void } {
  return typeof (tui as { requestRender?: unknown }).requestRender === "function";
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

function isSkillRelatedPath(value: string): boolean {
  return SKILL_PATH_RE.test(value);
}

function classifyToolCategory(
  toolName: string,
  args: Record<string, unknown> | undefined,
): StepCategory {
  const lower = toolName.toLowerCase();
  if (lower === "subagent" || lower.includes("subagent")) return "subagent";
  if (!BUILTIN_TOOLS.has(lower)) return "extension";
  if (lower === "read" || lower === "bash" || lower === "ls") {
    const raw =
      lower === "bash"
        ? cleanString(args?.command)
        : cleanString(args?.path);
    if (raw && isSkillRelatedPath(raw)) return "skill";
  }
  return "builtin";
}

function buildSkillDetail(
  toolName: string,
  args: Record<string, unknown> | undefined,
  preview: string,
): string {
  const lower = toolName.toLowerCase();
  const raw =
    lower === "bash" ? cleanString(args?.command) : cleanString(args?.path);
  const lineSuffix =
    lower === "read" && preview.includes(":")
      ? preview.slice(preview.indexOf(":"))
      : "";
  const skillsMatch = raw.match(/\/skills\/([^/]+)\/(.*)/);
  if (skillsMatch) return `${skillsMatch[1]}/${skillsMatch[2]}${lineSuffix}`;
  const agentsMatch = raw.match(/\/\.agents\/(.+)/);
  if (agentsMatch) return `${agentsMatch[1]}${lineSuffix}`;
  return preview;
}

function categoryKindLabel(step: StepItem, lang: UiLang): string {
  const ui = I18N[lang];
  switch (step.category) {
    case "thought":
      return ui.thought;
    case "skill":
      return ui.skill;
    case "subagent":
      return ui.subagent;
    case "note":
      return ui.note;
    case "extension":
      return step.name;
    case "builtin":
    default:
      return (
        TOOL_KIND[lang][step.name] ??
        TOOL_KIND[lang][step.name.toLowerCase()] ??
        step.name.replace(/_/g, " ")
      );
  }
}

function categoryColor(step: StepItem, style: ProcessStyle): string {
  return style.colors.categories[step.category] ?? style.colors.kind;
}

function normalizeStep(step: StepItem & { category?: StepCategory }): StepItem {
  if (step.category) return step;
  return {
    ...step,
    category:
      step.type === "thought"
        ? "thought"
        : step.type === "note"
          ? "note"
          : "builtin",
  };
}

function patchToolCards(isHidden: () => boolean) {
  const proto = ToolExecutionComponent.prototype as unknown as Record<
    PropertyKey,
    unknown
  >;
  proto[HIDDEN_GETTER] = isHidden;
  if (proto[PATCH_FLAG]) return;
  const original = proto.render;
  if (typeof original !== "function") return;
  proto[PATCH_FLAG] = true;
  proto.render = function (
    this: { expanded?: boolean },
    width: number,
  ): string[] {
    const hiddenGetter = proto[HIDDEN_GETTER] as (() => boolean) | undefined;
    if (hiddenGetter?.() && this.expanded !== true) return [];
    return (original as (this: unknown, w: number) => string[]).call(
      this,
      width,
    );
  };
}

type ScrollViewInternals = {
  followEnd: boolean;
  followingEnd: boolean;
  followSuppressedAtEnd: boolean;
  currentScrollTop: number;
  contentHeight: number;
  currentViewportHeight: number;
};

// pi-tui ScrollView re-latches follow-end whenever a layout shrink pulls
// maxScrollTop down to the cursor; that is a layout side effect, not the
// user scrolling back. Restore followingEnd=false in that case so an
// expanded transcript does not yank the user to the bottom on every frame.
function patchScrollViewFollow() {
  try {
    const proto = ScrollView.prototype as unknown as Record<
      PropertyKey,
      unknown
    >;
    if (proto[SCROLL_FOLLOW_PATCH_FLAG]) return;
    const original = proto.updateLayout;
    if (typeof original !== "function") return;
    proto[SCROLL_FOLLOW_PATCH_FLAG] = true;
    proto.updateLayout = function (
      this: ScrollViewInternals,
      contentHeight: number,
      viewportHeight: number,
      requestRender: () => void,
    ): void {
      const wasFollowing = this.followingEnd;
      const prevScrollTop = this.currentScrollTop;
      const prevMax = Math.max(
        0,
        this.contentHeight - this.currentViewportHeight,
      );
      (
        original as (
          this: unknown,
          c: number,
          v: number,
          r: () => void,
        ) => void
      ).call(this, contentHeight, viewportHeight, requestRender);
      const newMax = Math.max(
        0,
        this.contentHeight - this.currentViewportHeight,
      );
      if (
        !wasFollowing &&
        prevScrollTop < prevMax &&
        this.followingEnd &&
        newMax < prevMax
      ) {
        // Clamp landed the cursor exactly on the end; mark it suppressed so
        // further shrinks do not re-latch either. scrollBy/scrollTo/scrollToEnd
        // clear the flag, so deliberate scrolls to the bottom still follow.
        this.followingEnd = false;
        this.followSuppressedAtEnd = true;
      }
    };
  } catch {
    // ScrollView internals changed; keep stock pi-tui behavior.
  }
}

function isBlankAssistantLine(line: string): boolean {
  return stripTerminalSequences(line).trim() === "";
}

function compactAssistantLines(
  lines: string[],
  width: number,
  icon: string,
): string[] {
  const out: string[] = [];
  let index = 0;
  for (const line of lines) {
    if (isBlankAssistantLine(line)) continue;
    const prefix = assistantPrefixFor(icon, index);
    index++;
    out.push(fit(`${prefix}${line}`, width));
  }
  return out;
}

function patchAssistantMessages(
  isCompact: () => boolean,
  getIcon: () => string,
) {
  const proto = AssistantMessageComponent.prototype as unknown as Record<
    PropertyKey,
    unknown
  >;
  proto[ASSISTANT_COMPACT_GETTER] = isCompact;
  proto[ASSISTANT_ICON_GETTER] = getIcon;
  if (proto[ASSISTANT_PATCH_FLAG]) return;
  const original = proto.render;
  if (typeof original !== "function") return;
  proto[ASSISTANT_PATCH_FLAG] = true;
  proto.render = function (this: unknown, width: number): string[] {
    const compactGetter = proto[ASSISTANT_COMPACT_GETTER] as
      | (() => boolean)
      | undefined;
    const iconGetter = proto[ASSISTANT_ICON_GETTER] as
      | (() => string)
      | undefined;
    const compact = Boolean(compactGetter?.());
    if (!compact) {
      return (original as (this: unknown, w: number) => string[]).call(
        this,
        width,
      );
    }
    const self = this as { hasToolCalls?: boolean };
    // Intermediate notes already live in the process box; do not repeat them.
    if (self.hasToolCalls === true) return [];
    const icon =
      typeof iconGetter === "function"
        ? iconGetter()
        : DEFAULT_ASSISTANT_LINE_ICON;
    const prefix = assistantPrefixFor(icon, 0);
    const pw = visibleWidth(prefix);
    const inner = Math.max(0, width - pw);
    const lines = (original as (this: unknown, w: number) => string[]).call(
      this,
      inner,
    );
    return compactAssistantLines(lines, width, icon);
  };
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
  const categories: Record<StepCategory, string> = {
    ...DEFAULT_CATEGORY_COLORS,
  };
  const categoriesSrc =
    colors.categories && typeof colors.categories === "object"
      ? (colors.categories as Record<string, unknown>)
      : {};
  for (const key of Object.keys(DEFAULT_CATEGORY_COLORS) as StepCategory[]) {
    const value = categoriesSrc[key];
    if (typeof value === "string" && value.trim()) categories[key] = value;
  }
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
      categories,
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
    maxVisibleLines: 8,
    locale: "auto",
    hideNativeTools: true,
    hideWorkingIndicator: true,
    hideThinkingLabel: true,
    compactAssistantText: true,
    assistantLineIcon: DEFAULT_ASSISTANT_LINE_ICON,
    style: {
      ...DEFAULT_STYLE,
      icons: { ...DEFAULT_STYLE.icons },
      colors: {
        ...DEFAULT_STYLE.colors,
        categories: { ...DEFAULT_STYLE.colors.categories },
      },
    },
  };
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
      maxVisibleLines?: unknown;
      locale?: unknown;
      style?: unknown;
      hideNativeTools?: unknown;
      hideWorkingIndicator?: unknown;
      hideThinkingLabel?: unknown;
      compactAssistantText?: unknown;
      assistantLineIcon?: unknown;
    };
    const n = Number(parsed.maxVisibleLines);
    if (Number.isInteger(n) && n >= 1 && n <= 20) fallback.maxVisibleLines = n;
    fallback.locale = parseLocalePref(parsed.locale) ?? "auto";
    fallback.style = parseStyle(parsed.style);
    if (typeof parsed.hideNativeTools === "boolean")
      fallback.hideNativeTools = parsed.hideNativeTools;
    if (typeof parsed.hideWorkingIndicator === "boolean")
      fallback.hideWorkingIndicator = parsed.hideWorkingIndicator;
    if (typeof parsed.hideThinkingLabel === "boolean")
      fallback.hideThinkingLabel = parsed.hideThinkingLabel;
    if (typeof parsed.compactAssistantText === "boolean")
      fallback.compactAssistantText = parsed.compactAssistantText;
    fallback.assistantLineIcon = parseAssistantLineIcon(
      parsed.assistantLineIcon,
    );
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
      if (run?.runId && Array.isArray(run.steps))
        map.set(run.runId, run.steps.map((step) => normalizeStep(step)));
    }
  } catch {
    // first run
  }
  return map;
}

function snapshotFingerprint(steps: StepItem[]): string {
  let running = 0;
  let errors = 0;
  for (const step of steps) {
    if (step.status === "running") running++;
    else if (step.status === "error") errors++;
  }
  const last = steps.at(-1);
  return `${steps.length}:${running}:${errors}:${last?.id ?? ""}:${last?.status ?? ""}`;
}

function trimSnapshotMap(map: Map<string, StepItem[]>): [string, StepItem[]][] {
  const entries = [...map.entries()];
  const kept =
    entries.length > SNAPSHOT_KEEP ? entries.slice(-SNAPSHOT_KEEP) : entries;
  if (kept.length !== entries.length) {
    map.clear();
    for (const [runId, steps] of kept) map.set(runId, steps);
  }
  return kept;
}

function snapshotFileBody(kept: [string, StepItem[]][]): string {
  return `${JSON.stringify({
    runs: kept.map(([runId, steps]) => ({ runId, steps })),
  })}\n`;
}

let pendingSnapshotMap: Map<string, StepItem[]> | undefined;
let snapshotFlushTimer: ReturnType<typeof setTimeout> | undefined;
let snapshotWriteInFlight = false;
let snapshotWriteDirty = false;
let snapshotFlushPending = false;
let snapshotShutdownFlushed = false;

function snapshotTempPath(): string {
  return `${SNAP_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function saveSnapshots(map: Map<string, StepItem[]>) {
  trimSnapshotMap(map);
  pendingSnapshotMap = map;
  snapshotFlushPending = true;
  if (snapshotFlushTimer !== undefined) return;
  const timer = setTimeout(() => {
    snapshotFlushTimer = undefined;
    void writeSnapshotsAsync();
  }, SNAPSHOT_FLUSH_MS);
  (timer as { unref?: () => void }).unref?.();
  snapshotFlushTimer = timer;
}

async function writeSnapshotsAsync() {
  if (!pendingSnapshotMap || !snapshotFlushPending) return;
  if (snapshotWriteInFlight) {
    snapshotWriteDirty = true;
    return;
  }
  snapshotWriteInFlight = true;
  snapshotFlushPending = false;
  snapshotWriteDirty = false;
  const body = snapshotFileBody(trimSnapshotMap(pendingSnapshotMap));
  const tmpPath = snapshotTempPath();
  try {
    await fsPromises.writeFile(tmpPath, body, "utf8");
    if (snapshotShutdownFlushed) {
      try {
        await fsPromises.unlink(tmpPath);
      } catch {
        // ignore cleanup errors
      }
    } else {
      await fsPromises.rename(tmpPath, SNAP_PATH);
    }
  } catch {
    // ignore write errors
    try {
      await fsPromises.unlink(tmpPath);
    } catch {
      // ignore cleanup errors
    }
  } finally {
    snapshotWriteInFlight = false;
    if (snapshotWriteDirty) {
      snapshotWriteDirty = false;
      snapshotFlushPending = true;
      void writeSnapshotsAsync();
    }
  }
}

function flushSnapshotsSync() {
  if (snapshotFlushTimer !== undefined) {
    clearTimeout(snapshotFlushTimer);
    snapshotFlushTimer = undefined;
  }
  if (
    !pendingSnapshotMap ||
    (!snapshotFlushPending && !snapshotWriteDirty && !snapshotWriteInFlight)
  ) {
    return;
  }
  snapshotShutdownFlushed = true;
  snapshotFlushPending = false;
  snapshotWriteDirty = false;
  const tmpPath = snapshotTempPath();
  try {
    writeFileSync(
      tmpPath,
      snapshotFileBody(trimSnapshotMap(pendingSnapshotMap)),
      "utf8",
    );
    renameSync(tmpPath, SNAP_PATH);
  } catch {
    // ignore write errors
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
  }
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
    stepById: new Map(),
    snapshots: loadSnapshots(),
    runningToolStepIndex: -1,
    hasError: false,
    hasAborted: false,
    maxVisibleLines: config.maxVisibleLines,
    localePref: config.locale,
    style: config.style,
    hideNativeTools: config.hideNativeTools,
    hideWorkingIndicator: config.hideWorkingIndicator,
    hideThinkingLabel: config.hideThinkingLabel,
    compactAssistantText: config.compactAssistantText,
    assistantLineIcon: config.assistantLineIcon,
    isAgentRunning: false,
    entryCreated: false,
    thoughtBuffer: "",
    thoughtLineLocked: false,
    lastThoughtHeading: "",
    expandedRunId: "",
    lastEntryRunId: "",
  };

  patchToolCards(() => state.hideNativeTools);
  patchAssistantMessages(
    () => state.compactAssistantText,
    () => state.assistantLineIcon,
  );
  patchScrollViewFollow();

  let capturedTui: { requestRender: () => void } | undefined;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let persistedFingerprint = "";
  const renderCache = new Map<string, { sig: string; lines: string[] }>();
  let stepLineMemo = new WeakMap<StepItem, { sig: string; line: string }>();
  type LiveCap = { left: string; right: string; prefixLen: number };
  let liveStable:
    | {
        runId: string;
        themeEpoch: number;
        width: number;
        expanded: boolean;
        lang: UiLang;
        maxVisibleLines: number;
        stepsGen: number;
        stepsLength: number;
        preset: StylePreset;
        border: BorderStyle;
        showHeader: boolean;
        showKind: boolean;
        showDuration: boolean;
        showStepIndex: boolean;
        showResult: boolean;
        lines: string[];
        running: (LiveCap & { slot: number; index: number })[];
        statusSlot: number;
        statusCap: LiveCap | undefined;
      }
    | undefined;
  let boxEdgeCache: { key: string; top: string; bottom: string } | undefined;
  let stepsGen = 0;

  function t() {
    return I18N[detectUiLang(state.localePref)];
  }

  function bustRenderCache() {
    renderCache.clear();
    stepLineMemo = new WeakMap();
    liveStable = undefined;
    boxEdgeCache = undefined;
  }

  function bumpStepsGen() {
    stepsGen++;
    liveStable = undefined;
  }

  function persistConfig(ctx?: ExtensionContext) {
    bustRenderCache();
    saveConfig({
      maxVisibleLines: state.maxVisibleLines,
      locale: state.localePref,
      style: state.style,
      hideNativeTools: state.hideNativeTools,
      hideWorkingIndicator: state.hideWorkingIndicator,
      hideThinkingLabel: state.hideThinkingLabel,
      compactAssistantText: state.compactAssistantText,
      assistantLineIcon: state.assistantLineIcon,
    });
    if (ctx) applyUiPreferences(ctx, true);
  }

  let lastAppliedUiPrefs = "";

  function applyUiPreferences(ctx: ExtensionContext, force = false) {
    const fingerprint = `${state.hideWorkingIndicator}|${state.hideThinkingLabel}`;
    if (!force && fingerprint === lastAppliedUiPrefs) return;
    lastAppliedUiPrefs = fingerprint;
    withLiveUi(ctx, () => {
      if (state.hideWorkingIndicator) {
        try {
          ctx.ui.setWorkingVisible(false);
        } catch {
          // API missing on older pi builds
        }
      } else {
        try {
          ctx.ui.setWorkingVisible(true);
        } catch {
          // API missing on older pi builds
        }
      }
      if (state.hideThinkingLabel) {
        try {
          ctx.ui.setHiddenThinkingLabel("");
        } catch {
          // API missing on older pi builds
        }
      } else {
        try {
          ctx.ui.setHiddenThinkingLabel(undefined);
        } catch {
          // API missing on older pi builds
        }
      }
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

  let renderPending = false;
  let lastExternalRenderAt = 0;
  let lastSpinnerFingerprint = "";

  function kickRender() {
    if (renderPending) return;
    renderPending = true;
    queueMicrotask(() => {
      renderPending = false;
      capturedTui?.requestRender();
    });
  }

  function captureTui(ctx: ExtensionContext) {
    withLiveUi(ctx, () => {
      ctx.ui.setWidget(TUI_PROBE_KEY, (tui) => {
        if (hasRequestRender(tui)) capturedTui = tui;
        return EMPTY_COMPONENT;
      });
      if (capturedTui) ctx.ui.setWidget(TUI_PROBE_KEY, undefined);
    });
  }

  function startSpinnerTimer() {
    if (spinnerTimer !== undefined) return;
    lastSpinnerFingerprint = "";
    const timer = setInterval(() => {
      if (!state.isAgentRunning) {
        stopSpinnerTimer();
        return;
      }
      if (!capturedTui) return;
      if (Date.now() - lastExternalRenderAt < 50) return;
      const frameIndex =
        Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
      const fingerprint = `${frameIndex}:${formatDuration(runElapsedMs(state.steps, true))}`;
      if (fingerprint === lastSpinnerFingerprint) return;
      lastSpinnerFingerprint = fingerprint;
      kickRender();
    }, SPINNER_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
    spinnerTimer = timer;
  }

  function stopSpinnerTimer() {
    if (spinnerTimer === undefined) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  }

  let unsubTerminalInput: (() => void) | undefined;

  function ensureTranscriptEntry() {
    if (state.entryCreated || !state.runId) return;
    state.entryCreated = true;
    state.lastEntryRunId = state.runId;
    pi.appendEntry<RunSnapshot>(ENTRY_TYPE, { runId: state.runId, steps: [] });
  }

  function latestEntryRunId(ctx: ExtensionContext): string {
    try {
      const branch = ctx.sessionManager?.getBranch?.() ?? [];
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i] as
          | { type?: string; customType?: string; data?: { runId?: unknown } }
          | undefined;
        if (
          entry?.type === "custom" &&
          entry.customType === ENTRY_TYPE &&
          typeof entry.data?.runId === "string"
        )
          return entry.data.runId;
      }
    } catch {
      // no readable session entries
    }
    return "";
  }

  // Pi reserves ctrl+o for app.tools.expand, so registerShortcut("ctrl+o")
  // never fires; terminal input is the only path that sees the key.
  function bindCtrlO(ctx: ExtensionContext) {
    unsubTerminalInput?.();
    if (!ctx.hasUI) return;
    unsubTerminalInput = ctx.ui.onTerminalInput((data) => {
      if (!state.isAgentRunning && !state.entryCreated && !state.lastEntryRunId)
        return;
      if (matchesKey(data, "ctrl+o")) {
        toggleProcessExpanded();
        return { consume: true };
      }
    });
  }

  function persistCurrentRun() {
    if (!state.runId || state.steps.length === 0) return;
    const fingerprint = snapshotFingerprint(state.steps);
    if (
      persistedFingerprint === `${state.runId}:${fingerprint}` &&
      state.snapshots.has(state.runId)
    ) {
      return;
    }
    state.snapshots.set(state.runId, cloneSteps(state.steps));
    persistedFingerprint = `${state.runId}:${fingerprint}`;
    saveSnapshots(state.snapshots);
    if (renderCache.size > SNAPSHOT_KEEP + 4) {
      for (const key of renderCache.keys()) {
        if (key !== state.runId && !state.snapshots.has(key))
          renderCache.delete(key);
      }
    }
  }

  function stepsFor(runId: string | undefined): StepItem[] {
    if (runId && runId === state.runId) return state.steps;
    if (runId && state.snapshots.has(runId))
      return state.snapshots.get(runId) ?? [];
    return [];
  }

  function runElapsedMs(steps: StepItem[], live: boolean): number {
    if (live && state.workingStartedAt) {
      const end = state.isAgentRunning
        ? Date.now()
        : (state.workingEndedAt ?? Date.now());
      return Math.max(0, end - state.workingStartedAt);
    }
    let minStart = Infinity;
    let maxEnd = 0;
    for (const step of steps) {
      if (step.startTime > 0 && step.startTime < minStart)
        minStart = step.startTime;
      const end = step.endTime ?? step.startTime;
      if (end > maxEnd) maxEnd = end;
    }
    if (!Number.isFinite(minStart) || maxEnd <= 0) return 0;
    return Math.max(0, maxEnd - minStart);
  }

  function runOutcome(steps: StepItem[]): "done" | "error" | "aborted" {
    if (steps === state.steps) {
      if (state.hasError) return "error";
      if (state.hasAborted) return "aborted";
      return "done";
    }
    if (steps.some((step) => step.status === "error")) return "error";
    if (steps.some((step) => step.status === "aborted")) return "aborted";
    return "done";
  }

  let stepMemoStyleSig = "";

  function styleMemoSig(lang: UiLang): string {
    const s = state.style;
    return [
      themeEpoch,
      lang,
      s.showKind ? 1 : 0,
      s.showDuration ? 1 : 0,
      s.showStepIndex ? 1 : 0,
      s.showResult ? 1 : 0,
      s.icons.done,
      s.icons.error,
      s.icons.aborted,
      s.colors.duration,
      s.colors.done,
      s.colors.error,
      s.colors.aborted,
      s.colors.kind,
      s.colors.categories.builtin,
      s.colors.categories.skill,
      s.colors.categories.extension,
      s.colors.categories.subagent,
      s.colors.categories.thought,
      s.colors.categories.note,
    ].join("\t");
  }

  function paintDurationCol(theme: Theme, text: string): string {
    return paintFg(
      theme,
      state.style.colors.duration,
      padDuration(state.style.showDuration ? text : ""),
    );
  }

  function stepIconText(step: StepItem): { iconText: string; iconColor: string } {
    const style = state.style;
    if (step.status === "running")
      return { iconText: currentSpinnerFrame(), iconColor: style.colors.running };
    if (step.type === "note") {
      const seq = Math.max(1, step.noteSeq ?? 1);
      return {
        iconText:
          ASSISTANT_WEATHER_ICONS[
            (seq - 1) % ASSISTANT_WEATHER_ICONS.length
          ] ?? "☀️",
        iconColor: style.colors.categories.note,
      };
    }
    if (step.status === "error")
      return { iconText: style.icons.error, iconColor: style.colors.error };
    if (step.status === "aborted")
      return { iconText: style.icons.aborted, iconColor: style.colors.aborted };
    return { iconText: style.icons.done, iconColor: style.colors.done };
  }

  function stepLivePrefix(step: StepItem, theme: Theme): string {
    const { iconText, iconColor } = stepIconText(step);
    return (
      paintDurationCol(theme, stepDurationText(step)) +
      paintFg(theme, iconColor, padIcon(iconText))
    );
  }

  function statusLivePrefix(
    steps: StepItem[],
    theme: Theme,
    live: boolean,
  ): string {
    const elapsed = formatDuration(runElapsedMs(steps, live));
    const durCol = paintDurationCol(theme, elapsed);
    if (live && state.isAgentRunning) {
      return (
        durCol +
        paintFg(
          theme,
          state.style.colors.running,
          padIcon(currentSpinnerFrame()),
        )
      );
    }
    const outcome = runOutcome(steps);
    const iconKey =
      outcome === "error" ? "error" : outcome === "aborted" ? "aborted" : "done";
    return (
      durCol +
      paintFg(
        theme,
        state.style.colors[iconKey],
        padIcon(state.style.icons[iconKey]),
      )
    );
  }

  function captureLiveSlot(
    paintedLine: string | undefined,
    prefix: string,
  ): LiveCap | undefined {
    if (!paintedLine || !prefix) return undefined;
    const at = paintedLine.indexOf(prefix);
    if (at < 0) return undefined;
    return {
      left: paintedLine.slice(0, at),
      right: paintedLine.slice(at + prefix.length),
      prefixLen: prefix.length,
    };
  }

  function spliceLiveLine(
    cap: LiveCap | undefined,
    prefix: string,
    fallback: () => string,
  ): { line: string; cap: LiveCap | undefined } {
    if (cap && prefix.length === cap.prefixLen)
      return { line: cap.left + prefix + cap.right, cap };
    const painted = fallback();
    return { line: painted, cap: captureLiveSlot(painted, prefix) ?? cap };
  }

  function renderStepLineCore(
    step: StepItem,
    theme: Theme,
    lang: UiLang,
    prefix = stepLivePrefix(step, theme),
  ): string {
    const style = state.style;
    const kind = style.showKind
      ? paintFg(
          theme,
          categoryColor(step, style),
          `${categoryKindLabel(step, lang)} `,
        )
      : "";
    const index = style.showStepIndex ? `${step.index}. ` : "";
    const preview = step.detail
      ? step.category === "thought"
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
    return `${prefix} ${kind}${index}${preview}${extra}`;
  }

  function renderStepLine(step: StepItem, theme: Theme, lang: UiLang): string {
    if (step.status === "running") return renderStepLineCore(step, theme, lang);
    const sig = `${stepMemoStyleSig || styleMemoSig(lang)}\t${step.status}\t${step.type}\t${step.category}\t${step.name}\t${step.detail}\t${step.resultSummary ?? ""}\t${step.startTime}\t${step.endTime ?? ""}\t${step.index}`;
    const hit = stepLineMemo.get(step);
    if (hit && hit.sig === sig) return hit.line;
    const line = renderStepLineCore(step, theme, lang);
    stepLineMemo.set(step, { sig, line });
    return line;
  }

  function renderStatusLine(
    steps: StepItem[],
    theme: Theme,
    live: boolean,
    prefix = statusLivePrefix(steps, theme, live),
  ): string {
    const ui = t();
    if (live && state.isAgentRunning) {
      let runningTool: StepItem | undefined;
      if (steps === state.steps) {
        runningTool =
          state.runningToolStepIndex >= 0
            ? state.steps[state.runningToolStepIndex]
            : undefined;
      } else {
        for (let i = steps.length - 1; i >= 0; i--) {
          const step = steps[i];
          if (step && step.status === "running" && step.type !== "note") {
            runningTool = step;
            break;
          }
        }
      }
      const label = runningTool
        ? categoryKindLabel(runningTool, detectUiLang(state.localePref))
        : ui.thinkingNow;
      return `${prefix} ${label}`;
    }
    const outcome = runOutcome(steps);
    const text =
      outcome === "error"
        ? ui.statusError(steps.length)
        : outcome === "aborted"
          ? ui.statusAborted(steps.length)
          : ui.statusDone(steps.length);
    return `${prefix} ${text}`;
  }

  function liveLayout(
    style: ProcessStyle,
    visCount: number,
  ): { firstStep: number; statusSlot: number } {
    if (style.preset === "panel") {
      const firstStep = 1 + (style.showHeader ? 1 : 0);
      return { firstStep, statusSlot: firstStep + visCount };
    }
    if (style.preset === "plain" || style.border === "none") {
      const firstStep = style.showHeader ? 1 : 0;
      return { firstStep, statusSlot: firstStep + visCount };
    }
    return { firstStep: 1, statusSlot: 1 + visCount };
  }

  function frameBoxLine(line: string, inner: number, vBar: string): string {
    const fitted = fitMeasured(line, inner);
    return (
      vBar + fitted.text + " ".repeat(Math.max(0, inner - fitted.width)) + vBar
    );
  }

  function framePanelLine(
    line: string,
    inner: number,
    bg: (text: string) => string,
  ): string {
    const fitted = fitMeasured(line, inner);
    return bg(fitted.text + " ".repeat(Math.max(0, inner - fitted.width)));
  }

  function frameContentLine(
    line: string,
    width: number,
    theme: Theme,
    style: ProcessStyle,
    bgKey: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg",
  ): string {
    if (style.preset === "panel") {
      return framePanelLine(line, Math.max(1, width), (text) =>
        theme.bg(bgKey, text),
      );
    }
    if (style.preset === "plain" || style.border === "none") {
      return fit(line, width);
    }
    const border = BORDERS[style.border];
    const inner = Math.max(1, width - 2);
    return fit(
      frameBoxLine(line, inner, paintFg(theme, style.colors.border, border.v)),
      width,
    );
  }

  // Height is monotonic within a run (collapsed). Shrinking retriggers
  // pi ScrollView follow-end (scroll-view.js updateLayout).
  function renderProcess(
    runId: string | undefined,
    steps: StepItem[],
    width: number,
    theme: Theme,
    expanded: boolean,
    live: boolean,
  ): string[] {
    const ui = t();
    const lang = detectUiLang(state.localePref);
    const style = state.style;
    const liveRunning = live && state.isAgentRunning;
    const cacheable = Boolean(runId) && !liveRunning;
    const cacheKey = runId ?? "";
    const sig = cacheable
      ? [
          themeEpoch,
          width,
          expanded ? 1 : 0,
          lang,
          state.maxVisibleLines,
          style.preset,
          style.border,
          style.showHeader ? 1 : 0,
          steps.length,
          runOutcome(steps),
          steps.at(-1)?.id ?? "",
          steps.at(-1)?.status ?? "",
          styleMemoSig(lang),
        ].join("\t")
      : "";
    if (cacheable) {
      const hit = renderCache.get(cacheKey);
      if (hit && hit.sig === sig) return hit.lines;
    }

    const visStart = expanded
      ? 0
      : Math.max(0, steps.length - state.maxVisibleLines);
    const visCount = steps.length - visStart;

    const liveHot = Boolean(liveRunning && runId);
    if (liveHot && liveStable && liveStable.runId === runId) {
      const c = liveStable;
      if (
        c.themeEpoch === themeEpoch &&
        c.width === width &&
        c.expanded === expanded &&
        c.lang === lang &&
        c.maxVisibleLines === state.maxVisibleLines &&
        c.stepsGen === stepsGen &&
        c.stepsLength === steps.length &&
        c.preset === style.preset &&
        c.border === style.border &&
        c.showHeader === style.showHeader &&
        c.showKind === style.showKind &&
        c.showDuration === style.showDuration &&
        c.showStepIndex === style.showStepIndex &&
        c.showResult === style.showResult
      ) {
        const bgKey = panelBg(live, steps);
        for (const item of c.running) {
          const step = steps[item.index];
          if (!step) continue;
          const prefix = stepLivePrefix(step, theme);
          const next = spliceLiveLine(item, prefix, () =>
            frameContentLine(
              renderStepLineCore(step, theme, lang, prefix),
              width,
              theme,
              style,
              bgKey,
            ),
          );
          c.lines[item.slot] = next.line;
          if (next.cap) {
            item.left = next.cap.left;
            item.right = next.cap.right;
            item.prefixLen = next.cap.prefixLen;
          }
        }
        const statusPrefix = statusLivePrefix(steps, theme, live);
        const statusNext = spliceLiveLine(c.statusCap, statusPrefix, () =>
          frameContentLine(
            renderStatusLine(steps, theme, live, statusPrefix),
            width,
            theme,
            style,
            bgKey,
          ),
        );
        c.lines[c.statusSlot] = statusNext.line;
        if (statusNext.cap) c.statusCap = statusNext.cap;
        return c.lines;
      }
    } else if (!liveHot && liveStable && liveStable.runId === runId) {
      liveStable = undefined;
    }

    stepMemoStyleSig = styleMemoSig(lang);
    const lines: string[] = [];

    if (style.showHeader) {
      const shown = expanded ? steps.length : visCount;
      const parts = [
        steps.length === 0 ? ui.title : `${ui.title} ${shown}/${steps.length}`,
      ];
      parts.push(expanded ? ui.collapseHint : ui.expandHint);
      lines.push(paintFg(theme, style.colors.header, parts.join(" · ")));
    }

    const livePrefixes: { index: number; prefix: string }[] = [];
    let statusPrefix = "";
    for (let i = visStart; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      if (liveHot && step.status === "running") {
        const prefix = stepLivePrefix(step, theme);
        livePrefixes.push({ index: i, prefix });
        lines.push(renderStepLineCore(step, theme, lang, prefix));
      } else {
        lines.push(renderStepLine(step, theme, lang));
      }
    }
    if (liveHot) {
      statusPrefix = statusLivePrefix(steps, theme, live);
      lines.push(renderStatusLine(steps, theme, live, statusPrefix));
    } else {
      lines.push(renderStatusLine(steps, theme, live));
    }

    if (lines.length === 0) return [];
    let painted: string[];
    if (style.preset === "panel")
      painted = paintPanel(lines, width, theme, panelBg(live, steps));
    else if (style.preset === "plain" || style.border === "none")
      painted = lines.map((line) => fit(line, width));
    else painted = paintBox(lines, width, theme, style);

    if (liveHot && runId) {
      const { firstStep, statusSlot } = liveLayout(style, visCount);
      const running: (LiveCap & { slot: number; index: number })[] = [];
      for (const item of livePrefixes) {
        const slot = firstStep + (item.index - visStart);
        const cap = captureLiveSlot(painted[slot], item.prefix);
        running.push({
          slot,
          index: item.index,
          left: cap?.left ?? "",
          right: cap?.right ?? "",
          prefixLen: cap?.prefixLen ?? -1,
        });
      }
      liveStable = {
        runId,
        themeEpoch,
        width,
        expanded,
        lang,
        maxVisibleLines: state.maxVisibleLines,
        stepsGen,
        stepsLength: steps.length,
        preset: style.preset,
        border: style.border,
        showHeader: style.showHeader,
        showKind: style.showKind,
        showDuration: style.showDuration,
        showStepIndex: style.showStepIndex,
        showResult: style.showResult,
        lines: painted,
        running,
        statusSlot,
        statusCap: captureLiveSlot(painted[statusSlot], statusPrefix),
      };
    }

    if (cacheable && cacheKey)
      renderCache.set(cacheKey, { sig, lines: painted });
    return painted;
  }

  function panelBg(
    live: boolean,
    steps: StepItem[],
  ): "toolPendingBg" | "toolSuccessBg" | "toolErrorBg" {
    if (live && state.isAgentRunning) return "toolPendingBg";
    if (steps === state.steps)
      return state.hasError ? "toolErrorBg" : "toolSuccessBg";
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
    const blank = bg(" ".repeat(inner));
    const painted = new Array<string>(lines.length + 2);
    painted[0] = blank;
    for (let i = 0; i < lines.length; i++)
      painted[i + 1] = framePanelLine(lines[i]!, inner, bg);
    painted[painted.length - 1] = blank;
    return painted;
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
    const titleFitted = style.showHeader
      ? fitMeasured(` ${topTitle} `, Math.max(0, width - 4))
      : { text: "", width: 0 };
    const titlePlain = titleFitted.text;
    const titleWidth = titleFitted.width;
    const topMid = Math.max(0, width - 3 - titleWidth);
    const edgeKey = `${themeEpoch}\t${width}\t${style.border}\t${style.colors.border}\t${style.showHeader ? 1 : 0}\t${titlePlain}`;
    let top: string;
    let bottom: string;
    if (boxEdgeCache && boxEdgeCache.key === edgeKey) {
      top = boxEdgeCache.top;
      bottom = boxEdgeCache.bottom;
    } else {
      top = style.showHeader
        ? color(`${border.tl}${border.h}`) +
          titlePlain +
          color(border.h.repeat(topMid) + border.tr)
        : color(
            `${border.tl}${border.h.repeat(Math.max(0, width - 2))}${border.tr}`,
          );
      bottom = color(
        `${border.bl}${border.h.repeat(Math.max(0, width - 2))}${border.br}`,
      );
      boxEdgeCache = { key: edgeKey, top, bottom };
    }
    const vBar = color(border.v);
    const bodyStart = style.showHeader ? 1 : 0;
    const painted = new Array<string>(lines.length - bodyStart + 2);
    painted[0] = fit(top, width);
    let o = 1;
    for (let i = bodyStart; i < lines.length; i++)
      painted[o++] = fit(frameBoxLine(lines[i]!, inner, vBar), width);
    painted[o] = fit(bottom, width);
    return painted;
  }

  function resetRunAggregates() {
    state.stepById.clear();
    state.runningToolStepIndex = -1;
    state.hasError = false;
    state.hasAborted = false;
    bumpStepsGen();
  }

  function rememberStep(step: StepItem) {
    state.stepById.set(step.id, step);
    if (step.status === "running" && step.type !== "note") {
      state.runningToolStepIndex = state.steps.length - 1;
    }
    if (step.status === "error") state.hasError = true;
    if (step.status === "aborted") state.hasAborted = true;
    bumpStepsGen();
  }

  function markStepFinished(
    step: StepItem,
    next: "done" | "error" | "aborted",
  ) {
    const wasRunning = step.status === "running";
    step.status = next;
    bumpStepsGen();
    if (next === "error") state.hasError = true;
    if (next === "aborted") state.hasAborted = true;
    if (!wasRunning || step.type === "note") return;
    const i = state.runningToolStepIndex;
    if (i < 0 || state.steps[i] !== step) return;
    let found = -1;
    for (let j = i - 1; j >= 0; j--) {
      const prev = state.steps[j];
      if (prev && prev.status === "running" && prev.type !== "note") {
        found = j;
        break;
      }
    }
    state.runningToolStepIndex = found;
  }

  function upsertThought(heading: string) {
    if (!heading || heading.length < 2) return;
    if (heading === state.lastThoughtHeading) return;
    state.lastThoughtHeading = heading;
    const last = state.steps.at(-1);
    if (last && last.type === "thought" && last.status === "running") {
      const next = capLine(heading, THOUGHT_HEADING_MAX);
      if (next === last.detail) return;
      last.detail = next;
      bumpStepsGen();
    } else {
      state.steps.push({
        id: `thought-${Date.now()}`,
        index: state.steps.length + 1,
        type: "thought",
        category: "thought",
        name: "thinking",
        detail: capLine(heading, THOUGHT_HEADING_MAX),
        status: "running",
        startTime: Date.now(),
      });
      rememberStep(state.steps[state.steps.length - 1]!);
      ensureTranscriptEntry();
    }
  }

  function finishRunningThought() {
    const last = state.steps.at(-1);
    if (last && last.type === "thought" && last.status === "running") {
      last.endTime = Date.now();
      markStepFinished(last, "done");
    }
    state.thoughtBuffer = "";
    state.thoughtLineLocked = false;
  }

  function ingestThoughtChunk(chunk: string, replace: boolean) {
    if (state.thoughtLineLocked && !replace) return;
    const raw = replace ? chunk : `${state.thoughtBuffer}${chunk}`;
    const nl = raw.search(/\r?\n/);
    if (nl >= 0) {
      state.thoughtBuffer = capLine(raw.slice(0, nl), THOUGHT_HEADING_MAX);
      state.thoughtLineLocked = true;
    } else if (raw.length >= THOUGHT_HEADING_MAX) {
      state.thoughtBuffer = capLine(raw, THOUGHT_HEADING_MAX);
      state.thoughtLineLocked = true;
    } else {
      state.thoughtBuffer = raw;
    }
    const heading = extractThoughtHeading(state.thoughtBuffer);
    if (heading) upsertThought(heading);
  }

  function toggleProcessExpanded() {
    const target = state.runId || state.lastEntryRunId;
    if (!target) return;
    state.expandedRunId = state.expandedRunId === target ? "" : target;
    bustRenderCache();
    kickRender();
  }

  let commandsRegistered = false;

  function registerProcessCommands() {
    if (commandsRegistered) return;
    const boot = t();

    pi.registerCommand("process", {
      description: boot.cmdProcess,
      handler: async () => toggleProcessExpanded(),
    });

    pi.registerCommand("process-lines", {
      description: boot.cmdLines,
      handler: async (args, ctx) => {
        const num = Number.parseInt(args.trim(), 10);
        if (!Number.isNaN(num) && num >= 1 && num <= 20) {
          state.maxVisibleLines = num;
          persistConfig(ctx);
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
        persistConfig(ctx);
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
          persistConfig(ctx);
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
          persistConfig(ctx);
          ctx.ui.notify(t().styleSet(styleSummary(state.style)), "info");
          return;
        }
        ctx.ui.notify(t().styleHelp, "warning");
      },
    });

    pi.registerCommand("process-native", {
      description: boot.cmdNative,
      handler: async (args, ctx) => {
        const v = args.trim().toLowerCase();
        if (!v) {
          ctx.ui.notify(t().nativeNow(state.hideNativeTools), "info");
          return;
        }
        if (v === "on" || v === "off") {
          state.hideNativeTools = v === "on";
          persistConfig(ctx);
          ctx.ui.notify(t().nativeSet(state.hideNativeTools), "info");
          kickRender();
          return;
        }
        ctx.ui.notify(t().nativeHelp, "warning");
      },
    });
    commandsRegistered = true;
  }

  pi.registerEntryRenderer<RunSnapshot>(ENTRY_TYPE, (entry, _opts, theme) => {
    if (theme !== lastSeenTheme) {
      lastSeenTheme = theme;
      themeEpoch++;
      bustRenderCache();
    }
    const runId = entry.data?.runId;
    return {
      render: (width: number) =>
        renderProcess(
          runId,
          stepsFor(runId),
          width,
          theme,
          Boolean(runId && runId === state.expandedRunId),
          runId === state.runId,
        ),
      invalidate: () => {
        if (runId) renderCache.delete(runId);
        if (liveStable?.runId === runId) liveStable = undefined;
      },
    };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopSpinnerTimer();
    capturedTui = undefined;
    withLiveUi(ctx, () => {
      ctx.ui.setWidget(TUI_PROBE_KEY, undefined);
    });
    unsubTerminalInput?.();
    unsubTerminalInput = undefined;
    flushSnapshotsSync();
    state.isAgentRunning = false;
    state.workingStartedAt = undefined;
    state.workingEndedAt = undefined;
    state.steps = [];
    resetRunAggregates();
    state.runId = "";
    state.entryCreated = false;
    state.expandedRunId = "";
    state.lastEntryRunId = "";
    state.thoughtBuffer = "";
    state.thoughtLineLocked = false;
    persistedFingerprint = "";
    bustRenderCache();
  });

  pi.on("session_start", (event, ctx) => {
    appleLocaleAllowed = true;
    stopSpinnerTimer();
    capturedTui = undefined;
    state.steps = [];
    resetRunAggregates();
    state.runId = "";
    state.entryCreated = false;
    state.isAgentRunning = false;
    state.workingStartedAt = undefined;
    state.workingEndedAt = undefined;
    state.expandedRunId = "";
    state.thoughtBuffer = "";
    state.thoughtLineLocked = false;
    persistedFingerprint = "";
    state.lastEntryRunId = latestEntryRunId(ctx);
    if (event.reason === "reload") {
      const loaded = loadConfig();
      state.snapshots = loadSnapshots();
      state.maxVisibleLines = loaded.maxVisibleLines;
      state.localePref = loaded.locale;
      state.style = loaded.style;
      state.hideNativeTools = loaded.hideNativeTools;
      state.hideWorkingIndicator = loaded.hideWorkingIndicator;
      state.hideThinkingLabel = loaded.hideThinkingLabel;
      state.compactAssistantText = loaded.compactAssistantText;
      state.assistantLineIcon = loaded.assistantLineIcon;
    }
    snapshotShutdownFlushed = false;
    bustRenderCache();
    captureTui(ctx);
    registerProcessCommands();
    bindCtrlO(ctx);
    applyUiPreferences(ctx, true);
  });

  pi.on("agent_start", (_event, ctx) => {
    persistCurrentRun();
    state.isAgentRunning = true;
    state.workingStartedAt = Date.now();
    state.workingEndedAt = undefined;
    state.runId = `run-${Date.now()}`;
    state.steps = [];
    resetRunAggregates();
    state.entryCreated = false;
    state.thoughtBuffer = "";
    state.thoughtLineLocked = false;
    state.lastThoughtHeading = "";
    state.expandedRunId = "";
    if (!capturedTui) captureTui(ctx);
    applyUiPreferences(ctx);
    startSpinnerTimer();
  });

  pi.on("message_end", (event) => {
    if (!state.isAgentRunning) return;

    if (event.message?.role === "user") {
      ensureTranscriptEntry();
      return;
    }

    if (event.message?.role !== "assistant") return;
    finishRunningThought();
    const content = event.message.content;
    if (!Array.isArray(content)) return;

    const hasToolCall = content.some((block) => block.type === "toolCall");
    if (!hasToolCall) return;

    const textBlocks = content.filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    );
    if (textBlocks.length === 0) return;

    const noteLines = textBlocks
      .map((block) => block.text)
      .join("\n")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (noteLines.length === 0) return;

    const now = Date.now();
    let noteSeq = 0;
    for (const step of state.steps) {
      if (step.type === "note") noteSeq = step.noteSeq ?? noteSeq + 1;
    }
    for (const line of noteLines) {
      noteSeq += 1;
      state.steps.push({
        id: `note-${now}-${noteSeq}`,
        index: state.steps.length + 1,
        type: "note",
        category: "note",
        name: "note",
        detail: capLine(cleanString(line)),
        status: "done",
        startTime: now,
        endTime: now,
        noteSeq,
      });
      rememberStep(state.steps[state.steps.length - 1]!);
    }
    ensureTranscriptEntry();
    kickRender();
  });

  function abortRunningSteps() {
    const now = Date.now();
    let aborted = false;
    for (const step of state.steps) {
      if (step.status === "running") {
        step.status = "aborted";
        step.endTime = now;
        aborted = true;
      }
    }
    if (aborted) {
      state.hasAborted = true;
      state.runningToolStepIndex = -1;
      bumpStepsGen();
    }
    state.thoughtBuffer = "";
    state.thoughtLineLocked = false;
  }

  pi.on("agent_end", () => {
    stopSpinnerTimer();
    abortRunningSteps();
    persistCurrentRun();
    state.isAgentRunning = false;
    state.workingEndedAt = Date.now();
    ensureTranscriptEntry();
    kickRender();
  });

  pi.on("tool_execution_start", (event) => {
    finishRunningThought();
    const args = event.args as Record<string, unknown> | undefined;
    const category = classifyToolCategory(event.toolName, args);
    const preview = getToolPreview(event.toolName, args);
    const detail =
      category === "skill"
        ? buildSkillDetail(event.toolName, args, preview)
        : preview;
    state.steps.push({
      id: event.toolCallId,
      index: state.steps.length + 1,
      type: "tool",
      category,
      name: event.toolName,
      detail: capLine(detail),
      status: "running",
      startTime: Date.now(),
    });
    rememberStep(state.steps[state.steps.length - 1]!);
    ensureTranscriptEntry();
    lastExternalRenderAt = Date.now();
  });

  pi.on("tool_execution_end", (event) => {
    const item = state.stepById.get(event.toolCallId);
    if (item) {
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
      markStepFinished(item, event.isError ? "error" : "done");
    }
    lastExternalRenderAt = Date.now();
  });

  pi.on("message_update", (event) => {
    try {
      const ev = event.assistantMessageEvent as
        | { type?: string; thinking?: string; delta?: string; content?: string }
        | undefined;
      if (!ev?.type) return;

      if (ev.type === "thinking_start") {
        state.thoughtBuffer = "";
        state.thoughtLineLocked = false;
        return;
      }

      if (
        ev.type === "thinking_delta" ||
        ev.type === "thinking_end" ||
        ev.type.startsWith("thinking")
      ) {
        const chunk = ev.delta ?? ev.thinking ?? ev.content ?? "";
        if (ev.type === "thinking_delta" && typeof chunk === "string")
          ingestThoughtChunk(chunk, false);
        else if (typeof ev.thinking === "string" && ev.thinking.trim())
          ingestThoughtChunk(ev.thinking, true);
        if (ev.type === "thinking_end") finishRunningThought();
        return;
      }

      if (ev.type === "text_start" || ev.type === "text_end") {
        finishRunningThought();
      }
    } finally {
      lastExternalRenderAt = Date.now();
    }
  });
}

export default function (pi: ExtensionAPI) {
  createRollingProcessExtension(pi);
}
