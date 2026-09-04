import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";

const piModule = `
export const CONFIG_DIR_NAME = ".pi";
export const getAgentDir = () => process.env.MINI_LENS_AGENT_DIR;
export const getSettingsListTheme = () => ({});
export class Container { addChild() {} render() { return []; } invalidate() {} }
export class Text { constructor() {} }
export {};
`;
const tuiModule = `
export const visibleWidth = (text) => String(text).replace(/\\x1b\\[[0-9;]*m/g, "").length;
export const truncateToWidth = (text, width, suffix = "…") => {
  const plain = String(text).replace(/\\x1b\\[[0-9;]*m/g, "");
  return plain.length <= width ? String(text) : plain.slice(0, Math.max(0, width - suffix.length)) + suffix;
};
export class Container {
  constructor() { this.children = []; }
  addChild(child) { this.children.push(child); }
  render() { return this.children; }
  invalidate() {}
}
export class Text {
  constructor(text) { this.text = text; }
  setText(text) { this.text = text; }
}
export class SettingsList {
  constructor(items, _height, _theme, onChange) { this.items = items; this.onChange = onChange; }
  handleInput() {}
  setValue(id, value) { this.onChange(id, value); }
}
`;
const piUrl = `data:text/javascript,${encodeURIComponent(piModule)}`;
const tuiUrl = `data:text/javascript,${encodeURIComponent(tuiModule)}`;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n){if(s==='@earendil-works/pi-coding-agent')return {shortCircuit:true,url:${JSON.stringify(piUrl)}};if(s==='@earendil-works/pi-tui')return {shortCircuit:true,url:${JSON.stringify(tuiUrl)}};return n(s,c)}`)}`, import.meta.url);

const configDir = await mkdtemp(join(tmpdir(), "mini-lens-test-"));
process.env.MINI_LENS_AGENT_DIR = configDir;
const source = new URL("../extensions/footer-status.ts", import.meta.url);
const extension = await import(pathToFileURL(source.pathname).href + `?${Date.now()}`);

assert.equal(extension.DEFAULT_SETTINGS["mini-lens-ch-show"], true, "mini-lens-ch-show defaults to true");
assert.equal(extension.DEFAULT_SETTINGS["mini-lens-speed-unit-show"], true, "speed-unit display defaults to true");
assert.deepEqual(extension.parseSettings({ "mini-lens-ch-show": false }), {
  ...extension.DEFAULT_SETTINGS,
  "mini-lens-ch-show": false,
}, "partial settings merge with safe defaults");
assert.deepEqual(extension.parseSettings("bad config"), extension.DEFAULT_SETTINGS, "invalid configuration safely falls back to defaults");

const persisted = { ...extension.DEFAULT_SETTINGS, "mini-lens-ch-show": false, onboardingCompleted: true };
const configPath = extension.settingsPath(configDir);
await extension.saveSettings(persisted, configPath);
assert.deepEqual((await extension.loadSettings(configPath)).settings, persisted, "settings persist to Pi's agent directory");
assert.equal(JSON.parse(await readFile(configPath, "utf8"))["mini-lens-ch-show"], false, "persisted JSON retains the documented setting name");
const corruptPath = join(configDir, "corrupt.json");
await writeFile(corruptPath, "{not JSON", "utf8");
assert.deepEqual((await extension.loadSettings(corruptPath)).settings, extension.DEFAULT_SETTINGS, "corrupt configuration files safely fall back to defaults");

const runtimeDir = await mkdtemp(join(tmpdir(), "mini-lens-runtime-"));
process.env.MINI_LENS_AGENT_DIR = runtimeDir;
const handlers = new Map();
const commands = new Map();
const pi = {
  on(name, handler) { handlers.set(name, handler); },
  registerCommand(name, command) { commands.set(name, command); },
};
extension.default(pi);

let footerFactory;
let renders = 0;
let usage = { tokens: 0, percent: 0, contextWindow: 1_000_000 };
const ctx = {
  mode: "print",
  hasUI: false,
  model: { provider: "deepseek", id: "deepseek-v4-flash", contextWindow: 1_000_000 },
  thinkingLevel: "high",
  getContextUsage() { return usage; },
  sessionManager: {
    getBranch() {
      return [{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.01234 } } } }];
    },
  },
  ui: { setFooter(factory) { footerFactory = factory; }, notify() {} },
};
await handlers.get("session_start")({}, ctx);
assert.ok(footerFactory, "session_start installs the global footer");
const colors = [];
const colorTexts = [];
const theme = { fg(color, text) { colors.push(color); colorTexts.push([color, text]); return text; }, bold(text) { return text; } };
const footer = footerFactory({ requestRender() { renders++; } }, theme, {});

let lines = footer.render(100);
assert.equal(lines.length, 1, "footer always renders one line");
assert.match(lines[0], /^deepseek-v4-flash  high/, "README example model is displayed generically");
assert.doesNotMatch(lines[0], /deepseek\//, "provider prefix is omitted from the model label");
assert.ok(lines[0].includes("0/1.0M"), "middle shows used tokens and context total");
assert.match(lines[0], /0%$/, "without a speed sample, context percentage remains rightmost");
assert.doesNotMatch(lines[0], /--|tok\/s/, "without a speed sample, speed is hidden rather than rendered as a placeholder");
assert.match(lines[0], /░░+/, "zero percent renders an entirely empty progress bar");
assert.ok(colors.includes("accent") && colors.includes("borderMuted"), "progress uses semantic theme colors");

usage = { tokens: 50_000, percent: 50, contextWindow: 100_000 };
lines = footer.render(100);
assert.ok(lines[0].includes("50K/100K"), "middle reads token values from getContextUsage");
assert.match(lines[0], /50%$/, "percentage remains rightmost while generation speed is unavailable");
const middleBar = lines[0].match(/[█░]+/)?.[0] ?? "";
assert.ok(middleBar.includes("█") && middleBar.includes("░"), "an intermediate percentage has filled and empty progress cells");

const originalNow = Date.now;
let now = 1_000;
Date.now = () => now;
handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
handlers.get("message_update")({ assistantMessageEvent: { partial: { usage: { output: 10, input: 75_000, cacheRead: 25_000 } } } }, ctx);
now = 2_000;
handlers.get("message_update")({ assistantMessageEvent: { partial: { usage: { output: 50, input: 75_000, cacheRead: 25_000 } } } }, ctx);
now = 3_000;
handlers.get("message_update")({ assistantMessageEvent: { partial: { usage: { output: 70, input: 75_000, cacheRead: 25_000 } } } }, ctx);
now = 3_500;
handlers.get("message_update")({ assistantMessageEvent: { partial: { usage: { output: 60 } } } }, ctx);
now = 2_500;
handlers.get("message_update")({ assistantMessageEvent: { partial: { usage: { output: 100 } } } }, ctx);
Date.now = originalNow;
lines = footer.render(100);
assert.match(lines[0], /30\.0 tok\/s$/, "generation speed is the cumulative average from the first to latest valid output sample and ignores regressing output or time");
assert.ok(colorTexts.some(([color, text]) => color === "success" && text === "30.0 tok/s"), "fast speed uses success semantic color");
assert.equal(extension.speedColor(30), "success", "fast threshold is success");
assert.equal(extension.speedColor(10), "warning", "medium threshold is warning");
assert.equal(extension.speedColor(9.9), "error", "slow speed is error");
assert.equal(extension.speedColor(undefined), "muted", "missing speed is muted");
assert.match(lines[0], /ch 25\.0%/, "cache hit is visible by default");
handlers.get("message_end")({ message: { role: "assistant", usage: { output: 70, input: 75_000, cacheRead: 25_000 } } }, ctx);
lines = footer.render(100);
assert.match(lines[0], /30\.0 tok\/s$/, "message_end preserves the completed turn's average speed and ignores duplicate usage");

const withoutCache = { ...extension.DEFAULT_SETTINGS, "mini-lens-ch-show": false };
const hiddenCacheLine = extension.statusLine(ctx, theme, 100, 25, 0.01234, withoutCache, 40);
assert.doesNotMatch(hiddenCacheLine, /ch 25\.0%/, "mini-lens-ch-show false immediately hides cache hit");
const withoutSpeedUnit = { ...extension.DEFAULT_SETTINGS, "mini-lens-speed-unit-show": false };
const noUnitLine = extension.statusLine(ctx, theme, 100, 25, 0.01234, withoutSpeedUnit, 40);
assert.match(noUnitLine, /40\.0$/, "speed-unit setting shows only the numeric speed when disabled");
assert.doesNotMatch(noUnitLine, /tok\/s/, "speed-unit setting removes tok/s from the footer");
const hiddenEverything = Object.fromEntries(Object.keys(extension.DEFAULT_SETTINGS).map((id) => [id, false]));
assert.equal(extension.statusLine(ctx, theme, 100, 25, 0.01234, hiddenEverything, 40), "", "all footer fields can be disabled");

ctx.model = { provider: "openai", id: "gpt-5", contextWindow: 200_000 };
let settingsPanel;
const settingsCtx = {
  ...ctx,
  mode: "tui",
  ui: {
    ...ctx.ui,
    async custom(factory) {
      settingsPanel = factory({ requestRender() {} }, theme, {}, () => {});
    },
  },
};
await commands.get("mini-lens-settings").handler("", settingsCtx);
const settingsChildren = settingsPanel.render(100);
const settingsPreview = settingsChildren[2];
const settingsList = settingsChildren[3];
assert.match(settingsPreview.text, /deepseek-v4-flash  high  ch 98\.5%.*500\/1\.0M.*120 tok\/s/, "settings preview uses fixed example data instead of the current session");
assert.doesNotMatch(settingsPreview.text, /25\.0%|50K\/100K|gpt-5/, "settings preview never reads live session values");
settingsList.setValue("mini-lens-ch-show", "off");
assert.doesNotMatch(settingsPreview.text, /ch 98\.5%/, "changing the cache setting updates the preview immediately");
settingsList.setValue("mini-lens-speed-unit-show", "off");
assert.match(settingsPreview.text, /120$/, "changing the unit setting updates the preview immediately");
assert.doesNotMatch(settingsPreview.text, /tok\/s/, "disabled speed unit is absent from the updated preview");

for (const width of [40, 20, 8, 3]) {
  lines = footer.render(width);
  assert.equal(lines.length, 1, `width ${width} remains a single-line footer`);
  assert.ok(lines[0].length <= width, `width ${width} never overflows`);
}

// A first interactive run previews enabled defaults, offers two explicit choices, and persists Keep defaults.
const onboardingDir = await mkdtemp(join(tmpdir(), "mini-lens-onboarding-"));
process.env.MINI_LENS_AGENT_DIR = onboardingDir;
const onboardingExtension = await import(pathToFileURL(source.pathname).href + `?onboarding=${Date.now()}`);
const onboardingHandlers = new Map();
onboardingExtension.default({ on(name, handler) { onboardingHandlers.set(name, handler); }, registerCommand() {} });
const previews = [];
let customCalls = 0;
const onboardingCtx = {
  ...ctx,
  mode: "tui",
  hasUI: true,
  ui: {
    setFooter() {},
    notify() {},
    async select(title, choices) { previews.push([title, choices]); return "Keep defaults"; },
    async custom() { customCalls++; },
  },
};
await onboardingHandlers.get("session_start")({}, onboardingCtx);
assert.deepEqual(previews[0]?.[1], ["Keep defaults", "Configure now"], "onboarding offers explicit default and configure paths");
assert.match(previews[0]?.[0] ?? "", /ch 98\.5%.*500\/1\.0M.*120 tok\/s/, "onboarding preview has realistic cache, context, and fast speed data");
assert.equal(customCalls, 0, "Keep defaults does not force a settings dialog");
const savedDefaults = (await onboardingExtension.loadSettings(onboardingExtension.settingsPath(onboardingDir))).settings;
assert.deepEqual(savedDefaults, { ...onboardingExtension.DEFAULT_SETTINGS, onboardingCompleted: true }, "Keep defaults persists every enabled field and completes onboarding");

const configureDir = await mkdtemp(join(tmpdir(), "mini-lens-configure-"));
process.env.MINI_LENS_AGENT_DIR = configureDir;
const configureHandlers = new Map();
onboardingExtension.default({ on(name, handler) { configureHandlers.set(name, handler); }, registerCommand() {} });
await configureHandlers.get("session_start")({}, { ...onboardingCtx, ui: { ...onboardingCtx.ui, async select() { return "Configure now"; } } });
assert.equal(customCalls, 1, "Configure now opens the settings list after showing the preview");

await rm(configDir, { recursive: true, force: true });
await rm(runtimeDir, { recursive: true, force: true });
await rm(onboardingDir, { recursive: true, force: true });
await rm(configureDir, { recursive: true, force: true });
delete process.env.MINI_LENS_AGENT_DIR;
console.log("footer-status self-check ok");
