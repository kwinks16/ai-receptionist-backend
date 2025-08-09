// server.js
import express from "express";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import { Firestore } from "@google-cloud/firestore";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const {
  PORT = 3000,
  PUBLIC_BASE_URL,                 // optional; we can derive from request
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  OPENAI_API_KEY,
  FIRESTORE_COLLECTION = "voicemails",
} = process.env;

// Required envs (PUBLIC_BASE_URL is optional on first deploy)
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !OPENAI_API_KEY) {
  console.error("Missing env: need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, OPENAI_API_KEY.");
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: true })); // Twilio webhooks send form-encoded
app.use(express.json());

// --- ultra-stable /voice handlers (no deps) ---
function basicTwiml(greetingText) {
  const g = greetingText && greetingText.trim()
    ? greetingText
    : "Hi! You’ve reached our AI receptionist. Please leave a message after the tone.";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${g}</Say>
  <Record playBeep="true" maxLength="60" recordingStatusCallback="/voicemail-complete" />
  <Say>No recording received. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

app.get("/voice", (req, res) => {
  res.type("text/xml").status(200).send(basicTwiml(req.query.greeting));
});

app.post("/voice", (req, res) => {
  res.type("text/xml").status(200).send(basicTwiml(req.query.greeting));
});


const firestore = new Firestore();
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  timeout: 60000 // 60s
});
const twilioBasicAuth =
  "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

// ---------- helpers ----------
function summarize(text = "") {
  const t = text.trim();
  if (!t) return "";
  const i = t.indexOf(".");
  return i >= 30 ? t.slice(0, i + 1) : t.slice(0, 140);
}

async function transcribeFromUrl(mp3Url) {
  // Download Twilio recording with basic auth
  const res = await fetch(mp3Url, { headers: { Authorization: twilioBasicAuth } });
  if (!res.ok) throw new Error(`Audio download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // Write to a temp file
  const tmp = path.join(os.tmpdir(), `vm-${crypto.randomUUID()}.mp3`);
  fs.writeFileSync(tmp, buf);

  const maxAttempts = 3;
  let attempt = 0, lastErr;

  try {
    while (attempt < maxAttempts) {
      attempt++;
      try {
        const tr = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmp),
          model: "whisper-1"
        });
        return tr.text || "";
      } catch (err) {
        lastErr = err;
        // ECONNRESET / timeouts → retry
        const msg = (err && err.message) ? err.message : String(err);
        const isTransient =
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("timeout") ||
          msg.includes("socket hang up") ||
          (err && err.code === "ECONNRESET");

        if (!isTransient || attempt >= maxAttempts) {
          throw err;
        }
        const delay = 500 * Math.pow(2, attempt - 1); // 500ms, 1000ms, 2000ms
        console.warn(`Whisper retry ${attempt}/${maxAttempts} in ${delay}ms… (${msg})`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastErr || new Error("Unknown transcription error");
  } finally {
    fs.unlink(tmp, () => {});
  }
}


// Build TwiML for both GET and POST /voice
function buildTwiml(req) {
  const greeting =
    (req.query && req.query.greeting) ||
    "Hi! You’ve reached our AI receptionist. Please leave a message after the tone.";

  // Derive base URL if PUBLIC_BASE_URL isn't set yet
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = req.headers.host;
  const baseUrl = PUBLIC_BASE_URL || `${proto}://${host}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${greeting}</Say>
  <Record playBeep="true" maxLength="120" recordingStatusCallback="${baseUrl}/voicemail-complete" />
  <Say>No recording received. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

// ---------- voice webhooks (immediate greet + record) ----------

// Twilio posts here after recording completes
app.post("/voicemail-complete", async (req, res) => {
  try {
    const { RecordingUrl, From, To, CallSid, Caller, Timestamp } = req.body;
    if (!RecordingUrl) return res.sendStatus(200);

    const mp3Url = `${RecordingUrl}.mp3`;
    const transcript = await transcribeFromUrl(mp3Url);

    const doc = {
      id: crypto.randomUUID(),
      callerName: Caller || "Unknown",
      phone: From || "Unknown",
      time: Timestamp ? new Date(Timestamp) : new Date(),
      summary: summarize(transcript),
      transcript,
      isNew: true,
      recordingUrl: mp3Url,
      callSid: CallSid,
      to: To,
    };

    await firestore.collection(FIRESTORE_COLLECTION).doc(doc.id).set(doc);
    res.sendStatus(200);
  } catch (e) {
    console.error("voicemail-complete error:", e);
    // Return 200 to avoid Twilio retry storms; we logged the error
    res.sendStatus(200);
  }
});

// ---------- simple health/data endpoints ----------
app.get("/api/voicemails", async (req, res) => {
  const snap = await firestore
    .collection(FIRESTORE_COLLECTION)
    .orderBy("time", "desc")
    .limit(50)
    .get();
  res.json(snap.docs.map((d) => d.data()));
});

app.get("/", (req, res) => res.send("AI Receptionist backend up."));

app.listen(PORT, () => console.log(`Server on :${PORT}`));
