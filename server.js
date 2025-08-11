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

const {
  PORT = 3000,
  PUBLIC_BASE_URL,
  PUBLIC_WS_URL,
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

const app = express();
app.use(express.urlencoded({ extended: true })); // Twilio webhooks: form-encoded
app.use(express.json());

const firestore = new Firestore();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: 60000 });

// ---------- helpers ----------

// ---- Simple linear resampler: Int16Array mono PCM
function resampleLinear(int16In, inRate, outRate) {
  if (inRate === outRate) return Int16Array.from(int16In);
  const lenIn = int16In.length;
  const lenOut = Math.round(lenIn * (outRate / inRate));
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

// ---- µ-law encode/decode (inline, no deps) ----
// Based on ITU G.711 μ-law
function muLawDecode(u8) {
  // u8: Uint8Array of μ-law bytes
  const len = u8.length;
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    let u = ~u8[i] & 0xff;
    let sign = (u & 0x80) ? -1 : 1;
    let exponent = (u >> 4) & 0x07;
    let mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent; // 0x84 = 132
    out[i] = sign * sample;
  }
  return out;
}

function muLawEncode(pcm16) {
  // pcm16: Int16Array linear PCM
  const len = pcm16.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let s = pcm16[i];
    let sign = 0;
    let x = s;
    if (x < 0) { sign = 0x80; x = -x; }
    if (x > 32635) x = 32635;
    x = x + 132; // bias
    let exponent = 7;
    for (let expMask = 0x4000; (x & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;
    let mantissa = (x >> (exponent + 3)) & 0x0f;
    let u = ~(sign | (exponent << 4) | mantissa) & 0xff;
    out[i] = u;
  }
  return out;
}

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
  // Download with Twilio Basic auth, save temp file
  const { path: tmpPath, size } = await downloadToTmp(recordingUrl, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log(`[transcribe] downloaded ${size} bytes from Twilio`);

  // Try SDK first, then a direct fetch if needed
  let lastErr;
  for (let i = 1; i <= 5; i++) {
    try {
      console.log(`[transcribe] SDK attempt ${i}/5`);
      const file = fs.createReadStream(tmpPath);
      const r = await openai.audio.transcriptions.create({
        file,
        model: "whisper-1" // use Whisper
      });
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

function nowIso() {
  return new Date().toISOString();
}

// -------------------------------------------------------------
// HEALTH
// -------------------------------------------------------------
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true, t: nowIso() }));

// -------------------------------------------------------------
// VOICE: Plain voicemail flow (what you already had)
//   Twilio → /voice → plays greeting, records → /voicemail-complete
// -------------------------------------------------------------
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
  // Twilio sends: RecordingUrl, From, To, CallSid, Timestamp, etc.
  try {
    const recordingUrl = (req.body?.RecordingUrl || "").toString();
    const from = (req.body?.From || "").toString();
    const to = (req.body?.To || "").toString();
    const callSid = (req.body?.CallSid || "").toString();

    console.log(`[vm] callback: CallSid=${callSid} From=${from || "undefined"} To=${to || "undefined"} RecordingUrl=${recordingUrl}`);

    if (!recordingUrl) { res.type("text/xml").send("<Response/>"); return; }

    const transcript = await transcribeFromUrl(`${recordingUrl}.mp3`);
    console.log(`[vm] transcript length=${transcript.length}`);

    // lightweight summary
    const summary = summarize(transcript);

    // only write if we have transcript
    if (transcript && transcript.length > 0) {
      const doc = {
        id: callSid || crypto.randomUUID(),
        phone: from || "Unknown",
        callerName: "Unknown",
        time: Date.now() / 1000, // epoch seconds for safe decoding on iOS
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
    res.type("text/xml").send("<Response/>"); // always 200 to Twilio
  }
});

// -------------------------------------------------------------
// Q&A endpoint (grounded in Business FAQ only; used by app)
// -------------------------------------------------------------
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

// -------------------------------------------------------------
// INBOX: simple read API for the iOS app
// -------------------------------------------------------------
app.get("/api/voicemails", async (_req, res) => {
  try {
    const snap = await firestore.collection(FIRESTORE_COLLECTION)
      .orderBy("time", "desc").limit(50).get();
    res.json(snap.docs.map(d => d.data()));
  } catch (e) {
    res.status(500).json({ error: "fetch failed" });
  }
});

// -------------------------------------------------------------
// REALTIME AI: Twilio <Stream> ↔ OpenAI Realtime proxy
// -------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/twilio-media")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// TwiML to start the bidirectional media stream
app.post("/voice-realtime", (req, res) => {
  const wsUrl = (PUBLIC_WS_URL && PUBLIC_WS_URL.trim())
    ? PUBLIC_WS_URL.trim()
    : `wss://${req.headers.host}/twilio-media`;
  const twiml = `
    <Response>
      <Say voice="Polly.Joanna">Connecting you. One moment please.</Say>
      <Connect>
        <Stream url="${wsUrl}" />
      </Connect>
    </Response>`;
  res.type("text/xml").send(twiml);
});

// Proxy media between Twilio and OpenAI Realtime (with buffering/guards)
wss.on("connection", async (twilioWs) => {
  const RealtimeWS = (await import("ws")).default;

  const OPEN = 1;
  const modelUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview";
  const openaiWs = new RealtimeWS(modelUrl, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
  });

  let streamSid = null;
  let openaiOpen = false;
  let twilioOpen = true; // this callback fires when Twilio has connected us

  // Queues to hold audio until both sockets are ready
  const queueToOpenAI = [];   // Buffer<PCM24k base64 strings>
  const queueToTwilio = [];   // {base64Mu, streamSid} objects

  function safeSendToOpenAI(msg) {
    if (openaiOpen && openaiWs.readyState === OPEN) {
      try { openaiWs.send(msg); } catch (e) { /* swallow */ }
    } else {
      queueToOpenAI.push(msg);
    }
  }

  function safeSendToTwilio(base64Mu) {
    if (twilioOpen && twilioWs.readyState === OPEN && streamSid) {
      try {
        twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Mu } }));
      } catch (e) { /* swallow */ }
    } else {
      queueToTwilio.push({ base64Mu });
    }
  }

  // --- audio format helpers (Twilio mu-law 8k <-> PCM16 24k) ---
  function twilioChunkToPcm24k(base64) {
    const u8 = Buffer.from(base64, "base64");
    const pcm8k = muLawDecode(u8); // Int16Array @ 8 kHz
    const pcm24 = resampleLinear(Int16Array.from(pcm8k), 8000, 24000); // -> 24 kHz
    return Buffer.from(new Int16Array(pcm24).buffer);
  }

  function pcm24kToTwilioMuLawBase64(buf) {
    const int16_24k = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
    const int16_8k  = resampleLinear(int16_24k, 24000, 8000); // -> 8 kHz
    const mu        = muLawEncode(Int16Array.from(int16_8k)); // Uint8Array μ-law
    return Buffer.from(mu).toString("base64");
  }

  // ---------------- OpenAI session setup ----------------
  openaiWs.on("open", () => {
    openaiOpen = true;

    // Configure formats + prompt
    safeSendToOpenAI(JSON.stringify({
      type: "session.update",
      session: {
        input_audio_format:  { type: "pcm16", sample_rate_hz: 24000, channels: 1 },
        output_audio_format: { type: "pcm16", sample_rate_hz: 24000, channels: 1 },
        instructions:
          "You are a live AI receptionist. Be concise, friendly, and professional. " +
          "Only use provided business knowledge if/when given. If unsure, ask a brief follow-up or take a message. " +
          "Do not browse the web."
      }
    }));

    // Flush any audio that arrived before OpenAI socket was open
    while (queueToOpenAI.length) {
      const msg = queueToOpenAI.shift();
      try { openaiWs.send(msg); } catch {}
    }
  });

  // ---------------- Twilio -> OpenAI ----------------
  twilioWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        // capture streamSid so we can send audio back into the same call
        streamSid = msg.start?.streamSid || msg.streamSid || null;

        // If we buffered audio for Twilio (unlikely this early), flush now that we have streamSid
        if (streamSid && twilioWs.readyState === OPEN) {
          while (queueToTwilio.length) {
            const { base64Mu } = queueToTwilio.shift();
            try {
              twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Mu } }));
            } catch {}
          }
        }
        return;
      }

      if (msg.event === "media" && msg.media?.payload) {
        const pcm24 = twilioChunkToPcm24k(msg.media.payload);
        const append = JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcm24.toString("base64")
        });
        safeSendToOpenAI(append);
        return;
      }

      // optional: handle dtmf/stop/etc.
    } catch (e) {
      console.error("Twilio WS parse error:", e?.message || e);
    }
  });

  twilioWs.on("open", () => {
    twilioOpen = true;
    // Flush any audio that was generated by OpenAI before Twilio fully opened
    if (streamSid) {
      while (queueToTwilio.length) {
        const { base64Mu } = queueToTwilio.shift();
        try {
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Mu } }));
        } catch {}
      }
    }
  });

  // Periodically ask OpenAI to process what’s buffered and speak
  const iv = setInterval(() => {
    if (openaiOpen && openaiWs.readyState === OPEN) {
      safeSendToOpenAI(JSON.stringify({ type: "input_audio_buffer.commit" }));
      safeSendToOpenAI(JSON.stringify({ type: "response.create" }));
    }
  }, 1100); // can tune (700–1200ms)

  // ---------------- OpenAI -> Twilio ----------------
  openaiWs.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      // We only care about audio deltas for now
      if (evt.type === "response.output_audio.delta" && evt.delta?.audio) {
        const base64Mu = pcm24kToTwilioMuLawBase64(Buffer.from(evt.delta.audio, "base64"));
        if (streamSid) {
          safeSendToTwilio(base64Mu);
        } else {
          // hold until we get 'start' from Twilio that gives streamSid
          queueToTwilio.push({ base64Mu });
        }
      }
    } catch (e) {
      console.error("OpenAI WS parse error:", e?.message || e);
    }
  });

  // ---------------- Cleanup ----------------
  const cleanup = () => {
    clearInterval(iv);
    try { openaiWs.close(); } catch {}
    try { twilioWs.close(); } catch {}
  };
  twilioWs.on("close", cleanup);
  twilioWs.on("error", cleanup);
  openaiWs.on("close", cleanup);
  openaiWs.on("error", cleanup);
});

// -------------------------------------------------------------
// START
// -------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
