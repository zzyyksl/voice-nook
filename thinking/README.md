# thinking 书架（可选模块）

把你家机"脑子里想的东西"（thinking 思考链）抓下来，存进小程序的 thinking 标签页，按时间排列，卡片式展开，可选中文翻译。

**这个模块完全可选。** 不装的话，小程序的 thinking 标签就是个空书架，通话功能不受任何影响。不想让机的内心活动被看见的，跳过本目录即可。

## 安装（三步）

1. **放文件**：把本目录的 `capture.mjs` 放到 `~/thinking-app/`（和 voice-nook 服务器默认读取的路径 `/root/thinking-app/data/entries.jsonl` 对应；放别处就把 `mcp-server.mjs` 里的 `THINKING_DATA` 改成你的路径）：

```bash
mkdir -p ~/thinking-app/data
cp capture.mjs ~/thinking-app/
```

2. **开思考摘要 + 挂钩子**：编辑 `~/.claude/settings.json`，加两样东西：

```json
{
  "showThinkingSummaries": true,
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /root/thinking-app/capture.mjs 2>/dev/null || true",
            "timeout": 30,
            "async": true
          }
        ]
      }
    ]
  }
}
```

3. **（可选）中文翻译**：thinking 原文多为英文，想要中文对照的话在 `~/thinking-app/.env` 里放一行：

```
DEEPSEEK_API_KEY=你的DeepSeek密钥
```

没有这行就存原文，功能照常。DeepSeek 密钥在 platform.deepseek.com 充几块钱就能用很久。

重启 claude 后生效：每轮回复结束，钩子自动抓取本轮 thinking 存进书架，打开小程序 thinking 标签就能翻。

## 原理

Claude Code 每次回复完触发 Stop hook → `capture.mjs` 从会话 transcript 里增量抓取 thinking 块（断点续抓，不重复）→ 可选 DeepSeek 翻译 → 存进 `data/entries.jsonl` → voice-nook 的服务器读它渲染成书架。
