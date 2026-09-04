**English** · [简体中文](README.zh-CN.md)

# pi-minimal-mode

An inline process summary extension for [Pi](https://pi.dev) (Pi >= 0.84.0).

The extension adds nothing to a text-only turn: the transcript remains user message → final answer. When a tool or thinking event occurs, it appends one process entry between the user message and the final answer. The entry is a compact, non-floating disclosure summary.

```text
> User: inspect the repository

▸ Completed · recent 6 records · ctrl+o expand

The repository contains …
```

Press `ctrl+o` or use `/process` to expand it. The expanded entry shows the most recent records, then a disclosure for any older records. All process UI text is English, including thinking and completion states. Process symbols are text glyphs (`✓`, `✗`, `!`, `▸`, `▾`), not emoji. Extension tool names remain unchanged (for example, `some_mcp_tool`).

## Install

```bash
pi install npm:pi-minimal-mode
# or
pi install git:github.com/eachann1024/pi-rolling-process
```

Then run `/reload` in Pi.

## Development

Install only the path copy; installing npm and local copies together double-registers handlers:

```bash
pi remove npm:pi-minimal-mode && pi install /path/to/pi-rolling-process
```

After source changes, use `/reload` in an already-open Pi session.

- `npm run check` — TypeScript typecheck
- `npm test` — extension self-check

## Controls

| Input | Action |
| --- | --- |
| `ctrl+o` | Expand or collapse the current process entry |
| `/process` | Same as `ctrl+o` |
| `/process 1-100` | Persist and apply the number of recent records (default: 6) |
| `/process-native` | Report whether native tool cards are hidden |
| `/process-native on` | Hide native Pi tool cards immediately (default) |
| `/process-native off` | Show native Pi tool cards immediately |

`ctrl+o` may conflict with Pi's native tool expansion binding. If needed, remap `app.tools.expand` in `~/.pi/agent/keybindings.json`.

## Configuration

The plugin stores only its settings in `~/.pi/agent/rolling-process.json`:

```json
{
  "maxRecords": 6,
  "hideNativeTools": true,
  "hideWorkingIndicator": true,
  "hideThinkingLabel": true
}
```

`hideNativeTools` defaults to `true`: native `ToolExecutionComponent` cards are suppressed at render time, while the inline process entry remains visible. `/process-native on|off` persists the setting and refreshes existing native cards immediately.

`hideWorkingIndicator` hides Pi's native `Working…` row by default. `hideThinkingLabel` clears Pi's native thinking label by default. Edit either setting and reload the extension to apply it.

## Categories

Expanded rows are colored by category: built-in tools use `muted`; skill and extension tools use `success`; subagents use `accent`; and thinking uses `warning`. A `read` of `SKILL.md` is categorized as a skill; extension tool names are displayed verbatim.
