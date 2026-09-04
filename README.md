[简体中文](README.zh-CN.md)

# pi-minimal-mode

A compact, configurable global footer for [Pi](https://pi.dev) (Pi >= 0.84.0). It replaces Pi's footer only; Pi's built-in tool and thinking views are unchanged.

The footer can show the active model, thinking level, cache-hit rate (`ch`), estimated session price, context tokens with a progress bar, context percentage, and generation speed. `deepseek/deepseek-v4-flash` is an example model label only—no provider or model is special-cased.

## Install

```bash
pi install npm:pi-minimal-mode
# or
pi install git:github.com/eachann1024/pi-rolling-process
```

Run `/reload` in Pi after installing or changing the source.

## First run and settings

On the first interactive TUI session, Mini Lens shows a preview with every field enabled by default:

```text
deepseek-v4-flash  high  ch 98.5%  $0.012  500/1.0M  █░░░░░░░░░  1%  120 tok/s
```

The first-run picker offers **Keep defaults** and **Configure now**. Keeping defaults persists every display field as enabled and prevents the prompt from appearing again; configuring opens the same settings list immediately. Print, JSON, and other non-interactive modes never prompt.

Open that settings UI any time with:

```text
/mini-lens-settings
```

Changes take effect immediately. The command requires Pi's TUI mode. Its preview always uses fixed example data rather than your current session, while reflecting every setting toggle immediately.

Settings are stored globally at Pi's agent directory (normally `~/.pi/agent/mini-lens.json`; installations with a different Pi config directory use that directory). A malformed or missing file safely falls back to the defaults.

```json
{
  "mini-lens-model-show": true,
  "mini-lens-thinking-show": true,
  "mini-lens-ch-show": true,
  "mini-lens-cost-show": true,
  "mini-lens-context-show": true,
  "mini-lens-context-percent-show": true,
  "mini-lens-speed-show": true,
  "mini-lens-speed-unit-show": true,
  "onboardingCompleted": true
}
```

| Key | Default | Controls |
| --- | --- | --- |
| `mini-lens-model-show` | `true` | Model ID without provider prefix |
| `mini-lens-thinking-show` | `true` | Thinking level |
| `mini-lens-ch-show` | `true` | Cache-hit rate (`ch`) |
| `mini-lens-cost-show` | `true` | Estimated session list price |
| `mini-lens-context-show` | `true` | Used/total context tokens and progress bar |
| `mini-lens-context-percent-show` | `true` | Context-use percentage |
| `mini-lens-speed-show` | `true` | Generation speed at the far right |
| &nbsp;&nbsp;&nbsp;&nbsp;`mini-lens-speed-unit-show` | `true` | Generation-speed sub-setting: append `tok/s` to the numeric value |
| `onboardingCompleted` | `false` initially | Internal marker that prevents another first-run prompt |

- **Generation speed**
  - **Show tok/s unit** (`mini-lens-speed-unit-show`) is the indented sub-setting shown beneath **Show generation speed** in `/mini-lens-settings`. Turning it off keeps the speed number (for example `40.0`) and removes only `tok/s`.
  - The sub-setting is retained when generation speed itself is hidden.

## Speed and price

During an assistant stream, speed is the cumulative average from the first valid `usage.output` sample to the latest valid sample: total output-token increase divided by elapsed time. The completed turn keeps that final average until a new assistant message begins. Repeated final usage, output regressions, invalid values, and non-increasing timestamps do not distort it.

Before two valid increasing output samples exist, the speed field is absent entirely—Mini Lens never displays a `-- tok/s` placeholder. When present, speed is the rightmost footer field (the context percentage, if enabled, is immediately to its left). Its color uses Pi theme semantics: **success** at >=30 tok/s, **warning** at 10–29.9 tok/s, and **error** below 10 tok/s. No colors are hard-coded, so it follows the selected Pi theme.

The price is Pi's session total from finalized assistant-message usage and configured per-million-token rates. It is an estimate, not a provider invoice. In narrow terminals, the footer drops/truncates lower-priority content to remain one line without overflow.

## Development

Install only the local copy while developing; installing npm and local copies together double-registers the extension:

```bash
pi remove npm:pi-minimal-mode && pi install /path/to/pi-rolling-process
npm run check
npm test
```

After source changes, run `/reload` in an already-open Pi session. `npm run check` runs TypeScript checking and `npm test` runs the footer self-check.
