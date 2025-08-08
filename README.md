# AI Receptionist Backend

Receives calls from Twilio, forwards to your real number, records missed calls, transcribes with Whisper, stores in Firestore, and exposes `/api/voicemails` for your app.

## Deploy (Render)
1. Create a new Web Service from this repo. Render will read `render.yaml`.
2. Add **Secret File** named `service-account.json` with your Google service account JSON.
3. Set env vars:
   - TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
   - OPENAI_API_KEY
   - USER_FORWARD_NUMBER (e.g., +15551234567)
4. Deploy → copy the public URL → set `PUBLIC_BASE_URL` to that URL → redeploy.

## Twilio
In Phone Numbers → your number → Voice:
- "A CALL COMES IN" → Webhook (HTTP POST) → `https://YOUR_RENDER_URL/voice?greeting=Hi! You’ve reached <Business>. Please leave a message.`

## App
Hit `GET https://YOUR_RENDER_URL/api/voicemails` to retrieve recent voicemails (JSON).
