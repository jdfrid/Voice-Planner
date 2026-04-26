import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createGoogleAuthUrl,
  getStatus,
  handleGoogleCallback,
  processPlannerCommand
} from './voicePlannerService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3001;

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '../public')));

function getOrigin(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

function getRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${getOrigin(req)}/api/google/callback`;
}

function requireOptionalAccessKey(req, res, next) {
  const configuredKey = (process.env.VOICE_PLANNER_ACCESS_KEY || '').trim();
  if (!configuredKey) return next();
  const supplied = req.get('x-voice-planner-key') || req.query.key || req.body?.accessKey;
  if (supplied === configuredKey) return next();
  return res.status(401).json({ error: 'Voice Planner access key is required.' });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'voice-planner', origin: getOrigin(req) });
});

app.get('/api/status', (req, res) => {
  res.json(getStatus());
});

app.get('/api/google/auth-url', requireOptionalAccessKey, (req, res) => {
  try {
    res.json({ url: createGoogleAuthUrl(getRedirectUri(req)) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/google/callback', async (req, res) => {
  try {
    await handleGoogleCallback({
      code: req.query.code,
      state: req.query.state,
      redirectUri: getRedirectUri(req)
    });
    res.redirect('/?google=connected');
  } catch (error) {
    res.redirect(`/?google=error&message=${encodeURIComponent(error.message)}`);
  }
});

app.post('/api/process', requireOptionalAccessKey, async (req, res) => {
  try {
    const result = await processPlannerCommand(req.body || {});
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Voice Planner listening on 0.0.0.0:${port}`);
});
