#!/usr/bin/env node
// Voice Call MCP Server for Rhys
// MCP stdio <-> Claude CLI | HTTP + WebSocket <-> Mini App | STT (Doubao) | TTS (MiniMax)

import { createServer } from "node:http";
import { createHmac, createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import { gzipSync, gunzipSync } from "node:zlib";

const PORT = 18010;
const ALLOWED_USER = "你的TG数字ID"; // ① 手机TG搜 @userinfobot 发条消息就能拿到
const THINKING_DATA = "/root/thinking-app/data/entries.jsonl"; // 装过thinking篇的路径对上，没装的不用管
const CALL_LOG = "/root/.claude/voice/call-log.jsonl";
const SESSION_TITLES = "/root/.claude/voice/session-titles.json";
const SESSION_GAP_MS = 30 * 60 * 1000; // entries closer than this belong to one session
const PAGE_FILE = "/root/.claude/voice/page.html";
const ASSETS_DIR = "/root/.claude/voice/assets"; // 页面图片素材目录（美化篇缓存优化用，没有也不影响）
const AUDIO_DIR = "/root/.claude/voice/audio";
const AUDIO_KEEP_DAYS = 30;
try {
  mkdirSync(AUDIO_DIR, { recursive: true });
  execSync(`find ${AUDIO_DIR} -name "*.mp3" -mtime +${AUDIO_KEEP_DAYS} -delete 2>/dev/null`);
} catch {}

// ② Telegram bot token（@BotFather 给的那串，别泄露给任何人）
const TG_TOKEN = "你的bot token";

// ──── MiniMax TTS ────
const MM_GROUP = "你的GroupId"; // ③ MiniMax 账户管理里的 GroupId
const MM_KEY = "你的MiniMax_API_Key"; // ④ 接口密钥里创建
const TTS_URL = `https://api.minimax.chat/v1/t2a_v2?GroupId=${MM_GROUP}`;
const VOICE_ID = "你的voice_id"; // ⑤ 系统音色或克隆音色的 ID

// ──── Volcengine STT ────
const VOLC_APP_ID = "你的火山APP_ID"; // ⑥ 火山引擎控制台建应用拿到
const VOLC_ACCESS_KEY = "你的火山Access_Token"; // ⑦ 同上应用里的 Access Token
const VOLC_RESOURCE = "volc.bigasr.sauc.duration";
const VOLC_WS = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";

// ════════════════════════════════════════
// MCP Protocol (JSON-RPC over stdio)
// ════════════════════════════════════════

function mcpSend(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function mcpRespond(id, result) {
  mcpSend({ jsonrpc: "2.0", id, result });
}

function mcpError(id, code, message) {
  mcpSend({ jsonrpc: "2.0", id, error: { code, message } });
}

const MCP_TOOLS = [
  {
    name: "voice_reply",
    description: "Reply to a voice message from the Mini App. Pass the request_id from the inbound <channel> meta. Text will be converted to speech and played back to the user.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Response text to speak" },
        request_id: { type: "string", description: "request_id from the inbound voice channel message" },
        zh: { type: "string", description: "Chinese translation of text. REQUIRED whenever text is not in Chinese (e.g. she asked you to speak English/Japanese) — the app shows it behind a 看翻译 button. Omit for Chinese replies." },
      },
      required: ["text", "request_id"],
    },
  },
];

// Pending voice requests: request_id -> { ws, userText, timer }
const pendingVoice = new Map();

function logCall(q, a, audio = null, zh = null) {
  try {
    const rec = { ts: new Date().toISOString(), q, a };
    if (audio) rec.audio = audio;
    if (zh) rec.zh = zh;
    appendFileSync(CALL_LOG, JSON.stringify(rec) + "\n");
  } catch (e) {
    process.stderr.write("voice-call: log error: " + e.message + "\n");
  }
}

async function handleVoiceReply(text, requestId, zh = null) {
  const pending = pendingVoice.get(requestId);
  if (!pending) return "request not found or expired";

  clearTimeout(pending.timer);
  const ws = pending.ws;

  if (ws.readyState !== WebSocket.OPEN) {
    logCall(pending.userText, text, null, zh);
    pendingVoice.delete(requestId);
    return "client disconnected";
  }

  wsSend(ws, { type: "status", text: "Rhys在说..." });

  const audioBuf = await synthesize(text);
  let audioId = null;
  if (audioBuf) {
    try {
      writeFileSync(`${AUDIO_DIR}/${requestId}.mp3`, audioBuf);
      audioId = requestId;
    } catch (e) {
      process.stderr.write("voice-call: audio save error: " + e.message + "\n");
    }
  }
  logCall(pending.userText, text, audioId, zh);

  wsSend(ws, {
    type: "reply",
    text,
    audio: audioBuf ? audioBuf.toString("base64") : null,
    zh: zh || null,
  });

  pendingVoice.delete(requestId);
  return "voice reply sent";
}

function handleMcpMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return mcpRespond(id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
        experimental: { "claude/channel": {} },
      },
      serverInfo: { name: "voice-call", version: "1.0.0" },
      instructions: [
        "Voice messages from the Mini App voice call feature.",
        "When you see <channel source=\"voice-call\">, the user spoke and their speech was transcribed to text.",
        "Reply using the voice_reply tool. ALWAYS pass the request_id from the channel meta — without it the audio cannot reach the user.",
        "Keep replies concise and conversational — they will be spoken aloud via TTS.",
        "If you reply in any language other than Chinese (she sometimes asks for English/Japanese but cannot understand them), ALWAYS also pass `zh` — a natural Chinese translation. The app shows it behind a 看翻译 button.",
        "This is the same user (your owner) as on Telegram. Respond in your own persona.",
      ].join("\n"),
    });
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    return mcpRespond(id, { tools: MCP_TOOLS });
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params;
    if (name === "voice_reply") {
      handleVoiceReply(args.text, args.request_id, args.zh || null).then(result => {
        mcpRespond(id, { content: [{ type: "text", text: result }] });
      }).catch(err => {
        mcpRespond(id, { content: [{ type: "text", text: "Error: " + err.message }], isError: true });
      });
      return;
    }
    if (id) mcpError(id, -32601, "Unknown tool: " + name);
    return;
  }

  if (method === "ping") {
    return mcpRespond(id, {});
  }

  // Unknown method with id -> error
  if (id !== undefined && id !== null) {
    mcpError(id, -32601, "Method not found");
  }
}

// Parse MCP messages from stdin (newline-delimited JSON)
let mcpBuffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", chunk => {
  mcpBuffer += chunk;
  let nl;
  while ((nl = mcpBuffer.indexOf("\n")) !== -1) {
    const line = mcpBuffer.slice(0, nl).trim();
    mcpBuffer = mcpBuffer.slice(nl + 1);
    if (!line) continue;
    try { handleMcpMessage(JSON.parse(line)); } catch (e) {
      process.stderr.write("voice-call: MCP parse error: " + e.message + "\n");
    }
  }
});

// ════════════════════════════════════════
// STT: Volcengine binary protocol
// ════════════════════════════════════════

function sttHeader(msgType, msgFlags, ser, comp) {
  return Buffer.from([(0x1 << 4) | 0x1, (msgType << 4) | msgFlags, (ser << 4) | comp, 0x00]);
}

function recognize(pcmBuf) {
  return new Promise((resolve) => {
    const ws = new WebSocket(VOLC_WS, {
      headers: {
        "X-Api-App-Key": VOLC_APP_ID,
        "X-Api-Access-Key": VOLC_ACCESS_KEY,
        "X-Api-Resource-Id": VOLC_RESOURCE,
        "X-Api-Request-Id": randomUUID(),
        "X-Api-Connect-Id": randomUUID(),
        "X-Api-Sequence": "-1",
      },
    });
    let finalText = "", gotFirst = false;
    const timer = setTimeout(() => { ws.close(); resolve(finalText || ""); }, 15000);

    function sendAudio() {
      const sz = 3200; let off = 0;
      const go = () => {
        if (off < pcmBuf.length) {
          const end = Math.min(off + sz, pcmBuf.length);
          const last = end >= pcmBuf.length;
          const comp = gzipSync(pcmBuf.slice(off, end));
          const h = sttHeader(0x2, last ? 0x2 : 0x0, 0x0, 0x1);
          const s = Buffer.alloc(4); s.writeUInt32BE(comp.length);
          ws.send(Buffer.concat([h, s, comp]));
          off = end;
          if (!last) setTimeout(go, 100);
        }
      };
      go();
    }

    ws.on("open", () => {
      const payload = gzipSync(Buffer.from(JSON.stringify({
        user: { uid: "voice_call" },
        audio: { format: "pcm", rate: 16000, bits: 16, channel: 1, language: "zh-CN" },
        request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, show_utterances: true, result_type: "full" },
      })));
      const h = sttHeader(0x1, 0x0, 0x1, 0x1);
      const s = Buffer.alloc(4); s.writeUInt32BE(payload.length);
      ws.send(Buffer.concat([h, s, payload]));
    });

    ws.on("message", (data) => {
      const buf = Buffer.from(data);
      const mt = (buf[1] >> 4) & 0xF, mf = buf[1] & 0xF, mc = buf[2] & 0xF;
      if (mt === 0xF) return;
      if (mt === 0x9) {
        if (!gotFirst) { gotFirst = true; sendAudio(); }
        let off = 4; if (mf & 0x1) off += 4;
        const psz = buf.readUInt32BE(off);
        try {
          const d = JSON.parse((mc === 1 ? gunzipSync(buf.slice(off + 4, off + 4 + psz)) : buf.slice(off + 4, off + 4 + psz)).toString());
          if (d.result?.text) finalText = d.result.text;
          if (mf & 0x2) { clearTimeout(timer); ws.close(); resolve(finalText); }
        } catch {}
      }
    });
    ws.on("error", () => { clearTimeout(timer); resolve(finalText || ""); });
  });
}

// ════════════════════════════════════════
// TTS: MiniMax
// ════════════════════════════════════════

async function synthesize(text) {
  // speed 从 tts-config.json 热读，改配置即时生效不用重启（没有该文件就用默认值）
  let speed = 1.2;
  try { speed = JSON.parse(readFileSync(new URL("./tts-config.json", import.meta.url), "utf8")).speed ?? speed; } catch {}
  const body = {
    model: "speech-02-hd",
    text,
    stream: false,
    voice_setting: { voice_id: VOICE_ID, speed, vol: 1.0, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3" },
  };
  try {
    const r = await fetch(TTS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${MM_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.data?.audio) return Buffer.from(j.data.audio, "hex");
    if (j.base_resp?.status_code) process.stderr.write("TTS error: " + JSON.stringify(j.base_resp) + "\n");
  } catch (e) {
    process.stderr.write("TTS fetch error: " + e.message + "\n");
  }
  return null;
}

// ════════════════════════════════════════
// Auth & Helpers
// ════════════════════════════════════════

function checkInitData(raw) {
  try {
    const p = new URLSearchParams(raw);
    const hash = p.get("hash");
    if (!hash) return null;
    p.delete("hash");
    const dataCheck = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const secret = createHmac("sha256", "WebAppData").update(TG_TOKEN).digest();
    const calc = createHmac("sha256", secret).update(dataCheck).digest("hex");
    if (calc !== hash) return null;
    const user = JSON.parse(p.get("user") || "{}");
    return String(user.id) === ALLOWED_USER ? user : null;
  } catch { return null; }
}

function loadEntries() {
  if (!existsSync(THINKING_DATA)) return [];
  return readFileSync(THINKING_DATA, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function parseBoundary(ct) {
  const m = ct?.match(/boundary=(.+)/);
  return m ? m[1] : null;
}

function extractFile(body, boundary) {
  const delim = Buffer.from("--" + boundary);
  let start = body.indexOf(delim);
  if (start < 0) return null;
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), start);
  if (headerEnd < 0) return null;
  const nextDelim = body.indexOf(delim, headerEnd + 4);
  if (nextDelim < 0) return null;
  return body.slice(headerEnd + 4, nextDelim - 2);
}

function wsSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ════════════════════════════════════════
// HTML Page
// ════════════════════════════════════════

const PAGE = `<h3 style="font-family:sans-serif">page.html 没找到，检查 PAGE_FILE 路径</h3>`;

// ════════════════════════════════════════
// HTTP Server
// ════════════════════════════════════════

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/") {
    try {
      const html = readFileSync(PAGE_FILE, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
  }

  // 静态图片素材：带7天强缓存，页面图片只需下载一次（美化篇缓存优化）
  if (url.pathname.startsWith("/assets/")) {
    const fname = url.pathname.slice("/assets/".length);
    if (/[^a-zA-Z0-9._-]/.test(fname)) { res.writeHead(400); return res.end(); }
    const fpath = `${ASSETS_DIR}/${fname}`;
    if (!existsSync(fpath)) { res.writeHead(404); return res.end(); }
    const ext = fname.split(".").pop();
    const ct = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : "application/octet-stream";
    res.writeHead(200, { "content-type": ct, "cache-control": "public, max-age=604800, stale-while-revalidate=2592000" });
    return res.end(readFileSync(fpath));
  }

  if (url.pathname.startsWith("/api/audio/")) {
    const user = checkInitData(url.searchParams.get("initData") || req.headers["x-init-data"] || "");
    if (!user) { res.writeHead(403); return res.end(); }
    const id = url.pathname.slice("/api/audio/".length);
    if (!/^[a-f0-9-]{8,64}$/.test(id) || !existsSync(`${AUDIO_DIR}/${id}.mp3`)) {
      res.writeHead(404); return res.end();
    }
    res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400" });
    return res.end(readFileSync(`${AUDIO_DIR}/${id}.mp3`));
  }

  if (url.pathname === "/api/calls") {
    const user = checkInitData(req.headers["x-init-data"] || "");
    if (!user) { res.writeHead(403, { "content-type": "application/json" }); return res.end('{"error":"forbidden"}'); }
    let all = [];
    if (existsSync(CALL_LOG)) {
      all = readFileSync(CALL_LOG, "utf8").split("\n").filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
    // group chronological entries into sessions split by SESSION_GAP_MS;
    // session id = ts of its first entry (stable: log is append-only)
    const sessions = [];
    for (const e of all) {
      const last = sessions[sessions.length - 1];
      if (last && new Date(e.ts) - new Date(last.end) < SESSION_GAP_MS) {
        last.items.push(e);
        last.end = e.ts;
      } else {
        sessions.push({ id: e.ts, start: e.ts, end: e.ts, items: [e] });
      }
    }
    sessions.reverse();
    let titles = {};
    try { titles = JSON.parse(readFileSync(SESSION_TITLES, "utf8")); } catch {}
    for (const s of sessions) s.title = titles[s.id] || null;
    const off = Number(url.searchParams.get("offset") || 0);
    const lim = Math.min(Number(url.searchParams.get("limit") || 10), 50);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify({ total: sessions.length, items: sessions.slice(off, off + lim) }));
  }

  if (url.pathname === "/api/session-title" && req.method === "POST") {
    const user = checkInitData(req.headers["x-init-data"] || "");
    if (!user) { res.writeHead(403, { "content-type": "application/json" }); return res.end('{"error":"forbidden"}'); }
    let body = "";
    req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      try {
        const { id, title } = JSON.parse(body);
        if (typeof id !== "string" || !id) throw new Error("bad id");
        let titles = {};
        try { titles = JSON.parse(readFileSync(SESSION_TITLES, "utf8")); } catch {}
        const t = String(title || "").trim().slice(0, 60);
        if (t) titles[id] = t; else delete titles[id];
        writeFileSync(SESSION_TITLES, JSON.stringify(titles, null, 2));
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":"bad request"}');
      }
    });
    return;
  }

  if (url.pathname === "/api/list") {
    const user = checkInitData(req.headers["x-init-data"] || "");
    if (!user) { res.writeHead(403, { "content-type": "application/json" }); return res.end('{"error":"forbidden"}'); }
    const all = loadEntries().reverse();
    const off = Number(url.searchParams.get("offset") || 0);
    const lim = Math.min(Number(url.searchParams.get("limit") || 30), 100);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify({ total: all.length, items: all.slice(off, off + lim) }));
  }

  res.writeHead(404);
  res.end();
});

// ════════════════════════════════════════
// WebSocket Server (voice)
// ════════════════════════════════════════

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/ws/voice") {
    const initData = url.searchParams.get("initData") || "";
    const user = checkInitData(initData);
    if (!user) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

let connSeq = 0;
let lastAudio = { md5: "", ts: 0 };
let lastUtterance = { text: "", ts: 0 };

wss.on("connection", (ws) => {
  const connId = ++connSeq;
  process.stderr.write(`voice-call: client connected (conn=${connId}, active=${wss.clients.size})\n`);

  ws.on("message", async (data, isBinary) => {
    if (!isBinary && typeof data === "string") return;

    const audioData = Buffer.from(data);
    if (audioData.length < 100) {
      wsSend(ws, { type: "error", text: "音频太短了" });
      return;
    }

    const md5 = createHash("md5").update(audioData).digest("hex").slice(0, 8);
    process.stderr.write(`voice-call: audio conn=${connId} bytes=${audioData.length} md5=${md5}\n`);

    // Drop byte-identical audio arriving within 10s (client/tunnel duplication)
    if (md5 === lastAudio.md5 && Date.now() - lastAudio.ts < 10000) {
      process.stderr.write(`voice-call: duplicate audio dropped (conn=${connId})\n`);
      return;
    }
    lastAudio = { md5, ts: Date.now() };

    const requestId = randomUUID();

    try {
      // Convert to PCM
      wsSend(ws, { type: "status", text: "识别中..." });
      const tmpIn = `/tmp/voice_${requestId}.ogg`;
      const tmpOut = `/tmp/voice_${requestId}.pcm`;
      writeFileSync(tmpIn, audioData);
      execSync(`ffmpeg -y -i ${tmpIn} -ar 16000 -ac 1 -f s16le ${tmpOut} 2>/dev/null`);
      const pcm = readFileSync(tmpOut);
      execSync(`rm -f ${tmpIn} ${tmpOut}`);

      // STT
      const text = await recognize(pcm);
      if (!text) {
        wsSend(ws, { type: "error", text: "没听清，再说一次" });
        return;
      }

      // Second dedupe layer: same transcript within 8s (two recordings of one utterance)
      if (text === lastUtterance.text && Date.now() - lastUtterance.ts < 8000) {
        process.stderr.write(`voice-call: duplicate transcript dropped (conn=${connId}): ${text}\n`);
        wsSend(ws, { type: "status", text: "按住说话" });
        return;
      }
      lastUtterance = { text, ts: Date.now() };

      wsSend(ws, { type: "transcript", text });
      wsSend(ws, { type: "status", text: "Rhys在想..." });

      // Store pending and notify Claude CLI
      pendingVoice.set(requestId, {
        ws,
        userText: text,
        timer: setTimeout(() => {
          pendingVoice.delete(requestId);
          logCall(text, null);
          wsSend(ws, { type: "error", text: "Rhys想太久了，再试一次" });
        }, 120000),
      });

      mcpSend({
        jsonrpc: "2.0",
        method: "notifications/claude/channel",
        params: {
          content: text,
          meta: {
            chat_id: "voice_call",
            user: "owner",
            user_id: ALLOWED_USER,
            request_id: requestId,
            ts: new Date().toISOString(),
          },
        },
      });

    } catch (e) {
      process.stderr.write("voice-call: processing error: " + e.message + "\n");
      wsSend(ws, { type: "error", text: "出错了: " + e.message });
    }
  });

  ws.on("close", () => {
    process.stderr.write("voice-call: client disconnected\n");
  });
});

// ════════════════════════════════════════
// Start
// ════════════════════════════════════════

// Kill any existing process on PORT
try {
  const pid = execSync(`lsof -ti:${PORT} 2>/dev/null`).toString().trim();
  if (pid) {
    process.stderr.write(`voice-call: killing existing process on :${PORT} (pid ${pid})\n`);
    execSync(`kill ${pid} 2>/dev/null`);
    execSync("sleep 1");
  }
} catch {}

httpServer.listen(PORT, () => {
  process.stderr.write(`voice-call: MCP + HTTP server on :${PORT}\n`);
});

// Shutdown
function shutdown() {
  process.stderr.write("voice-call: shutting down\n");
  for (const [, p] of pendingVoice) clearTimeout(p.timer);
  pendingVoice.clear();
  wss.close();
  httpServer.close();
  setTimeout(() => process.exit(0), 1000);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
