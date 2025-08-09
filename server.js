// server.js
import express from "express";
import fetch from "node-fetch";
import { OpenAI } from "openai";
import { Firestore } from "@google-cloud/firestore";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { APIConnectionError } from "openai";


import https from "https";
import dns from "dns";
import FormData from "form-data";

dns.setDefaultResultOrder("ipv4first");



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

app.get("/health-firestore", async (req, res) => {
  try {
    const col = process.env.FIRESTORE_COLLECTION || "voicemails";
    const snap = await firestore.collection(col).orderBy("time", "desc").limit(1).get();
    res.json({ ok: true, collection: col, docsFound: snap.size, lastId: snap.docs[0]?.id || null });
  } catch (err) {
    console.error("Firestore health error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});


// --- ultra-stable /voice handlers (no deps) ---
function basicTwiml(greetingText) {
  const g = greetingText && greetingText.trim()
    ? greetingText
    : "Hi! You’ve reached Kyle's AI receptionist. Please leave a message after the tone.";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${g}</Say>
  <Record playBeep="true" maxLength="30" recordingStatusCallback="/voicemail-complete" />
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


const firestore = new Firestore({ ignoreUndefinedProperties: true });
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  timeout: 60000,
  maxRetries: 2
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

function cleanedDoc(obj) {
  const dropped = [];
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) { 
      dropped.push(k); 
      continue; 
    }
    out[k] = v;
  }
  if (dropped.length) {
    console.warn("[vm] dropped undefined fields:", dropped.join(", "));
  }
  return out;
}


async function transcribeFromUrl(mp3Url) {
  // 1) Download Twilio audio (protected) over basic auth
  const res = await fetch(mp3Url, { headers: { Authorization: twilioBasicAuth } });
  if (!res.ok) throw new Error(`Audio download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`[transcribe] downloaded ${buf.length} bytes from Twilio`);

  // Write to temp
  const tmp = path.join(os.tmpdir(), `vm-${crypto.randomUUID()}.mp3`);
  fs.writeFileSync(tmp, buf);

  // Reusable IPv4/no-keepalive agent to avoid flaky sockets
  const ipv4Agent = new https.Agent({ keepAlive: false, family: 4 });

  const MAX = 5;
  let attempt = 0;

  try {
    while (attempt < MAX) {
      attempt++;
      try {
        console.log(`[transcribe] SDK attempt ${attempt}/${MAX}`);
        // 2) First try: OpenAI SDK
        const tr = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmp),
          model: "whisper-1"
        });
        const text = tr.text || "";
        console.log(`[transcribe] SDK success (len=${text.length})`);
        return text;

      } catch (sdkErr) {
        const msg = sdkErr?.message || String(sdkErr);
        console.warn(`[transcribe] SDK error: ${msg}`);

        // 3) Fallback: raw multipart POST via node-fetch + form-data + IPv4 agent
        try {
          console.log(`[transcribe] Fallback attempt ${attempt}/${MAX}`);
          const form = new FormData();
          form.append("model", "whisper-1");
          form.append("file", fs.createReadStream(tmp), {
            filename: "audio.mp3",
            contentType: "audio/mpeg"
          });

          const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              ...form.getHeaders()
            },
            body: form,
            // Force IPv4 and disable keep-alive to dodge ECONNRESET on some hosts
            agent: ipv4Agent
          });

          if (!r.ok) {
            const body = await r.text().catch(() => "");
            throw new Error(`Fallback HTTP ${r.status}: ${body.slice(0, 200)}`);
          }
          const json = await r.json();
          const text = json?.text || "";
          console.log(`[transcribe] Fallback success (len=${text.length})`);
          return text;

        } catch (fallbackErr) {
          const fmsg = fallbackErr?.message || String(fallbackErr);
          const transient =
            fmsg.includes("ECONNRESET") ||
            fmsg.includes("ETIMEDOUT") ||
            fmsg.toLowerCase().includes("timeout") ||
            fmsg.includes("socket hang up");

          console.warn(`[transcribe] Fallback error: ${fmsg} (transient=${transient})`);
          if (!transient || attempt >= MAX) throw fallbackErr;

          const delay = 700 * Math.pow(2, attempt - 1); // 0.7s, 1.4s, 2.8s, 5.6s, 11.2s
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw new Error("transcribe: exhausted retries");
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
  <Record playBeep="true" maxLength="30" recordingStatusCallback="/voicemail-complete" />
  <Say>No recording received. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

// ---------- voice webhooks (immediate greet + record) ----------

// Twilio posts here after recording completes
app.post("/voicemail-complete", async (req, res) => {
  const { RecordingUrl, From, To, CallSid, Caller, Timestamp } = req.body;
  console.log(`[vm] callback: CallSid=${CallSid} From=${From} To=${To} RecordingUrl=${RecordingUrl}`);

  try {
    if (!RecordingUrl) {
      console.warn("[vm] no RecordingUrl in callback, ignoring");
      return res.sendStatus(200);
    }

    const mp3Url = `${RecordingUrl}.mp3`;
    const transcript = await transcribeFromUrl(mp3Url);
    console.log(`[vm] transcript length=${(transcript || "").length}`);

    // Only save when we have transcript text (your preference)
    if (!transcript || !transcript.trim()) {
      console.warn("[vm] empty transcript; not saving to Firestore");
      return res.sendStatus(200);
    }

    const col = process.env.FIRESTORE_COLLECTION || "voicemails";
    const id = crypto.randomUUID();

    const doc = {
      id,
      callerName: Caller || "Unknown",
      phone: From || "Unknown",
      time: Timestamp ? new Date(Timestamp) : new Date(),
      summary: summarize(transcript),
      transcript,
      isNew: true,
      recordingUrl: mp3Url,
      callSid: CallSid || null,
      to: To || null
    };

    console.log("[vm] writing doc to Firestore…");
    await firestore.collection(col).doc(id).set(cleanedDoc(doc));
    console.log(`[vm] saved: collection=${col} id=${id}`);
    res.sendStatus(200);

  } catch (e) {
    console.error("[vm] error (no write):", e?.message || e);
    // Return 200 so Twilio doesn't spam retries
    res.sendStatus(200);
  }
});



//------------- test firestore connection ---------------
app.get("/test-firestore", async (req, res) => {
  try {
    const docRef = firestore.collection(FIRESTORE_COLLECTION).doc();
    await docRef.set({
      callerName: "Test Caller",
      phone: "+15555555555",
      time: new Date(),
      summary: "This is a test voicemail entry.",
      transcript: "Hi, this is just a test to confirm Firestore is connected.",
      isNew: true
    });
    res.send(`Test voicemail saved with ID: ${docRef.id}`);
  } catch (err) {
    console.error("Firestore test error:", err);
    res.status(500).send("Error writing to Firestore");
  }
});

// ----------- test openai connection ---------------
app.get("/health-openai", async (req, res) => {
  try {
    // a tiny call that hits OpenAI but doesn't cost anything significant
    const list = await openai.models.list({ limit: 1 });
    res.json({ ok: true, modelsSeen: list.data?.length ?? 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
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
