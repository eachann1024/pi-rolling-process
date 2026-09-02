**English** · [简体中文](README.zh-CN.md)

# pi-minimal-mode

Minimal mode for [Pi](https://pi.dev). Transcript order is user message → process block → assistant reply. After the run the block stays in place.

Supports box / panel / plain presets and four border styles; switch with `/process-style`.

Height only grows: step rows are appended; the last line is a status row (braille spinner + `Thinking…` while running; `✅ Done · N steps` when finished). The header shows total elapsed as a bare duration (`5.1s`). Per-step duration stays in the left column, not in the row text. That avoids Pi's transcript follow-end re-latch, so you can scroll up during a run without being pulled back to the bottom. When more steps are hidden, the header adds `ctrl+o expand`; after expand it becomes `ctrl+o collapse`.

```text
> User: look at the repo layout
┌─ Minimal 2/2 · 5.1s ─────────────────────────────────────┐
│  0.4s ✅ bash $ ls -la                                   │
│  0.1s ✅ read package.json                               │
│  0.2s ✅ skill browser-use/SKILL.md → 103 lines          │
│   22s ✅ subagent list → 14 lines                        │
│  1.1s ✅ note Read browser skill, verify post first.     │
│  3.2s ⠀⠐ Thinking…                                       │
└──────────────────────────────────────────────────────────┘
This is a Pi extension repo, ... (assistant reply)
```

Each row = duration column (6 cols, right-aligned) + space + icon (width 2) + space + text. Step-row text is `kind detail`; status-row text is `Thinking…` (or the running tool's kind) while running, and `Done · N steps` when finished. Step duration only appears in the left column. Finished status row example: `│  5.1s ✅ Done · 2 steps`.

Spinner: two braille cells form a 4×4 dot grid; 12 frames walk clockwise around the perimeter (`⠁⠀ ⠈⠀ ⠀⠁ ⠀⠈ ⠀⠐ ⠀⠠ ⠀⢀ ⠀⡀ ⢀⠀ ⡀⠀ ⠄⠀ ⠂⠀`), 100ms per frame. Icon column width 2, aligned with ✅. The timer runs only while the agent is running.

Requires Pi **>= 0.84.0**. Conflicts with `pi-compact-transcript` — uninstall that package first.

npm currently publishes **1.0.5**. **1.3.0** is not on npm yet.

## Appearance preview

Collapse / expand:

![Collapse and expand](docs/images/collapse-expand.png)

Three presets (box / panel / plain):

![box / panel / plain](docs/images/presets-box-panel-plain.png)

## Install

```bash
pi install npm:pi-minimal-mode
# or
pi install git:github.com/eachann1024/pi-rolling-process
```

Then `/reload`.

## Development

Install only the path copy. Keeping npm and local at the same time double-fires event handlers:

```bash
pi remove npm:pi-minimal-mode && pi install /path/to/pi-rolling-process
```

After code changes, `/reload` in Pi.

- `npm run check` — `tsc` typecheck. `tsconfig.json` `paths` point at this machine's global Pi install; retarget them using `npm root -g`.
- `npm test` — `node test/self-check.mjs`

## Shortcuts

| Key | Action |
| --- | --- |
| `ctrl+o` | Expand / collapse this process block |
| `/process` | Same as `ctrl+o` |

This extension occupies `ctrl+o`, which Pi also uses for `app.tools.expand` (native tool dump). Remap that in `~/.pi/agent/keybindings.json`:

```json
{
  "app.tools.expand": "ctrl+alt+o"
}
```

With `hideNativeTools: true` (default), all tool cards (including other extensions' and MCP tools) are hidden while collapsed. Use `app.tools.expand` to show the original cards.

## Commands

```text
/process                         expand / collapse
/process-lines 6                 collapsed row count (1–20)
/process-lang auto               auto | zh | en
/process-native                  show whether native tool blocks are hidden
/process-native on|off           hide (on, default) or show (off); takes effect immediately
```

`/process-style`:

| Usage | Effect |
| --- | --- |
| `/process-style` | Show current style (`preset · border …`) |
| `/process-style box\|panel\|plain` | Set preset |
| `/process-style border single\|rounded\|double\|none` | Set border (`none` draws no frame; same as plain for the frame) |

No other `/process-style` subcommands. There is no `preset` keyword — the preset name is the first argument.

`/process-native on` writes `hideNativeTools: true`; `off` writes `false`. Changes take effect immediately without `/reload`. With no argument, the command reports the current value.

## Config

`~/.pi/agent/rolling-process.json`

```json
{
  "maxVisibleLines": 6,
  "locale": "auto",
  "hideNativeTools": true,
  "hideWorkingIndicator": true,
  "hideThinkingLabel": true,
  "style": {
    "preset": "box",
    "border": "single",
    "showHeader": true,
    "showStepIndex": false,
    "showKind": true,
    "showDuration": true,
    "showResult": true,
    "icons": {
      "done": "✅",
      "error": "❌",
      "running": "⠁",
      "aborted": "⚠️"
    },
    "colors": {
      "border": "border",
      "header": "dim",
      "kind": "muted",
      "duration": "success",
      "done": "success",
      "error": "error",
      "running": "warning",
      "aborted": "warning",
      "categories": {
        "builtin": "muted",
        "skill": "success",
        "extension": "success",
        "subagent": "accent",
        "thought": "dim",
        "note": "warning"
      }
    }
  }
}
```

`locale: "auto"` follows the system (`zh` / `en`). `/process-lang` overrides it.

`hideNativeTools` (default `true`) wraps `ToolExecutionComponent.prototype.render` at runtime so all tool cards are hidden while collapsed. Expanding with Pi's `app.tools.expand` shows the original cards. `/process-native on|off` writes this field and takes effect immediately.

`hideWorkingIndicator` (default `true`) hides Pi's native `Working…` status row, because the process block already has its own status row. Config file only; takes effect after `/reload`. No slash command.

`hideThinkingLabel` (default `true`) clears Pi's `Thinking…` label when thinking is hidden. Config file only; takes effect after `/reload`. No slash command.

### Step categories

Steps fall into six categories. Kind labels are colored by category (defaults below):

![Step category colors](docs/images/step-categories.png)

| Category | Default color | Label | Detail |
| --- | --- | --- | --- |
| `builtin` | `muted` | Tool kind (read, bash, edit, …) | Command / path / result |
| `skill` | `success` | `skill` | Skill name and file (when read/bash/ls hits `/skills/`, `SKILL.md`, or `/.agents/`) |
| `extension` | `success` | Raw tool name (e.g. `some_mcp_tool`; underscores kept) | Same as other extension tool cards |
| `subagent` | `accent` | `subagent` | Subagent name and result |
| `thought` | `dim` | `think` | Thought text |
| `note` | `warning` | `note` | First line of assistant text emitted before a tool call |

Override per category with `style.colors.categories`. Legacy `style.colors.kind` still applies as the `builtin` fallback.

### Style

| `preset` | |
| --- | --- |
| `box` | Line frame + header (default) |
| `panel` | Solid tool-card background |
| `plain` | No frame |

![Four border styles](docs/images/borders-four.png)

| `border` (box only) | `single` `┌` · `rounded` `╭` · `double` `╔` · `none` |

Icons are characters. Default `icons.running` is `⠁` (from `DEFAULT_STYLE`). While a step or the status row is running, that column shows the 12-frame perimeter walk (`⠁⠀ ⠈⠀ ⠀⠁ ⠀⠈ ⠀⠐ ⠀⠠ ⠀⢀ ⠀⡀ ⢀⠀ ⡀⠀ ⠄⠀ ⠂⠀`, 100ms) instead of this configured glyph. `colors` are Pi theme names (`accent`, `success`, `error`, `warning`, `muted`, `dim`, `border`, …).

## License

MIT
