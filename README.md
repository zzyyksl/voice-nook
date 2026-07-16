# 📞 voice-nook · 语音小屋

给你的 AI 装上耳朵和嘴 —— 在 Telegram 小程序里和你的 Claude Code 伙伴打电话。

by 卷心菜 & Rhys（小红书 5479370809）· 姐妹篇：[reading-nook 共读小屋](https://github.com/zzyyksl/reading-nook)

## 它能做什么

- **按住说话**：录音 → 语音识别 → 你的机思考回答 → 用它自己的声音说给你听
- **重听**：每句回复都能重播，全局单播放器，连点不叠音
- **通话历史**：按时间自动分组成一次次通话，卡片折叠展开，可以给每次通话起名字
- **看翻译**：让它说英语/日语时，句子下面有翻译按钮
- **thinking 书架**：搭配 thinking 抓取（可选），随时翻你家机的脑子
- **只属于你**：服务器校验 Telegram 签名和你的用户 ID，别人打开只能看到一句拒绝语

## 原理

```
你按住说话（Telegram Mini App）
      │ 录音经 WebSocket 发到你的服务器
      ▼
mcp-server.mjs（一鱼三吃：MCP 服务器 + HTTP + WebSocket）
      │ ffmpeg 转码 → 火山引擎豆包 STT 识别成文字
      ▼
文字作为 channel 消息推给 Claude Code，机调用 voice_reply 回话
      ▼
MiniMax TTS 合成它的声音 → 推回小程序播放 + 存档 30 天
      ▲
cloudflared 隧道 → HTTPS 公网地址 → 聊天框旁的小程序按钮
```

## 快速开始

保姆级教程见 [`docs/语音通话小程序全教程.txt`](docs/语音通话小程序全教程.txt)——它是写给**你家机**看的：把教程文件丢给你的 Claude Code，说一句"照这个装"，它会自己搭好，中途问你要几把钥匙。

你需要准备的账号（都是网页上点点点）：

| 东西 | 作用 | 哪里拿 |
|---|---|---|
| Telegram bot token | 小程序入口 | @BotFather |
| MiniMax GroupId + API Key + voice_id | 它的嘴（TTS，可克隆声音） | platform.minimaxi.com |
| 火山引擎 APP ID + Access Token | 它的耳朵（流式语音识别大模型） | console.volcengine.com |

另需：Linux 服务器、Node.js 18+、ffmpeg、cloudflared。

```bash
# 核心三步（细节看教程）
mkdir -p ~/.claude/voice/audio && cd ~/.claude/voice
npm init -y && npm install ws
# 填好 mcp-server.mjs 顶部 7 个配置项，然后：
claude mcp add --scope user voice-call -- node ~/.claude/voice/mcp-server.mjs
# 启动 claude 时加上：
#   --dangerously-load-development-channels server:voice-call
```

## 主题

仓库自带干净的深色默认皮。`themes/` 里有完整主题包：

- **黑曜石**（夜间）：多雷雕版画天使打底，深色玻璃卡片，玻璃圆球，白色呼吸光圈
- **小花园**（日间）：奶油纸底，树叶花环说话按钮，木牌标题（有只黑猫），水彩盆栽
- 标签栏右上角「夜／日」钮一键切换，选择会记住

安装看 [`themes/美化篇.txt`](themes/美化篇.txt)：换一个文件 + 把 3 处名字替换成你家机的，完事。素材全部内嵌，无需下载。

## 安全说明

- `ALLOWED_USER` 白名单 + Telegram initData HMAC 校验，双保险
- 所有密钥写在你自己服务器的文件里，不经过任何第三方
- 语音文件本地保存 30 天后自动清理

## License

MIT · 有问题提 issue，有心意提 PR。

🤖 Co-created with [Claude Code](https://claude.com/claude-code)
