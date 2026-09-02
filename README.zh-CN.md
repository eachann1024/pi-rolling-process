[English](README.md) · **简体中文**

# pi-minimal-mode（极简模式）

[Pi](https://pi.dev) 的极简模式。transcript 中的顺序是：用户消息 → 过程控件块 → 助手最终答复。运行结束后块留在原位，不再消失或移动。

支持 box / panel / plain 与四种边框，可用 `/process-style` 切换。

块的高度只增不减：步骤行只追加；最后一行是状态行（运行中为盲文旋转动画 +「思考中…」；结束后为 `✅ 完成 · N 步`）。标题显示总耗时（仅时间，如 `5.1s`）。步骤行时长仍在左侧时长列，不写进文字。这样可避免 Pi transcript 的 follow-end re-latch，运行中向上滚动不会被拉回底部。收起且有隐藏步骤时标题出现 `ctrl+o 展开`，展开后改为 `ctrl+o 收起`。

```text
> 用户：帮我看看仓库结构
┌─ 极简模式 2/2 · 5.1s ────────────────────────────────────┐
│  0.4s ✅ 命令 $ ls -la                                   │
│  0.1s ✅ 读取 package.json                               │
│  0.2s ✅ 技能 browser-use/SKILL.md → 103 行              │
│   22s ✅ 子代理 list → 14 行                             │
│  1.1s ✅ 说明 先读浏览器技能，再核对帖子。               │
│  3.2s ⠀⠐ 思考中…                                         │
└──────────────────────────────────────────────────────────┘
这是一个 pi 扩展仓库，...（助手最终答复）
```

每一行 = 时长列（6 列右对齐）+ 空格 + 图标（宽 2）+ 空格 + 文字。步骤行文字为「种类 详情」；状态行文字运行中为「思考中…」（或正在运行的工具种类名），结束后为 `完成 · N 步`。步骤时长只出现在左侧时长列。结束后状态行例如 `│  5.1s ✅ 完成 · 2 步`。

动画为两个盲文格拼成 4×4 点阵正方形，12 帧沿外圈顺时针走一圈（`⠁⠀ ⠈⠀ ⠀⠁ ⠀⠈ ⠀⠐ ⠀⠠ ⠀⢀ ⠀⡀ ⢀⠀ ⡀⠀ ⠄⠀ ⠂⠀`），100ms 一帧；图标列宽 2，与 ✅ 对齐。定时器仅在 agent 运行期间开启。

需要 Pi **>= 0.84.0**。与 `pi-compact-transcript` 冲突，请先卸载。

npm 当前已发布 **1.0.5**。**1.3.0** 尚未发布。

## 外观预览

折叠 / 展开：

![折叠与展开](docs/images/collapse-expand.png)

preset 三档（box / panel / plain）：

![box / panel / plain](docs/images/presets-box-panel-plain.png)

## 安装

```bash
pi install npm:pi-minimal-mode
# 或
pi install git:github.com/eachann1024/pi-rolling-process
```

然后 `/reload`。

## 开发

只装路径副本。同时保留 npm 与本地两份会导致事件处理器双跑：

```bash
pi remove npm:pi-minimal-mode && pi install /path/to/pi-rolling-process
```

改代码后在 Pi 里 `/reload`。

- `npm run check` — `tsc` 类型检查。`tsconfig.json` 的 `paths` 指向本机全局 Pi 安装目录，请用 `npm root -g` 调整。
- `npm test` — `node test/self-check.mjs`

## 快捷键

| 键 | 作用 |
| --- | --- |
| `ctrl+o` | 展开 / 收起本过程块 |
| `/process` | 同 `ctrl+o` |

本扩展占用 `ctrl+o`，而 Pi 的 `app.tools.expand`（原生工具 dump）也常用该键。请在 `~/.pi/agent/keybindings.json` 里改绑：

```json
{
  "app.tools.expand": "ctrl+alt+o"
}
```

`hideNativeTools: true`（默认）时，折叠态隐藏所有工具卡片（含其它扩展与 MCP 工具）；按 `app.tools.expand` 展开则显示原始卡片。

## 命令

```text
/process                         展开 / 收起
/process-lines 10                收起时条数（1–20，默认 10）
/process-lang auto               auto | zh | en
/process-native                  查看当前是否隐藏原生工具块
/process-native on|off           隐藏（on，默认）或显示（off）；即时生效
```

`/process-style`：

| 用法 | 作用 |
| --- | --- |
| `/process-style` | 查看当前样式（`preset · border …`） |
| `/process-style box\|panel\|plain` | 设置 preset |
| `/process-style border single\|rounded\|double\|none` | 设置边框（`none` 无框，画框效果同 plain） |

没有其它 `/process-style` 子命令。没有 `preset` 关键字——preset 名本身就是第一个参数。

`/process-native on` 写入 `hideNativeTools: true`；`off` 写入 `false`。改完后即时生效，无需 `/reload`。不带参数时报告当前值。

## 配置

`~/.pi/agent/rolling-process.json`

```json
{
  "maxVisibleLines": 10,
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

`locale: "auto"` 跟随系统（`zh` / `en`）。`/process-lang` 可覆盖。

`hideNativeTools`（默认 `true`）在运行时包裹 `ToolExecutionComponent.prototype.render`，折叠态隐藏所有工具卡片。按 Pi 的 `app.tools.expand` 展开时显示原始卡片。`/process-native on|off` 会写入该字段并即时生效。

`hideWorkingIndicator`（默认 `true`）隐藏 Pi 原生 `Working…` 状态行，因为过程块已有自己的状态行。仅通过配置文件设置，修改后 `/reload` 生效；没有对应的 slash 命令。

`hideThinkingLabel`（默认 `true`）在 Pi 隐藏思考时把 `Thinking…` 标签置空。思考一开始就写入过程块；折叠态下原生「仅思考」流式输出会被压掉，避免先出现在过程块下方再收进去。仅通过配置文件设置，修改后 `/reload` 生效；没有对应的 slash 命令。

### 步骤分类

步骤分 6 类，种类标签按类别着色（默认如下）：

![步骤分类着色](docs/images/step-categories.png)

| 类别 | 默认颜色 | 标签 | 详情 |
| --- | --- | --- | --- |
| `builtin` | `muted` | 工具种类（读取、命令、编辑…） | 命令 / 路径 / 结果 |
| `skill` | `success` | 技能 | 技能名与文件（read/bash/ls 访问 `/skills/`、`SKILL.md`、`/.agents/` 路径时识别） |
| `extension` | `success` | 原样工具名（如 `some_mcp_tool`，保留下划线） | 与其它扩展工具卡片一致 |
| `subagent` | `accent` | 子代理 | 子代理名与结果 |
| `thought` | `dim` | 思考 | 思考内容 |
| `note` | `warning` | 说明 | 助手在调用工具前输出的中间说明文字（取首行） |

可用 `style.colors.categories` 按类别覆盖颜色。旧的 `style.colors.kind` 仍作为 `builtin` 兜底。

### 样式

| `preset` | |
| --- | --- |
| `box` | 线框 + 标题（默认） |
| `panel` | 工具卡片底 |
| `plain` | 无框 |

![边框四种](docs/images/borders-four.png)

| `border`（仅 box） | `single` `┌` · `rounded` `╭` · `double` `╔` · `none` |

图标是字符。`icons.running` 默认是 `⠁`（与源码 `DEFAULT_STYLE` 一致）。步骤行或状态行处于 running 时，该列显示 12 帧外圈动画（`⠁⠀ ⠈⠀ ⠀⠁ ⠀⠈ ⠀⠐ ⠀⠠ ⠀⢀ ⠀⡀ ⢀⠀ ⡀⠀ ⠄⠀ ⠂⠀`，100ms），不显示此配置值。`colors` 用 Pi 主题色名（`accent`、`success`、`error`、`warning`、`muted`、`dim`、`border` …）。

## 许可证

MIT
