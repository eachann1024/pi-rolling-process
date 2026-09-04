import { CONFIG_DIR_NAME, getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SETTINGS_FILE_NAME = "mini-lens.json";

export interface MiniLensSettings {
  "mini-lens-model-show": boolean;
  "mini-lens-thinking-show": boolean;
  "mini-lens-ch-show": boolean;
  "mini-lens-cost-show": boolean;
  "mini-lens-context-show": boolean;
  "mini-lens-context-percent-show": boolean;
  "mini-lens-speed-show": boolean;
  "mini-lens-speed-unit-show": boolean;
  onboardingCompleted: boolean;
}

export const DEFAULT_SETTINGS: Readonly<MiniLensSettings> = {
  "mini-lens-model-show": true,
  "mini-lens-thinking-show": true,
  "mini-lens-ch-show": true,
  "mini-lens-cost-show": true,
  "mini-lens-context-show": true,
  "mini-lens-context-percent-show": true,
  "mini-lens-speed-show": true,
  "mini-lens-speed-unit-show": true,
  onboardingCompleted: false,
};

const SETTING_IDS = Object.keys(DEFAULT_SETTINGS) as Array<keyof MiniLensSettings>;

export function settingsPath(agentDir = process.env.MINI_LENS_AGENT_DIR ?? join(homedir(), CONFIG_DIR_NAME, "agent")): string {
  return join(agentDir, SETTINGS_FILE_NAME);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function parseSettings(value: unknown): MiniLensSettings {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(SETTING_IDS.map((id) => [id, isBoolean(candidate[id]) ? candidate[id] : DEFAULT_SETTINGS[id]])) as unknown as MiniLensSettings;
}

export async function loadSettings(path = settingsPath()): Promise<{ settings: MiniLensSettings; exists: boolean }> {
  try {
    return { settings: parseSettings(JSON.parse(await readFile(path, "utf8"))), exists: true };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, exists: false };
  }
}

export async function saveSettings(settings: MiniLensSettings, path = settingsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatUsd(value: number): string {
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function sessionCost(ctx: ExtensionContext): number {
  return ctx.sessionManager.getBranch().reduce((total, entry) => {
    if (entry.type !== "message" || entry.message.role !== "assistant") return total;
    const usage = entry.message as { usage?: { cost?: { total?: unknown } } };
    return total + Math.max(0, finiteNumber(usage.usage?.cost?.total) ?? 0);
  }, 0);
}

export type SpeedColor = "success" | "warning" | "error" | "muted";

export function speedColor(speed: number | undefined): SpeedColor {
  if (speed === undefined) return "muted";
  if (speed >= 30) return "success";
  if (speed >= 10) return "warning";
  return "error";
}

export function formatSpeed(speed: number, showUnit: boolean): string {
  const value = speed.toFixed(speed >= 100 ? 0 : 1);
  return showUnit ? `${value} tok/s` : value;
}

function renderRight(
  theme: ExtensionContext["ui"]["theme"],
  settings: MiniLensSettings,
  percentText: string,
  speed: number | undefined,
): string {
  const fields: string[] = [];
  if (settings["mini-lens-context-percent-show"]) fields.push(theme.fg("accent", percentText));
  if (settings["mini-lens-speed-show"] && speed !== undefined) {
    fields.push(theme.fg(speedColor(speed), formatSpeed(speed, settings["mini-lens-speed-unit-show"])));
  }
  return fields.join("  ");
}

const SETTINGS_PREVIEW_CONTEXT = {
  model: { id: "deepseek-v4-flash" },
  thinkingLevel: "high",
  getContextUsage: () => ({ tokens: 500, contextWindow: 1_000_000, percent: 1 }),
} as unknown as ExtensionContext;

export function settingsPreviewLine(
  theme: ExtensionContext["ui"]["theme"],
  settings: MiniLensSettings,
  width = 100,
): string {
  return statusLine(SETTINGS_PREVIEW_CONTEXT, theme, width, 98.5, 0.012, settings, 120);
}

export function statusLine(
  ctx: ExtensionContext,
  theme: ExtensionContext["ui"]["theme"],
  width: number,
  cacheHit: number | undefined,
  cost: number,
  settings: MiniLensSettings,
  speed: number | undefined,
): string {
  if (width <= 0) return "";
  const model = ctx.model?.id ?? "no model";
  const thinking = ctx.thinkingLevel ?? "off";
  const cache = cacheHit === undefined ? "" : `ch ${cacheHit.toFixed(1)}%`;
  const price = cost > 0 ? formatUsd(cost) : "";
  const usage = ctx.getContextUsage();
  const tokens = finiteNumber(usage?.tokens);
  const contextWindow = finiteNumber(usage?.contextWindow);
  const rawPercent = finiteNumber(usage?.percent);
  const percent = rawPercent === undefined ? undefined : Math.max(0, Math.min(100, rawPercent));
  const percentText = percent === undefined ? "?%" : `${Math.round(percent)}%`;
  const tokenText = `${tokens === undefined ? "?" : formatTokens(Math.max(0, tokens))}/${contextWindow === undefined ? "?" : formatTokens(Math.max(0, contextWindow))}`;

  const right = renderRight(theme, settings, percentText, speed);
  const rightWidth = visibleWidth(right);
  if (right && width <= rightWidth) {
    const compactRight = settings["mini-lens-speed-show"] && speed !== undefined
      ? theme.fg(speedColor(speed), formatSpeed(speed, settings["mini-lens-speed-unit-show"]))
      : right;
    return truncateToWidth(compactRight, width, "");
  }

  const leftParts = [
    settings["mini-lens-model-show"] && theme.fg("accent", model),
    settings["mini-lens-thinking-show"] && theme.fg("muted", thinking),
    settings["mini-lens-ch-show"] && cache && theme.fg("muted", cache),
    settings["mini-lens-cost-show"] && price && theme.fg("muted", price),
  ].filter((part): part is string => Boolean(part));
  const unstyledLeft = [
    settings["mini-lens-model-show"] && model,
    settings["mini-lens-thinking-show"] && thinking,
    settings["mini-lens-ch-show"] && cache,
    settings["mini-lens-cost-show"] && price,
  ].filter(Boolean).join("  ");
  const leftBudget = Math.min(visibleWidth(unstyledLeft), Math.max(1, Math.floor(width * 0.5)), Math.max(0, width - rightWidth - 1));
  const left = leftParts.length > 0 ? truncateToWidth(leftParts.join("  "), leftBudget, "…") : "";
  const leftWidth = visibleWidth(left);
  const middleBudget = settings["mini-lens-context-show"] ? Math.max(0, width - leftWidth - rightWidth - (left && right ? 4 : left || right ? 1 : 0)) : 0;

  let middle = "";
  if (middleBudget > 0) {
    const visibleToken = truncateToWidth(tokenText, middleBudget, "…");
    const visibleTokenWidth = visibleWidth(visibleToken);
    const barWidth = middleBudget - visibleTokenWidth - 1;
    const bar = barWidth >= 2 && percent !== undefined
      ? `${theme.fg("accent", "█".repeat(Math.round(barWidth * percent / 100)))}${theme.fg("borderMuted", "░".repeat(barWidth - Math.round(barWidth * percent / 100)))}`
      : "";
    middle = `${theme.fg("muted", visibleToken)}${bar ? ` ${bar}` : ""}`;
  }

  const content = [left, middle].filter(Boolean).join("  ");
  if (!right) return truncateToWidth(content, width, "");
  const gap = " ".repeat(Math.max(1, width - visibleWidth(content) - rightWidth));
  return truncateToWidth(`${content}${content ? gap : ""}${right}`, width, "");
}

function settingsItems(settings: MiniLensSettings): SettingItem[] {
  const labels: Record<Exclude<keyof MiniLensSettings, "onboardingCompleted">, string> = {
    "mini-lens-model-show": "Show model",
    "mini-lens-thinking-show": "Show thinking level",
    "mini-lens-ch-show": "Show cache hit (ch)",
    "mini-lens-cost-show": "Show session price",
    "mini-lens-context-show": "Show context tokens and progress bar",
    "mini-lens-context-percent-show": "Show context percentage",
    "mini-lens-speed-show": "Show generation speed",
    "mini-lens-speed-unit-show": "↳ Show tok/s unit",
  };
  return (Object.keys(labels) as Array<Exclude<keyof MiniLensSettings, "onboardingCompleted">>).map((id) => ({
    id,
    label: labels[id],
    currentValue: settings[id] ? "on" : "off",
    values: ["on", "off"],
  }));
}

export default function (pi: ExtensionAPI) {
  let refreshFooter: (() => void) | undefined;
  let cacheHit: number | undefined;
  let speed: number | undefined;
  let speedSamples: { firstOutput: number; firstTimestamp: number; latestOutput: number; latestTimestamp: number } | undefined;
  let settings: MiniLensSettings = { ...DEFAULT_SETTINGS };
  let saveChain: Promise<void> = Promise.resolve();
  const configPath = settingsPath();

  const refresh = () => refreshFooter?.();
  const persistSettings = (ctx: ExtensionContext) => {
    const snapshot = { ...settings };
    saveChain = saveChain
      .catch(() => undefined)
      .then(() => saveSettings(snapshot, configPath))
      .catch(() => ctx.ui.notify("Could not save Mini Lens settings", "error"));
    return saveChain;
  };
  const updateCacheHit = (usage: { input?: unknown; cacheRead?: unknown } | undefined) => {
    if (!usage) return;
    const inputValue = finiteNumber(usage.input);
    const cacheReadValue = finiteNumber(usage.cacheRead);
    if (inputValue === undefined && cacheReadValue === undefined) return;
    const input = inputValue ?? 0;
    const cacheRead = cacheReadValue ?? 0;
    const cacheBase = input + cacheRead;
    if (cacheBase >= 0) cacheHit = cacheBase === 0 ? 0 : Math.max(0, Math.min(100, 100 * cacheRead / cacheBase));
  };
  const updateSpeed = (usage: { output?: unknown } | undefined) => {
    const output = finiteNumber(usage?.output);
    if (output === undefined || output < 0) return;
    const timestamp = Date.now();
    if (!speedSamples) {
      speedSamples = { firstOutput: output, firstTimestamp: timestamp, latestOutput: output, latestTimestamp: timestamp };
      return;
    }
    if (output <= speedSamples.latestOutput || timestamp <= speedSamples.latestTimestamp) return;
    speedSamples.latestOutput = output;
    speedSamples.latestTimestamp = timestamp;
    speed = (output - speedSamples.firstOutput) / ((timestamp - speedSamples.firstTimestamp) / 1_000);
  };
  const openSettings = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/mini-lens-settings requires TUI mode", "error");
      return;
    }
    await ctx.ui.custom((tui, theme, _keybindings, done) => {
      const container = new Container();
      const preview = new Text(settingsPreviewLine(theme, settings), 1, 1);
      container.addChild(new Text(theme.fg("accent", theme.bold("Mini Lens settings")), 1, 1));
      container.addChild(new Text(theme.fg("muted", "Preview (example data)"), 1, 0));
      container.addChild(preview);
      const settingsList = new SettingsList(
        settingsItems(settings),
        10,
        getSettingsListTheme(),
        (id, value) => {
          settings = { ...settings, [id]: value === "on", onboardingCompleted: true };
          preview.setText(settingsPreviewLine(theme, settings));
          void persistSettings(ctx);
          refresh();
        },
        () => done(undefined),
        { enableSearch: true },
      );
      container.addChild(settingsList);
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          settingsList.handleInput(data);
          tui.requestRender();
        },
      };
    });
  };

  pi.registerCommand("mini-lens-settings", {
    description: "Configure Mini Lens footer fields",
    handler: async (_args, ctx) => openSettings(ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    const loaded = await loadSettings(configPath);
    settings = loaded.settings;
    ctx.ui.setFooter((tui, theme) => {
      refreshFooter = () => tui.requestRender();
      return {
        invalidate() {},
        render(width: number): string[] {
          return [statusLine(ctx, theme, width, cacheHit, sessionCost(ctx), settings, speed)];
        },
      };
    });
    refresh();
    if (!loaded.exists && ctx.mode === "tui" && ctx.hasUI) {
      const choice = await ctx.ui.select(
        "Mini Lens preview\n\n  deepseek-v4-flash  high  ch 98.5%  $0.012  500/1.0M  █░░░░░░░░░  1%  120 tok/s\n\nAll fields are enabled by default.",
        ["Keep defaults", "Configure now"],
      );
      settings = { ...settings, onboardingCompleted: true };
      try {
        await persistSettings(ctx);
      } catch {
        ctx.ui.notify(`Could not save Mini Lens settings in ${CONFIG_DIR_NAME}`, "error");
      }
      if (choice === "Configure now") await openSettings(ctx);
    }
  });
  pi.on("model_select", refresh);
  pi.on("thinking_level_select", refresh);
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") {
      speed = undefined;
      speedSamples = undefined;
      refresh();
    }
  });
  pi.on("message_update", (event) => {
    const usage = (event.assistantMessageEvent as {
      partial?: { usage?: { input?: unknown; cacheRead?: unknown; output?: unknown } };
    }).partial?.usage;
    updateCacheHit(usage);
    updateSpeed(usage);
    refresh();
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      updateCacheHit(event.message.usage);
      updateSpeed(event.message.usage);
    }
    refresh();
  });
  pi.on("agent_start", refresh);
  pi.on("agent_end", refresh);
  pi.on("session_shutdown", () => { refreshFooter = undefined; });
}
