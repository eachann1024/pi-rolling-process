import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { register } from "node:module";

// Keep real TUI components, but avoid loading the unrelated Pi server runtime.
const piStub = `data:text/javascript,${encodeURIComponent(`
export const CONFIG_DIR_NAME = ".pi";
export const getSettingsListTheme = () => ({
  hint: (text) => text, description: (text) => text,
});
`)}`;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n){if(s==='@earendil-works/pi-coding-agent')return {shortCircuit:true,url:${JSON.stringify(piStub)}};return n(s,c)}`)}`, import.meta.url);
const { default: extension } = await import("../extensions/footer-status.ts");

const dir = await mkdtemp(join(tmpdir(), "mini-lens-pointer-"));
process.env.MINI_LENS_AGENT_DIR = dir;
const commands = new Map();
extension({ on() {}, registerCommand(name, command) { commands.set(name, command); } });
let panel;
const theme = {
  bg(color, text) { assert.equal(color, "selectedBg"); return `\x1b[47m${text}\x1b[49m`; },
  fg(color, text) { return color === "accent" ? `\x1b[32m${text}\x1b[39m` : text; },
  bold(text) { return `\x1b[1m${text}\x1b[22m`; },
};
await commands.get("mini-lens-settings").handler("", {
  mode: "tui",
  ui: {
    notify() {},
    async custom(factory) { panel = factory({ requestRender() {} }, theme, {}, () => {}); },
  },
});
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
for (const width of [140, 80, 40]) {
  let lines = panel.render(width);
  const row = lines.findIndex((line) => plain(line).includes("Show thinking level"));
  assert.ok(row >= 0);
  const beforeHover = plain(lines[row]).replace(/^[→ ]+/, "");
  const result = panel.handleMouse({ type: "move", button: "none", x: 4, y: row, screenX: 4, screenY: row, width, height: lines.length });
  assert.equal(result?.handled, true, "panel routes hover through header and preview to settings");
  lines = panel.render(width);
  assert.match(lines[row], /\x1b\[47m\x1b\[32m.*Show thinking level/, "hovered option has background and green text");
  const previewLines = lines.slice(0, row - 2).join("\n");
  if (width >= 80) assert.match(previewLines, /\x1b\[47m\x1b\[32m\x1b\[1mhigh/, "hover highlights the corresponding preview field");
  assert.equal(plain(lines[row]).replace(/^[→ ]+/, ""), beforeHover, "hover does not toggle the value");
  assert.equal(lines.filter((line) => line.includes("\x1b[32m") && plain(line).includes("Show ")).length, 1, "exactly one option is highlighted");
  panel.handleInput("\x1b[B");
  lines = panel.render(width);
  assert.match(lines[row + 1], /\x1b\[32m.*Show total session tokens/, "keyboard follows footer field order");
  if (width >= 140) assert.match(lines.slice(0, row - 2).join("\n"), /\x1b\[32m\x1b\[1mTotal/, "keyboard updates preview highlight");
  assert.ok(lines.every((line) => visibleWidth(line) <= width), "panel stays within terminal width");
}
await rm(dir, { recursive: true, force: true });
delete process.env.MINI_LENS_AGENT_DIR;
console.log("settings interaction check ok (real SettingsList / Container)");
