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
async function transferToVoicemail(callSid, baseUrl) {
  if (!callSid) throw new Error("No callSid to transfer");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${encodeURIComponent(callSid)}.json`;

  // Point the live call at /voicemail-twiml (TwiML redirect)
  const twimlUrl = `${baseUrl}/voicemail-twiml`;
  const body = new URLSearchParams({ Url: twimlUrl, Method: "POST" });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Twilio transfer failed ${resp.status}: ${txt}`);
  }
  console.log("[transfer] call redirected to", twimlUrl);
}

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

// Generate μ-law 8 kHz mono tone frames (~durationMs) at freqHz
function genToneMuLawBytes(durationMs = 1000, freqHz = 440, gain = 0.6) {
  const sampleRate = 8000;
  const totalSamples = Math.floor(sampleRate * (durationMs / 1000));
  const twoPiOverFs = 2 * Math.PI * freqHz / sampleRate;

  // make PCM16
  const pcm = new Int16Array(totalSamples);
  for (let n = 0; n < totalSamples; n++) {
    const v = Math.sin(twoPiOverFs * n) * gain;
    pcm[n] = Math.max(-1, Math.min(1, v)) * 32767;
  }
  // μ-law encode
  const mu = muLawEncode(pcm); // Uint8Array
  return Buffer.from(mu);      // raw μ-law bytes
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

// Twilio μ-law 8k (base64 payload) -> PCM16 24k (Buffer)
function twilioChunkToPcm24k(base64) {
  // Twilio sends media.payload as base64 μ-law bytes @ 8000 Hz
  const u8 = Buffer.from(base64, "base64");        // μ-law bytes
  const pcm8k = muLawDecode(u8);                   // Int16Array @ 8k
  const pcm24 = resampleLinear(Int16Array.from(pcm8k), 8000, 24000); // Int16Array @ 24k
  return Buffer.from(new Int16Array(pcm24).buffer); // Buffer (PCM16 @ 24k)
}

// PCM16 24k (Buffer) -> Twilio μ-law 8k (raw bytes Buffer)
function pcm24kToTwilioMuLawBytes(buf) {
  // buf: Buffer of PCM16 little-endian @ 24000 Hz, mono
  const int16_24k = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const int16_8k  = resampleLinear(int16_24k, 24000, 8000);   // Int16Array @ 8k
  const mu        = muLawEncode(Int16Array.from(int16_8k));   // Uint8Array μ-law
  return Buffer.from(mu);                                     // raw μ-law bytes
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
  console.log("[/voice-realtime] HIT", req.get("User-Agent"), "CallSid=", req.body?.CallSid);
  const wsUrl =
    (PUBLIC_WS_URL && PUBLIC_WS_URL.trim()) || `wss://${req.headers.host}/twilio-media`;

  const twiml = `
    <Response>
      <Connect>
        <Stream url="${wsUrl}">
          <Parameter name="callSid" value="${(req.body?.CallSid || "").toString()}"/>
          <Parameter name="audioTrack" value="inbound_track"/>
        </Stream>
      </Connect>
    </Response>`;
  res.type("text/xml").status(200).send(twiml);
});

app.post("/voice-realtime", (req, res) => {
  const wsUrl = (PUBLIC_WS_URL && PUBLIC_WS_URL.trim())
    ? PUBLIC_WS_URL.trim()
    : `wss://${req.headers.host}/twilio-media`;

  // Keep it minimal; don't give Twilio extra verbs to run after Stream ends.
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${wsUrl}">
          <Parameter name="callSid" value="${(req.body?.CallSid || "").toString()}"/>
          <Parameter name="audioTrack" value="inbound_track"/>
        </Stream>
      </Connect>
    </Response>`;
  res.type("text/xml").send(twiml);
});

// A dedicated voicemail TwiML that records and then hits /voicemail-complete
const VOICEMAIL_PROMPT =
  process.env.VOICEMAIL_PROMPT ||
  "Okay, please leave your message after the tone. Press any key when you're done.";

app.post("/voicemail-twiml", (req, res) => {
  const base = (PUBLIC_BASE_URL && PUBLIC_BASE_URL.trim()) || (`https://${req.headers.host}`);
  const actionUrl = `${base}/voicemail-complete`;
  const twiml = `
    <Response>
      <Say voice="Polly.Joanna">${VOICEMAIL_PROMPT}</Say>
      <Record action="${actionUrl}" method="POST" maxLength="120" finishOnKey="*" playBeep="true" />
      <Say>We didn't receive a recording. Goodbye.</Say>
    </Response>
  `;
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

  // per-connection state
  let streamSid = null;
  let callSid = null;
  let openaiOpen = false;

  // pacing back to Twilio
  let txQueue = [];     // Buffer(160) frames
  let txTimer = null;   // setInterval handle

  // μ-law silence keepalive (stops on first model audio)
  let silenceTimer = null;

  function startTxLoop() {
    if (txTimer) return;
    txTimer = setInterval(() => {
      if (!streamSid || twilioWs.readyState !== OPEN) return;
      if (txQueue.length === 0) { clearInterval(txTimer); txTimer = null; return; }
      const frame = txQueue.shift();
      const payload = frame.toString("base64");
      try {
        twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
      } catch {
        clearInterval(txTimer); txTimer = null;
      }
    }, 25); // ~20ms media + small cushion
  }

  function enqueueMuLawFrames(muBytes) {
    const buf = Buffer.isBuffer(muBytes) ? muBytes : Buffer.from(muBytes);
    for (let off = 0; off + 160 <= buf.length; off += 160) {
      txQueue.push(buf.subarray(off, off + 160));
    }
    if (txQueue.length > 0) startTxLoop();
  }

  function startSilenceKeepalive() {
    if (silenceTimer) return;
    let ticks = 0;
    console.log("[keepalive] starting silence loop");
    silenceTimer = setInterval(() => {
      if (!streamSid || twilioWs.readyState !== OPEN) return;
      const payload = Buffer.alloc(160, 0xFF).toString("base64"); // μ-law silence
      try { twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload } })); } catch {}
      if (++ticks % 5 === 0) console.log("[keepalive] sent silence tick=", ticks);
      if (ticks > 30) { clearInterval(silenceTimer); silenceTimer = null; console.log("[keepalive] stopped (timeout)"); }
    }, 350);
  }

  // Optional: read callSid from query (fallback)
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    callSid = u.searchParams.get("callSid") || null;
  } catch {}

  // OpenAI Realtime
  const openaiWs = new RealtimeWS(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview",
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  const queueToOpenAI = [];
  const safeSendToOpenAI = (msg) => {
    if (openaiOpen && openaiWs.readyState === OPEN) {
      try { openaiWs.send(msg); } catch {}
    } else {
      queueToOpenAI.push(msg);
    }
  };

  openaiWs.on("open", () => {
    console.log("[openai] websocket open");
    openaiOpen = true;

    // Configure audio I/O
    safeSendToOpenAI(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["audio","text"],
        input_audio_format:  "pcm16", // simple form accepted
        output_audio_format: "pcm16"
      }
    }));

    // Assistant greeting from model (not Twilio)
    safeSendToOpenAI(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio","text"],
        instructions: "Hi, I'm Kyle's AI assistant. I can answer questions, schedule appointments, or take a voicemail. What can I help you with?"
      }
    }));

    // flush any queued messages
    while (queueToOpenAI.length) { try { openaiWs.send(queueToOpenAI.shift()); } catch {} }
  });

  // Twilio -> OpenAI
  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || msg.streamSid || null;
      callSid   = msg.start?.callSid || msg.start?.customParameters?.callSid || callSid || null;
      console.log("[twilio] start; streamSid=", streamSid, "callSid=", callSid || "(none)");
      startSilenceKeepalive();
      if (txQueue.length > 0) startTxLoop();
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      // 8k μ-law → 24k PCM → append
      const pcm24 = twilioChunkToPcm24k(msg.media.payload);
      safeSendToOpenAI(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm24.toString("base64") }));

      // commit/respond after short pause in speech (debounced)
      if (twilioWs._commitTimer) clearTimeout(twilioWs._commitTimer);
      twilioWs._commitTimer = setTimeout(() => {
        safeSendToOpenAI(JSON.stringify({ type: "input_audio_buffer.commit" }));
        safeSendToOpenAI(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"] } }));
      }, 400);
      return;
    }

    if (msg.event === "stop") {
      console.log("[twilio] stop event");
      return;
    }
  });

  // OpenAI -> Twilio
  openaiWs.on("message", async (raw) => {
    let evt; try { evt = JSON.parse(raw.toString()); } catch { return; }
    if (!evt?.type) return;

    // Detect voicemail intent (optional; keep if you want that feature)
    if (evt.type === "conversation.item.created" && evt.item?.role === "user") {
      let userText = "";
      for (const part of (evt.item.content || [])) {
        if (typeof part?.transcript === "string") userText += " " + part.transcript;
        if (typeof part?.text === "string")       userText += " " + part.text;
        if (part?.type === "input_text" && typeof part?.text === "string") userText += " " + part.text;
      }
      userText = userText.toLowerCase();
      const wantsVoicemail =
        /\bvoicemail\b/.test(userText) ||
        /leave (a )?message/.test(userText) ||
        /can i (just )?leave/.test(userText);
      if (wantsVoicemail && callSid) {
        const base = (PUBLIC_BASE_URL && PUBLIC_BASE_URL.trim()) || (`https://${req.headers.host}`);
        try {
          await transferToVoicemail(callSid, base);
          try { openaiWs.close(); } catch {}
        } catch (e) {
          console.error("[intent] transfer failed:", e?.message || e);
        }
        return;
      }
    }

    // Stream model audio to Twilio (24k PCM → 8k μ-law, paced)
    if (evt.type === "response.audio.delta") {
      let b64 = null;
      if (typeof evt.delta === "string") b64 = evt.delta;
      else if (evt.delta && typeof evt.delta.audio === "string") b64 = evt.delta.audio;
      else if (evt.delta && typeof evt.delta.data  === "string") b64 = evt.delta.data;
      else if (typeof evt.audio === "string") b64 = evt.audio;
      if (!b64) return;

      // first audio? stop keepalive
      if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }

      const pcm24 = Buffer.from(b64, "base64");
      const mu    = pcm24kToTwilioMuLawBytes(pcm24);
      enqueueMuLawFrames(mu);
      return;
    }
  });

  // cleanup
  const cleanup = () => {
    if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
    if (txTimer) { clearInterval(txTimer); txTimer = null; }
    try { openaiWs.close(); } catch {}
    try { twilioWs.close(); } catch {}
    txQueue = [];
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
