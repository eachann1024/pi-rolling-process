[English](README.md) · **简体中文**

# pi-minimal-mode（极简模式）

[Pi](https://pi.dev) 的极简模式。固定框里只留最近步骤，旧的被顶掉。最终回答出现在框下方。

```text
┌─ 极简模式 5/118 · 已折叠 113 · ctrl+o 展开 ctrl+alt+o 原始展开 ─
│ ❌ 读取 /tmp/foo.ts
│ ✅ 思考 验证完成 2.8s
│ ✅ 查找 "_tmp_repro" . -> 5 行 2ms
│ 🟡 思考 正在核对剩余匹配
└──────────────────────────────────────────────
```

需要 Pi **>= 0.84.0**。与 `pi-compact-transcript` 冲突，请先卸载。

## 安装

```bash
pi install npm:pi-minimal-mode
# 或
pi install git:github.com/eachann1024/pi-rolling-process
```

然后 `/reload`。

## 快捷键

| 键 | 作用 |
| --- | --- |
| `ctrl+o` | 展开 / 收起本过程列表 |
| `ctrl+alt+o` | Pi 原生工具 dump |
| `/process` | 同 `ctrl+o` |

## 命令

```text
/process                      展开 / 收起
/process-lines 6              收起时条数（1–20）
/process-lang auto            auto | zh | en
/process-style                查看当前样式
/process-style box            box | panel | plain
/process-style border rounded single | rounded | double | none
```

## 配置

`~/.pi/agent/rolling-process.json`

```json
{
  "maxVisibleLines": 6,
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

`locale: "auto"` 跟随系统（`zh` / `en`）。`/process-lang` 可覆盖。

### 样式

| `preset` | |
| --- | --- |
| `box` | 线框 + 标题（默认） |
| `panel` | 工具卡片底 |
| `plain` | 无框 |

| `border`（仅 box） | `single` `┌` · `rounded` `╭` · `double` `╔` · `none` |

图标是字符。`colors` 用 Pi 主题色名（`success`、`error`、`warning`、`muted`、`dim`、`border` …）。

## 许可证

MIT
