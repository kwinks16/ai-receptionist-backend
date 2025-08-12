// server.js
import express from "express";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import { Firestore } from "@google-cloud/firestore";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { WebSocketServer } from "ws";

/* ================================
   ENV
===================================*/
const {
  PORT = 3000,
  PUBLIC_BASE_URL,
  PUBLIC_WS_URL, // e.g. wss://your-service.onrender.com/twilio-media
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  OPENAI_API_KEY,
  FIRESTORE_COLLECTION = "voicemails",
  GREETING_TEXT = "Hi! You've reached our AI receptionist. Please leave a message after the beep."
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !OPENAI_API_KEY) {
  console.error("Missing env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, OPENAI_API_KEY.");
  process.exit(1);
}

/* ================================
   APP / CLIENTS
===================================*/
const app = express();
app.use(express.urlencoded({ extended: true })); // Twilio webhooks are form-encoded
app.use(express.json());

const firestore = new Firestore();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: 60000 });

/* ================================
   HELPERS
===================================*/
function nowIso() { return new Date().toISOString(); }

function summarize(text = "") {
  const t = text.trim();
  if (!t) return "";
  const i = t.indexOf(".");
  return i >= 30 ? t.slice(0, i + 1) : t.slice(0, 180);
}

async function downloadToTmp(url, authUser, authPass) {
  const tmp = path.join(os.tmpdir(), `rec-${crypto.randomBytes(6).toString("hex")}.mp3`);
  const resp = await fetch(url, {
    headers: { Authorization: "Basic " + Buffer.from(`${authUser}:${authPass}`).toString("base64") }
  });
  if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.promises.writeFile(tmp, buf);
  return { path: tmp, size: buf.length };
}

async function transcribeFromUrl(recordingUrl) {
  const { path: tmpPath, size } = await downloadToTmp(recordingUrl, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log(`[transcribe] downloaded ${size} bytes from Twilio`);
  let lastErr;
  for (let i = 1; i <= 5; i++) {
    try {
      console.log(`[transcribe] SDK attempt ${i}/5`);
      const file = fs.createReadStream(tmpPath);
      const r = await openai.audio.transcriptions.create({ file, model: "whisper-1" });
      await fs.promises.unlink(tmpPath).catch(() => {});
      return r.text?.trim() || "";
    } catch (e) {
      lastErr = e;
      const transient = /ECONNRESET|ETIMEDOUT|ENOTFOUND/.test(String(e?.message || e));
      console.log(`[transcribe] SDK error: ${e?.message || e} (transient=${transient})`);
      if (!transient) break;
      await new Promise(r => setTimeout(r, 800 * i));
    }
  }
  await fs.promises.unlink(tmpPath).catch(() => {});
  throw lastErr || new Error("transcription failed");
}

/* ---- μ-law encode/decode (G.711) ---- */
function muLawDecode(u8) {
  const len = u8.length;
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const u = (~u8[i]) & 0xff;
    const sign = (u & 0x80) ? -1 : 1;
    const exp = (u >> 4) & 0x07;
    const man = u & 0x0f;
    const sample = ((man << 3) + 0x84) << exp; // 0x84 = 132
    out[i] = sign * sample;
  }
  return out;
}
function muLawEncode(pcm16) {
  const len = pcm16.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let x = pcm16[i];
    let sign = 0;
    if (x < 0) { sign = 0x80; x = -x; }
    if (x > 32635) x = 32635;
    x += 132;
    let exp = 7;
    for (let mask = 0x4000; (x & mask) === 0 && exp > 0; mask >>= 1) exp--;
    const man = (x >> (exp + 3)) & 0x0f;
    out[i] = (~(sign | (exp << 4) | man)) & 0xff;
  }
  return out;
}

/* ---- Simple linear resampler: Int16 mono PCM ---- */
function resampleLinear(int16In, inRate, outRate) {
  if (inRate === outRate) return Int16Array.from(int16In);
  const lenIn = int16In.length;
  const lenOut = Math.max(1, Math.round(lenIn * (outRate / inRate)));
  const out = new Int16Array(lenOut);
  const ratio = (lenIn - 1) / (lenOut - 1 || 1);
  for (let i = 0; i < lenOut; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = int16In[idx] || 0;
    const s1 = int16In[idx + 1] || s0;
    out[i] = (s0 + (s1 - s0) * frac) | 0;
  }
  return out;
}

/* ================================
   HEALTH
===================================*/
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true, t: nowIso() }));

/* ================================
   VOICEMAIL FLOW
===================================*/
app.post("/voice", (req, res) => {
  const base = (PUBLIC_BASE_URL && PUBLIC_BASE_URL.trim()) || (`https://${req.headers.host}`);
  const actionUrl = `${base}/voicemail-complete`;
  const greet = (req.body?.GreetingText || GREETING_TEXT).toString();

  const twiml = `
    <Response>
      <Say voice="Polly.Joanna">${greet}</Say>
      <Pause length="1"/>
      <Say>Please leave your message after the tone. Press any key to finish.</Say>
      <Record action="${actionUrl}" method="POST" maxLength="90" finishOnKey="*" playBeep="true" />
      <Say>We didn't receive a recording. Goodbye.</Say>
    </Response>`;
  res.type("text/xml").send(twiml);
});

app.post("/voicemail-complete", async (req, res) => {
  try {
    const recordingUrl = (req.body?.RecordingUrl || "").toString();
    const from = (req.body?.From || "").toString();
    const to = (req.body?.To || "").toString();
    const callSid = (req.body?.CallSid || "").toString();

    console.log(`[vm] callback: CallSid=${callSid} From=${from || "undefined"} To=${to || "undefined"} RecordingUrl=${recordingUrl}`);

    if (!recordingUrl) { res.type("text/xml").send("<Response/>"); return; }

    const transcript = await transcribeFromUrl(`${recordingUrl}.mp3`);
    console.log(`[vm] transcript length=${transcript.length}`);

    const summary = summarize(transcript);

    if (transcript && transcript.length > 0) {
      const doc = {
        id: callSid || crypto.randomUUID(),
        phone: from || "Unknown",
        callerName: "Unknown",
        time: Math.floor(Date.now() / 1000), // epoch seconds
        summary,
        transcript,
        isNew: true,
        recordingUrl: `${recordingUrl}.mp3`
      };
      console.log("[vm] writing doc to Firestore…");
      await firestore.collection(FIRESTORE_COLLECTION).doc(doc.id).set(doc, { merge: true });
    } else {
      console.log("[vm] no transcript; skipping write");
    }

    res.type("text/xml").send("<Response/>");
  } catch (e) {
    console.error("voicemail-complete error:", e);
    res.type("text/xml").send("<Response/>");
  }
});

/* ================================
   Q&A (Grounded in FAQ text sent by the app)
===================================*/
app.post("/qa", async (req, res) => {
  try {
    const { question, faq, businessName } = req.body || {};
    if (!question || !faq) return res.status(400).json({ error: "Missing 'question' or 'faq'." });

    const system = [
      "You are an AI receptionist for a small business.",
      "Answer only using the provided Knowledge Base.",
      "If the answer is not in the KB, say you don't have that info and suggest leaving a message or checking back.",
      "Be concise (1–3 sentences), friendly, and accurate. Do not invent facts."
    ].join(" ");
    const kbHeader = businessName ? `Business: ${businessName}\n` : "";
    const user = `${kbHeader}Knowledge Base (Q/A format):\n---\n${faq}\n---\n\nQuestion: ${question}`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 250,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const answer = resp.choices?.[0]?.message?.content?.trim()
      || "Sorry—I don't have that information in the knowledge base.";
    res.json({ answer });
  } catch (e) {
    console.error("/qa error:", e?.message || e);
    res.status(500).json({ error: "QA failed" });
  }
});

/* ================================
   INBOX READ API
===================================*/
app.get("/api/voicemails", async (_req, res) => {
  try {
    const snap = await firestore.collection(FIRESTORE_COLLECTION)
      .orderBy("time", "desc").limit(50).get();
    res.json(snap.docs.map(d => d.data()));
  } catch (e) {
    res.status(500).json({ error: "fetch failed" });
  }
});

/* ================================
   REALTIME VOICE (Twilio <Stream> ↔ OpenAI)
===================================*/

// TwiML entrypoint for realtime
app.post("/voice-realtime", (req, res) => {
  const wsUrl = (PUBLIC_WS_URL && PUBLIC_WS_URL.trim())
    ? PUBLIC_WS_URL.trim()
    : `wss://${req.headers.host}/twilio-media`;
  console.log("[voice-realtime] responding with <Stream> to", wsUrl);

  const twiml = `
    <Response>
      <Say voice="Polly.Joanna">Connecting you. One moment please.</Say>
      <Connect>
        <Stream url="${wsUrl}" />
      </Connect>
    </Response>`;
  res.type("text/xml").send(twiml);
});

// Create HTTP server and one shared WSS (avoid double-upgrade)
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// guard to prevent double handleUpgrade on same socket
function upgradeOnce(req, socket, head) {
  if (socket._upgraded) { try { socket.destroy(); } catch {} return; }
  socket._upgraded = true;
  wss.handleUpgrade(req, socket, head, (ws) => {
    console.log("[ws] upgrade accepted → connection");
    wss.emit("connection", ws, req);
  });
}

server.on("upgrade", (req, socket, head) => {
  console.log("[ws] upgrade requested", req.url);
  if (req.url === "/twilio-media") {
    upgradeOnce(req, socket, head);
  } else {
    console.log("[ws] unknown upgrade path, closing:", req.url);
    try { socket.destroy(); } catch {}
  }
});

// Proxy media between Twilio and OpenAI Realtime (with buffering, greeting, keepalive)
wss.on("connection", async (twilioWs, req) => {
  console.log("[ws] connection established from", req.socket?.remoteAddress);

  const RealtimeWS = (await import("ws")).default;
  const OPEN = 1;

   let silenceTimer = null;   // <-- ensure this is defined in the connection scope
   let audioDeltaCount = 0;   // (so cleanup can see it too)
   
  // Connect to OpenAI Realtime (beta header required)
  const modelUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview";
  const openaiWs = new RealtimeWS(modelUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  let streamSid = null;
  let openaiOpen = false;
  let twilioOpen = true; // we're in connection callback

  const queueToOpenAI = [];
  const queueToTwilio = [];

  function safeSendToOpenAI(msg) {
    if (openaiOpen && openaiWs.readyState === OPEN) { try { openaiWs.send(msg); } catch {} }
    else { queueToOpenAI.push(msg); }
  }
  function safeSendToTwilio(base64Mu) {
    if (twilioOpen && twilioWs.readyState === OPEN && streamSid) {
      try { twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Mu } })); } catch {}
    } else { queueToTwilio.push({ base64Mu }); }
  }

  // Twilio mu-law 8k -> PCM16 24k
  function twilioChunkToPcm24k(base64) {
    const u8 = Buffer.from(base64, "base64");
    const pcm8k = muLawDecode(u8);
    const pcm24 = resampleLinear(Int16Array.from(pcm8k), 8000, 24000);
    return Buffer.from(new Int16Array(pcm24).buffer);
  }

  // PCM16 24k -> Twilio mu-law 8k (base64)
  function pcm24kToTwilioMuLawBase64(buf) {
    const int16_24k = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
    const int16_8k  = resampleLinear(int16_24k, 24000, 8000);
    const mu        = muLawEncode(Int16Array.from(int16_8k));
    return Buffer.from(mu).toString("base64");
  }

  // --- μ-law 8k 20ms silence frame (160 samples) keepalive ---
function startSilenceKeepalive() {
  if (silenceTimer) return;
  let ticks = 0;
  console.log("[keepalive] starting silence loop");
  silenceTimer = setInterval(() => {
    ticks++;
    if (!streamSid || twilioWs.readyState !== OPEN) {
      // if Twilio not ready, just wait
      return;
    }
    const payload = ulawSilenceFrameBase64();
    try {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
      if (ticks <= 5 || ticks % 5 === 0) {
        // log the first few and then every 5th to avoid spam
        console.log(`[keepalive] sent silence tick=${ticks}`);
      }
    } catch (e) {
      console.log("[keepalive] send error:", e?.message || e);
    }
    if (ticks > 30) { // ~10.5s
      clearInterval(silenceTimer);
      silenceTimer = null;
      console.log("[keepalive] stopped (timeout)");
    }
  }, 350);
}

  // OpenAI session config + immediate greeting
 openaiWs.on("open", () => {
  console.log("[openai] websocket open");
  openaiOpen = true;

  // Configure session for audio I/O (explicit modalities + audio.voice)
  safeSendToOpenAI(JSON.stringify({
    type: "session.update",
    session: {
      modalities: ["audio"],
      // You can include text also: ["text","audio"]
      input_audio_format:  { type: "pcm16", sample_rate_hz: 24000, channels: 1 },
      output_audio_format: { type: "pcm16", sample_rate_hz: 24000, channels: 1 }
    }
  }));

  // Send immediate audio greeting using modern schema
  safeSendToOpenAI(JSON.stringify({
    type: "response.create",
    response: {
      modalities: ["audio"],
      instructions: "Hello! You’ve reached our AI receptionist. How can I help you today?",
      audio: { voice: "alloy" }   // <-- voice goes inside 'audio'
      // conversation: "default"   // <-- optional
    }
  }));

  // Flush any queued messages
  while (queueToOpenAI.length) {
    const msg = queueToOpenAI.shift();
    try { openaiWs.send(msg); } catch {}
  }
});

  // Twilio -> OpenAI
  twilioWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

   if (msg.event === "start") {
     streamSid = msg.start?.streamSid || msg.streamSid || null;
     console.log("[twilio] start; streamSid =", streamSid);
     startSilenceKeepalive(); // <-- keepalive begins here
     // flush any queued-to-Twilio frames
     if (streamSid && twilioWs.readyState === OPEN) {
       while (queueToTwilio.length) {
         const { base64Mu } = queueToTwilio.shift();
         try { twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Mu } })); } catch {}
       }
     }
     return;
   }

      if (msg.event === "media" && msg.media?.payload) {
        const pcm24 = twilioChunkToPcm24k(msg.media.payload);
        safeSendToOpenAI(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm24.toString("base64") }));
        return;
      }

      if (msg.event === "stop") {
        console.log("[twilio] stop event");
      }
    } catch (e) {
      console.error("Twilio WS parse error:", e?.message || e);
    }
  });

// OpenAI -> Twilio
openaiWs.on("message", (raw) => {
  try {
    const evt = JSON.parse(raw.toString());
    if (!evt?.type) return;
    // Log the first few event types to verify schema we're getting
    if (audioDeltaCount < 1 || evt.type !== "response.audio.delta") {
      console.log("[openai] evt:", evt.type);
    }

    // Current audio-delta event
    if (evt.type === "response.audio.delta" && evt.delta?.audio) {
      audioDeltaCount++;
      if (audioDeltaCount === 1) {
        console.log("[openai] first audio delta received");
        if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
      }
      const base64Mu = pcm24kToTwilioMuLawBase64(Buffer.from(evt.delta.audio, "base64"));
      console.log("[to-twilio] mu-law frame len=", base64Mu.length);  // add this
      if (streamSid) safeSendToTwilio(base64Mu);
      else queueToTwilio.push({ base64Mu });
    }

    if (evt.type === "response.completed") {
      console.log("[openai] response completed, deltas =", audioDeltaCount);
      audioDeltaCount = 0;
    }
  } catch (e) {
    console.error("OpenAI WS parse error:", e?.message || e);
  }
});

  // Ask OpenAI to speak periodically based on buffered audio
   const iv = setInterval(() => {
     if (openaiOpen && openaiWs.readyState === OPEN) {
       safeSendToOpenAI(JSON.stringify({ type: "input_audio_buffer.commit" }));
       safeSendToOpenAI(JSON.stringify({ type: "response.create", response: { modalities: ["audio"], audio: { voice: "alloy" } } }));
     }
   }, 800);

  // Close/error logs & cleanup
  twilioWs.on("close", (code, reason) => { console.log("[twilio] ws close:", code, reason?.toString()); });
  twilioWs.on("error", (err) => { console.log("[twilio] ws error:", err?.message || err); });
  openaiWs.on("close", (code, reason) => { console.log("[openai] ws close:", code, reason?.toString()); });
  openaiWs.on("error", (err) => { console.log("[openai] ws error:", err?.message || err); });

  const cleanup = () => {
    if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
    clearInterval(iv);
    try { openaiWs.close(); } catch {}
    try { twilioWs.close(); } catch {}
    console.log("[ws] cleaned up");
  };
 
  twilioWs.on("close", cleanup);
  twilioWs.on("error", cleanup);
  openaiWs.on("close", cleanup);
  openaiWs.on("error", cleanup);
});

/* ================================
   START
===================================*/
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
