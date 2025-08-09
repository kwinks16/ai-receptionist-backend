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

const firestore = new Firestore();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
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
  // Download Twilio recording with basic auth (recordings are protected)
  const res = await fetch(mp3Url, { headers: { Authorization: twilioBasicAuth } });
  if (!res.ok) throw new Error(`Audio download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // Write to temp, then stream to OpenAI Whisper
  const tmp = path.join(os.tmpdir(), `vm-${crypto.randomUUID()}.mp3`);
  fs.writeFileSync(tmp, buf);
  try {
    const tr = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmp),
      model: "whisper-1",
    });
    return tr.text || "";
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
app.get("/voice", (req, res) => {
  res.type("text/xml").send(buildTwiml(req));
});

app.post("/voice", (req, res) => {
  res.type("text/xml").send(buildTwiml(req));
});

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
