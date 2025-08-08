import express from "express";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import { Firestore } from "@google-cloud/firestore";
import crypto from "crypto";

const {
  PORT = 3000,
  PUBLIC_BASE_URL,                 // e.g. https://your-service.onrender.com
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  OPENAI_API_KEY,
  USER_FORWARD_NUMBER,            // your real phone number (+15551234567)
  FIRESTORE_COLLECTION = "voicemails",
} = process.env;

if (!PUBLIC_BASE_URL || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !OPENAI_API_KEY || !USER_FORWARD_NUMBER) {
  console.error("Missing required env vars. Check README.");
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: true })); // Twilio webhooks
app.use(express.json());

const firestore = new Firestore();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const twilioBasicAuth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

function summarize(text = "") {
  const t = text.trim();
  if (!t) return "";
  const i = t.indexOf(".");
  return i >= 30 ? t.slice(0, i + 1) : t.slice(0, 140);
}

async function transcribeFromUrl(mp3Url) {
  // Twilio recordings are protected; fetch with basic auth
  const res = await fetch(mp3Url, { headers: { Authorization: twilioBasicAuth } });
  if (!res.ok) throw new Error(`Audio download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // Send to Whisper
  const file = new File([buf], "audio.mp3", { type: "audio/mpeg" });
  const tr = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1"
  });
  return tr.text || "";
}

// Incoming call: try your real number first; if missed, record voicemail then callback
app.post("/voice", (req, res) => {
  const greeting = req.query.greeting || "Please leave a message after the tone.";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="20">${USER_FORWARD_NUMBER}</Dial>
  <Say>${greeting}</Say>
  <Record playBeep="true" maxLength="120" recordingStatusCallback="${PUBLIC_BASE_URL}/voicemail-complete" />
  <Say>No recording received. Goodbye.</Say>
  <Hangup/>
</Response>`;
  res.type("text/xml").send(twiml);
});

// Voicemail finished: transcribe + store
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
      to: To
    };

    await firestore.collection(FIRESTORE_COLLECTION).doc(doc.id).set(doc);
    res.sendStatus(200);
  } catch (e) {
    console.error("voicemail-complete error:", e);
    // Return 200 to avoid Twilio retry storms; error is logged
    res.sendStatus(200);
  }
});

// App fetch endpoint
app.get("/api/voicemails", async (req, res) => {
  const snap = await firestore.collection(FIRESTORE_COLLECTION).orderBy("time", "desc").limit(50).get();
  res.json(snap.docs.map(d => d.data()));
});

app.get("/", (req, res) => res.send("AI Receptionist backend up."));
app.listen(PORT, () => console.log(`Server on :${PORT}`));
