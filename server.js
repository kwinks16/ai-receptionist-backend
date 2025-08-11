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
import { encode as muLawEncode, decode as muLawDecode } from "mulaw";
import Resampler from "pcm-resampler";

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

// Proxy media between Twilio and OpenAI Realtime
wss.on("connection", async (twilioWs) => {
  const RealtimeWS = (await import("ws")).default;
  const modelUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview";
  const openaiWs = new RealtimeWS(modelUrl, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
  });

  // Configure session (ask for audio I/O)
  openaiWs.on("open", () => {
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        input_audio_format: { type: "pcm16", sample_rate_hz: 24000, channels: 1 },
        output_audio_format: { type: "pcm16", sample_rate_hz: 24000, channels: 1 },
        instructions:
          "You are a live AI receptionist. Be concise, friendly, and professional. If business knowledge is provided later, use only that. If unsure, ask a brief follow-up or offer to take a message. Do not browse the web."
      }
    }));
  });

  // Resamplers
  const up = new Resampler({ inputSampleRate: 8000, outputSampleRate: 24000, channels: 1 });
  const down = new Resampler({ inputSampleRate: 24000, outputSampleRate: 8000, channels: 1 });

  function twilioChunkToPcm24k(base64) {
    const u8 = Buffer.from(base64, "base64");
    const pcm8k = muLawDecode(u8); // Int16Array
    const pcm24 = up.resample(Int16Array.from(pcm8k));
    return Buffer.from(new Int16Array(pcm24).buffer);
  }
  function pcm24kToTwilioMuLawBase64(buf) {
    const int16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
    const pcm8k = down.resample(int16);
    const mu = muLawEncode(Int16Array.from(pcm8k));
    return Buffer.from(mu).toString("base64");
  }

  // Twilio → OpenAI (caller speech)
  twilioWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "media" && msg.media?.payload) {
        const pcm24 = twilioChunkToPcm24k(msg.media.payload);
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcm24.toString("base64")
        }));
      } else if (msg.event === "start") {
        // new call started
      }
    } catch {}
  });

  // Periodically commit audio for response
  const iv = setInterval(() => {
    if (openaiWs.readyState === openaiWs.OPEN) {
      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      openaiWs.send(JSON.stringify({ type: "response.create" }));
    }
  }, 1200);

  // OpenAI → Twilio (assistant speech)
  openaiWs.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());
      if (evt.type === "response.output_audio.delta" && evt.delta?.audio) {
        const base64Mu = pcm24kToTwilioMuLawBase64(Buffer.from(evt.delta.audio, "base64"));
        twilioWs.send(JSON.stringify({ event: "media", media: { payload: base64Mu } }));
      }
    } catch {}
  });

  const cleanup = () => { clearInterval(iv); try { openaiWs.close(); } catch {} try { twilioWs.close(); } catch {} };
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
