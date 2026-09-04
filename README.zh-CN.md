[English](README.md) · **简体中文**

# pi-minimal-mode（极简模式）

[Pi](https://pi.dev) 的 inline 过程摘要扩展（需要 Pi >= 0.84.0）。

纯文本对话不会插入任何内容，transcript 保持「用户消息 → 最终答复」。当本轮出现工具或思考事件时，扩展只追加一条过程记录，位置在用户消息与最终答复之间；它是嵌入 transcript 的紧凑披露摘要，不是浮动面板或 dock。

```text
> 用户：检查仓库

▸ 已完成 · 最近 6 条 · ctrl+o 展开

仓库包含……
```

按 `ctrl+o` 或执行 `/process` 可展开/收起当前过程记录。展开后显示最近记录；更早记录会以披露行标明数量。过程界面的所有文案均为英文，包括 Thinking 和完成状态。过程状态使用文本符号（`✓`、`✗`、`!`、`▸`、`▾`），不使用 emoji。扩展工具名保持原样，例如 `some_mcp_tool`。

## 安装

```bash
pi install npm:pi-minimal-mode
# 或
pi install git:github.com/eachann1024/pi-rolling-process
```

随后在 Pi 中执行 `/reload`。

## 开发

只安装路径副本；同时安装 npm 与本地副本会重复注册事件处理器：

```bash
pi remove npm:pi-minimal-mode && pi install /path/to/pi-rolling-process
```

修改源码后，在已打开的 Pi 会话中执行 `/reload`。

- `npm run check` — TypeScript 类型检查
- `npm test` — 扩展自检

## 控制

| 输入 | 作用 |
| --- | --- |
| `ctrl+o` | 展开或收起当前过程记录 |
| `/process` | 同 `ctrl+o` |
| `/process 1-100` | 保存并应用最近记录数（默认 6） |
| `/process-native` | 查看是否隐藏原生工具卡片 |
| `/process-native on` | 立即隐藏原生 Pi 工具卡片（默认） |
| `/process-native off` | 立即显示原生 Pi 工具卡片 |

`ctrl+o` 可能与 Pi 的原生工具展开快捷键冲突；如有需要，请在 `~/.pi/agent/keybindings.json` 中改绑 `app.tools.expand`。

## 配置

插件只在 `~/.pi/agent/rolling-process.json` 保存以下设置：

```json
{
  "maxRecords": 6,
  "hideNativeTools": true,
  "hideWorkingIndicator": true,
  "hideThinkingLabel": true
}
```

`hideNativeTools` 默认为 `true`：运行时会抑制原生 `ToolExecutionComponent` 卡片渲染，但 inline 过程记录始终保留。`/process-native on|off` 会保存设置，并立即刷新已有原生卡片。

`hideWorkingIndicator` 默认隐藏 Pi 原生 `Working…` 行；`hideThinkingLabel` 默认清除 Pi 原生思考标签。修改这两个配置后，重新加载扩展即可生效。

## 分类

展开后的行按类别着色：内置工具为 `muted`；技能和扩展工具为 `success`；子代理为 `accent`；思考为 `warning`。读取 `SKILL.md` 会归为技能；扩展工具名按原样显示。
