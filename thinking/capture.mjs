// capture.mjs — Claude Code Stop hook: 从 transcript 里抓最后一轮的 thinking 存进书架
// stdin: hook JSON { transcript_path, session_id, ... }
import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";

const HERE = new URL(".", import.meta.url).pathname;
const DATA = HERE + "data/entries.jsonl";
const STATE = HERE + "data/state.json";
try { mkdirSync(HERE + "data", { recursive: true }); } catch {}

// 可选：DeepSeek 翻译。同目录 .env 里放一行 DEEPSEEK_API_KEY=sk-xxx，没有就存原文
let DEEPSEEK_KEY = "";
try {
  const env = Object.fromEntries(
    readFileSync(HERE + ".env", "utf8").split("\n").filter(Boolean)
      .map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
  );
  DEEPSEEK_KEY = env.DEEPSEEK_API_KEY || "";
} catch {}

let input = "";
try { input = readFileSync(0, "utf8"); } catch {}
let hook = {};
try { hook = JSON.parse(input); } catch {}
const tpath = hook.transcript_path;
if (!tpath || !existsSync(tpath)) process.exit(0);

// 断点续抓：记录每个 transcript 已处理到的行数
let state = {};
try { state = JSON.parse(readFileSync(STATE, "utf8")); } catch {}
const lines = readFileSync(tpath, "utf8").split("\n").filter(Boolean);
const start = state[tpath] ?? Math.max(0, lines.length - 200); // 首次只回溯最近200行
const thoughts = [];
for (let i = start; i < lines.length; i++) {
  let rec; try { rec = JSON.parse(lines[i]); } catch { continue; }
  const content = rec?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block?.type === "thinking" && block.thinking?.trim()) {
      thoughts.push({ ts: rec.timestamp || new Date().toISOString(), text: block.thinking.trim() });
    }
  }
}
state[tpath] = lines.length;
writeFileSync(STATE, JSON.stringify(state));

if (!thoughts.length) process.exit(0);

async function toZh(text) {
  if (!DEEPSEEK_KEY) return "";
  try {
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "把用户给的AI思考过程忠实翻译成简体中文。保留原文的口语感和第一人称视角，不要总结、不要润色、不要增删内容，技术名词和代码保持原样。只输出译文。" },
          { role: "user", content: text.slice(0, 6000) },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await r.json();
    return d?.choices?.[0]?.message?.content?.trim() || "";
  } catch { return ""; }
}
for (const t of thoughts) t.zh = await toZh(t.text);
for (const t of thoughts) appendFileSync(DATA, JSON.stringify({ ...t, session: hook.session_id ?? "" }) + "\n");

process.exit(0);
