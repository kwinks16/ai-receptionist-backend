import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import fetch from "node-fetch";
import admin from "firebase-admin";
import fs from "fs";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Firestore init
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(fs.readFileSync("service-account.json", "utf8"))
    ),
  });
}
const db = admin.firestore();

// --- Immediate greet handler ---
app.post("/voice", (req, res) => {
  const greeting =
    process.env.GREETING ||
    "Hi! You’ve reached our AI receptionist. Please leave a message after the tone.";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${greeting}</Say>
  <Record playBeep="true" maxLength="120" recordingStatusCallback="${
    process.env.PUBLIC_BASE_URL
  }/voicemail-complete" />
  <Say>No recording received. Goodbye.</Say>
  <Hangup/>
</Response>`;
  res.type("text/xml").send(twiml);
});

// --- Handle completed voicemail ---
app.post("/voicemail-complete", async (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  const caller = req.body.Caller || "Unknown";

  try {
    // Fetch audio
    const audioRes = await fetch(`${recordingUrl}.wav`);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // Transcribe with Whisper
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer]), "audio.wav");
    formData.append("model", "whisper-1");

    const transcriptRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData,
    });
    const transcriptData = await transcriptRes.json();
    const transcriptText = transcriptData.text || "";

    // Summarize with GPT
    const summaryPrompt = `Summarize this voicemail in one sentence:\n${transcriptText}`;
    const summaryRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: summaryPrompt }],
      }),
    });
    const summaryData = await summaryRes.json();
    const summaryText =
      summaryData.choices?.[0]?.message?.content || "No summary available.";

    // Store in Firestore
    await db.collection("voicemails").add({
      callerName: caller,
      phone: caller,
      time: new Date(),
      summary: summaryText,
      transcript: transcriptText,
      isNew: true,
    });
  } catch (err) {
    console.error("Error handling voicemail:", err);
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("AI Receptionist backend is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
