<p align="center">
  <img src="assets/mini-lens-hero.png" alt="Mini Lens for Pi — Your session. In focus. A compact footer showing model, tokens, cache, cost, context and generation speed." width="100%">
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> · <a href="#install">Install</a> · <a href="#make-it-yours">Settings</a> · <a href="https://github.com/user-attachments/assets/5f2f4816-45ed-4759-b035-d9ee59e8a763">Watch demo</a>
</p>

A compact, configurable footer for [Pi](https://pi.dev). Your model, usage, cost estimate, context, and generation speed — at a glance.

## Install

```bash
pi install npm:pi-mini-lens
```

Run `/reload` in Pi. Requires **Pi ≥ 0.84.0**.

<details>
<summary>Install from GitHub instead</summary>

```bash
pi install git:github.com/eachann1024/pi-mini-lens
```

</details>

---

<table>
<tr>
<td width="50%" valign="top">

### Live session metrics

- Model & thinking level
- Session token totals
- Cached tokens & hit rate
- Estimated session cost
- Context usage & progress
- Latest generation speed

</td>
<td width="50%" valign="top">

### Make it yours

Choose the fields you need. Preview each change instantly, in your Pi theme.

<a href="assets/mini-lens-settings.jpg"><img src="assets/mini-lens-settings.jpg" alt="Mini Lens settings in Pi's light theme, showing the live preview and field toggles. Click to view at full size." width="100%"></a>

[Watch the settings demo](https://github.com/user-attachments/assets/5f2f4816-45ed-4759-b035-d9ee59e8a763)

</td>
</tr>
</table>

Customize with `/mini-lens-settings`. Changes take effect immediately.

**Fits your terminal.** Follows your Pi theme and adapts to narrow widths. Only the footer changes; Pi's built-in tool and thinking views stay intact.

## Reference

<details>
<summary><strong>First run & configuration</strong> — defaults, controls, and settings file</summary>

On the first interactive TUI session, Mini Lens shows a preview with every field enabled by default:

```text
deepseek-v4-flash  high  Total 45K  Cached 25K  CH 40.0%  $0.012  500/1.0M  █░░░░░░░░░  1%  120 tok/s
```

The first-run picker offers **Keep defaults** and **Configure now**. Keeping defaults persists every display field as enabled and prevents the prompt from appearing again; configuring opens the same settings list immediately. Print, JSON, and other non-interactive modes never prompt.

Open that settings UI any time with:

```text
/mini-lens-settings
```

The focused option and its corresponding preview field use bold theme `accent` text with a `selectedBg` background. Fullscreen Pi supports hover to focus and click to toggle; regular terminal mode uses keyboard navigation. Hovering never changes a setting.

Changes take effect immediately. The command requires Pi's TUI mode. Its preview always uses fixed example data rather than your current session, while reflecting every setting toggle immediately.

Settings are stored globally at Pi's agent directory (normally `~/.pi/agent/mini-lens.json`; installations with a different Pi config directory use that directory). A malformed or missing file safely falls back to the defaults.

```json
{
  "mini-lens-model-show": true,
  "mini-lens-thinking-show": true,
  "mini-lens-ch-show": true,
  "mini-lens-session-tokens-show": true,
  "mini-lens-cache-tokens-show": true,
  "mini-lens-cost-show": true,
  "mini-lens-context-show": true,
  "mini-lens-context-dots-show": false,
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
| `mini-lens-ch-show` | `true` | Session cache-hit rate (`CH`) |
| `mini-lens-session-tokens-show` | `true` | Accumulated session tokens (`Total`) |
| `mini-lens-cache-tokens-show` | `true` | Accumulated cache read + cache write tokens |
| `mini-lens-cost-show` | `true` | Estimated session list price |
| `mini-lens-context-show` | `true` | Used/total context tokens and progress bar |
| `mini-lens-context-dots-show` | `false` | Use a single-line dot-matrix bar instead of the default solid bar |
| `mini-lens-context-percent-show` | `true` | Context-use percentage |
| `mini-lens-speed-show` | `true` | Generation speed at the far right |
| &nbsp;&nbsp;&nbsp;&nbsp;`mini-lens-speed-unit-show` | `true` | Generation-speed sub-setting: append `tok/s` to the numeric value |
| `onboardingCompleted` | `false` initially | Internal marker that prevents another first-run prompt |

- **Generation speed**
  - **Show tok/s unit** (`mini-lens-speed-unit-show`) is the indented sub-setting shown beneath **Show latest generation speed** in `/mini-lens-settings`. Turning it off keeps the speed number (for example `40.0`) and removes only `tok/s`.
  - The sub-setting is retained when generation speed itself is hidden.

</details>

<details>
<summary><strong>How metrics work</strong> — tokens, cache, speed, and estimated price</summary>

Session totals are aggregated from each finalized `assistant` and `toolResult` entry on the active session branch. This includes nested LLM work reported by tools (such as a child agent) exactly once. `Total` uses the provider's `totalTokens` when supplied; older/custom results without it fall back to the sum of input, output, cache-read, and cache-write tokens. `Cached` is cache-read + cache-write (included in Total); `CH` is cache-read / (input + cache-read). Only persisted finalized usage is counted, so stream updates cannot double count totals.

During an assistant stream, speed appears as soon as a positive cumulative `usage.output` sample and elapsed time are available. It is refreshed while streaming and is output tokens divided by elapsed time from the assistant message start. The completed rate remains visible while later assistant messages only call tools or wait for output; it is replaced only by a newer measurable generation. Regressing output samples and non-increasing timestamps are ignored. For a tool result that reports nested LLM usage but has no stream events, the final rate is output tokens divided by that tool execution's duration. A tool that does not report output usage has no measurable speed and leaves the prior rate intact.

Before a measurable response exists, the speed field is absent entirely—Mini Lens never displays a `-- tok/s` placeholder. When present, speed is the rightmost footer field (the context percentage, if enabled, is immediately to its left). Its color uses Pi theme semantics: **success** at >=30 tok/s, **warning** at 10–29.9 tok/s, and **error** below 10 tok/s. No colors are hard-coded, so it follows the selected Pi theme.

The price is the same finalized active-branch usage and configured per-million-token rates. It is an estimate, not a provider invoice. In narrow terminals, the footer drops/truncates lower-priority content to remain one line without overflow.

</details>

<details>
<summary><strong>Development</strong> — local setup and checks</summary>

Install only the local copy while developing; installing npm and local copies together double-registers the extension:

```bash
pi remove npm:pi-mini-lens && pi install /path/to/pi-rolling-process
npm run check
npm test
```

After source changes, run `/reload` in an already-open Pi session. `npm run check` runs TypeScript checking and `npm test` runs the footer self-check.

</details>

---

[MIT License](LICENSE) · Built for [Pi](https://pi.dev)
