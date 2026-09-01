# pi-rolling-process

A concise process viewport for [pi](https://pi.dev).

While the agent works, only the latest few tool/thought steps stay on screen. Older steps roll off. Final answer streams underneath. `ctrl+o` expands or collapses the full list.

```text
  ··· +4
  ✓ grep "herdr" .  86 lines
  ⠋ $ find / -iname '*herdr*'
  · checking installed packages
```

Then the assistant reply continues below.

## Install

```bash
pi install npm:pi-rolling-process
```

Git:

```bash
pi install git:github.com/eachann1024/pi-rolling-process
```

Try once:

```bash
pi -e npm:pi-rolling-process
```

Then `/reload`.

Recommended with:

```json
{
  "hideThinkingBlock": true,
  "outputPad": 0
}
```

If you already use `pi-compact-transcript`, turn it off so the two views do not stack:

```text
/compact-transcript off
```

Or `~/.pi/agent/compact-transcript.json`:

```json
{ "enabled": false }
```

## Behavior

- Hides `Thinking...` labels and the `Working ...` row
- Hides per-tool transcript dumps (the rolling list replaces them)
- Collapsed view shows the latest **5** steps (configurable)
- `ctrl+o` (pi's tool expand) also expands this list
- Next prompt starts counting from the first step again
- UI language follows the system (`zh` / `en`), override with `/process-lang`

## Commands

```text
/process              # expand/collapse (same as ctrl+o)
/process-lines 5      # collapsed row count (1-20)
/process-lang auto    # auto | zh | en
```

## Config

`~/.pi/agent/rolling-process.json`:

```json
{
  "maxVisibleLines": 5,
  "locale": "auto"
}
```

## License

MIT
