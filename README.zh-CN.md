[English](README.md)

# pi-minimal-mode（极简模式）

[Pi](https://pi.dev) 的紧凑、可配置全局底栏扩展（需要 Pi >= 0.84.0）。它只替换 Pi 的底栏；Pi 内置的工具和思考展示保持不变。

底栏可显示当前模型、thinking level、会话累计 Token、缓存 Token 与缓存命中率（`ch`）、会话预估价格、带进度条的上下文 Token、上下文百分比和生成速度。`deepseek/deepseek-v4-flash` 只是模型标签示例，不会被硬编码或特殊处理。

## 安装

```bash
pi install npm:pi-minimal-mode
# 或
pi install git:github.com/eachann1024/pi-rolling-process
```

安装或修改源码后，在 Pi 中执行 `/reload`。

## 首次运行与设置

首次在交互式 TUI 会话运行时，Mini Lens 会展示所有字段默认开启的预览：

```text
deepseek-v4-flash  high  Σ 45K  cache 25K  ch 40.0%  $0.012  500/1.0M  █░░░░░░░░░  1%  120 tok/s
```

首次运行选择器提供 **Keep defaults** 和 **Configure now**。保持默认会持久化全部显示项均为开启，并不再重复提示；立即配置会直接打开同一份设置列表。print、JSON 等非交互模式绝不会弹出提示。

以后随时执行下面的命令打开设置界面：

```text
/mini-lens-settings
```

修改会立即刷新底栏；该命令需要在 Pi TUI 模式中执行。设置面板中的预览始终使用固定示例数据，而不会读取当前会话，并会立即反映每个开关。

设置保存在 Pi 的全局 agent 目录（通常是 `~/.pi/agent/mini-lens.json`；若 Pi 使用其他配置目录，则随 Pi 的目录而定）。文件缺失或损坏时会安全地回退为默认值。

```json
{
  "mini-lens-model-show": true,
  "mini-lens-thinking-show": true,
  "mini-lens-ch-show": true,
  "mini-lens-session-tokens-show": true,
  "mini-lens-cache-tokens-show": true,
  "mini-lens-cost-show": true,
  "mini-lens-context-show": true,
  "mini-lens-context-percent-show": true,
  "mini-lens-speed-show": true,
  "mini-lens-speed-unit-show": true,
  "onboardingCompleted": true
}
```

| 配置项 | 默认值 | 控制内容 |
| --- | --- | --- |
| `mini-lens-model-show` | `true` | 不含 provider 前缀的模型 ID |
| `mini-lens-thinking-show` | `true` | thinking level |
| `mini-lens-ch-show` | `true` | 会话缓存命中率（`ch`） |
| `mini-lens-session-tokens-show` | `true` | 会话累计 Token（`Σ`） |
| `mini-lens-cache-tokens-show` | `true` | 累计缓存读取 + 缓存写入 Token |
| `mini-lens-cost-show` | `true` | 会话列表价预估 |
| `mini-lens-context-show` | `true` | 已用/总上下文 Token 和进度条 |
| `mini-lens-context-percent-show` | `true` | 上下文使用百分比 |
| `mini-lens-speed-show` | `true` | 最右侧生成速度 |
| &nbsp;&nbsp;&nbsp;&nbsp;`mini-lens-speed-unit-show` | `true` | 生成速度的子项：是否在数值后显示 `tok/s` |
| `onboardingCompleted` | 初始为 `false` | 用于防止再次出现首次运行提示的内部标记 |

- **生成速度**
  - **Show tok/s unit**（`mini-lens-speed-unit-show`）是 `/mini-lens-settings` 中 **Show latest generation speed** 下方缩进的次级设置。关闭后仍显示速度数值（例如 `40.0`），但去掉 `tok/s`。
  - 关闭生成速度主项时，子项值会被保留，但不会生效。

## 用量、速度与价格

会话累计值从当前会话分支上每个已完成的 `assistant` 和 `toolResult` 条目聚合。工具上报的嵌套 LLM 用量（例如子代理）也会恰好计入一次。`Σ` 优先使用服务商上报的 `totalTokens`；旧版或自定义工具结果没有该字段时，回退为 input、output、cache-read、cache-write Token 之和。`cache` 是 cache-read + cache-write；`ch` 是 cache-read / (input + cache-read)。只统计已持久化的最终用量，因此流式更新不会重复累计。

assistant 流式输出期间，一旦同时有正数的累计 `usage.output` 和已过时间，速度就会出现；流式期间会持续刷新，计算为从该 assistant 消息开始至今的输出 Token / 时间。完成后的速度会保留：之后只有工具调用或等待输出的 assistant 消息不会清除它；只有新的可测量生成才会替换它。output 倒退或时间未递增的采样会忽略。对于只在工具完成时上报嵌套 LLM 用量、没有流式事件的工具，最终速度为输出 Token / 该工具执行时长。工具没有上报 output 用量时无法可靠测速，会保留之前的速度。

还没有可测量的响应时，速度字段会完全隐藏，绝不显示 `-- tok/s` 占位内容。速度出现时固定在底栏最右侧；若开启上下文百分比，百分比紧邻在速度左边。速度颜色使用 Pi 主题语义色：>=30 tok/s 为 **success**，10–29.9 tok/s 为 **warning**，低于 10 tok/s 为 **error**。没有硬编码颜色，因此会契合当前 Pi 主题。

价格来自同一份当前分支最终用量和模型配置的每百万 Token 单价，是预估值而不是服务商账单。窄终端会降级或截断低优先级内容，以保持单行且不溢出。

## 开发

开发时只能安装本地副本；同时安装 npm 与本地副本会重复注册扩展：

```bash
pi remove npm:pi-minimal-mode && pi install /path/to/pi-rolling-process
npm run check
npm test
```

修改源码后，在已打开的 Pi 会话中执行 `/reload`。`npm run check` 做 TypeScript 检查，`npm test` 运行底栏自检。
