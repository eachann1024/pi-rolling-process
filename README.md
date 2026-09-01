**English** · [简体中文](README.zh-CN.md)

# pi-rolling-process

Rolling process viewport for [Pi](https://pi.dev). Latest steps stay in a fixed box; older ones roll off. The answer appears below after the run.

```text
┌─ process 5/118 · 113 hidden · ctrl+o expand ─
│ ❌ read /tmp/foo.ts
│ ✅ think validation passed 2.8s
│ ✅ find "_tmp_repro" . -> 5 lines 2ms
│ 🟡 think checking remaining matches
└──────────────────────────────────────────────
```

Requires Pi **>= 0.84.0**. Conflicts with `pi-compact-transcript` — uninstall that package first.

## Install

```bash
pi install npm:pi-rolling-process
# or
pi install git:github.com/eachann1024/pi-rolling-process
```

Then `/reload`.

## Shortcuts

| Key | Action |
| --- | --- |
| `ctrl+o` | Expand / collapse this process list |
| `ctrl+alt+o` | Pi native tool dump |
| `/process` | Same as `ctrl+o` |

## Commands

```text
/process                      expand / collapse
/process-lines 8              collapsed row count (1–20)
/process-lang auto            auto | zh | en
/process-style                show current style
/process-style box            box | panel | plain
/process-style border rounded single | rounded | double | none
```

## Config

`~/.pi/agent/rolling-process.json`

```json
{
  "maxVisibleLines": 8,
  "locale": "auto",
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
      "running": "🟡",
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
      "aborted": "warning"
    }
  }
}
```

`locale: "auto"` follows the system (`zh` / `en`). `/process-lang` overrides it.

### Style

| `preset` | |
| --- | --- |
| `box` | Line frame + header (default) |
| `panel` | Solid tool-card background |
| `plain` | No frame |

| `border` (box only) | `single` `┌` · `rounded` `╭` · `double` `╔` · `none` |

Icons are characters. `colors` are Pi theme names (`success`, `error`, `warning`, `muted`, `dim`, `border`, …).

## License

MIT
