import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks'
];

const DEFAULT_TIMEZONE = process.env.VOICE_PLANNER_TIMEZONE || 'Asia/Jerusalem';
const dataRoot = getDataRoot();
const TOKEN_FILE = path.join(dataRoot, 'google-token.json');
const STATE_FILE = path.join(dataRoot, 'oauth-state.txt');

function getDataRoot() {
  const candidates = [
    process.env.DATA_DIR,
    path.join(process.cwd(), 'data'),
    '/tmp/voice-planner'
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (error) {
      console.warn(`DATA_DIR is not writable (${dir}): ${error.message}`);
    }
  }

  throw new Error('No writable data directory is available.');
}

function getGoogleClientConfig() {
  return {
    clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim()
  };
}

function assertGoogleConfigured() {
  const config = getGoogleClientConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error('Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }
  return config;
}

export function getStatus() {
  const google = getGoogleClientConfig();
  const token = readToken();
  return {
    googleConfigured: Boolean(google.clientId && google.clientSecret),
    googleConnected: Boolean(token?.refresh_token || token?.access_token),
    openaiConfigured: Boolean((process.env.OPENAI_API_KEY || '').trim()),
    timezone: DEFAULT_TIMEZONE,
    accessKeyRequired: Boolean((process.env.VOICE_PLANNER_ACCESS_KEY || '').trim())
  };
}

export function createGoogleAuthUrl(redirectUri) {
  const { clientId } = assertGoogleConfigured();
  const state = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(STATE_FILE, state, 'utf8');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function handleGoogleCallback({ code, state, redirectUri }) {
  assertGoogleConfigured();
  const expectedState = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : '';
  if (!state || state !== expectedState) {
    throw new Error('Invalid Google OAuth state.');
  }

  const token = await exchangeGoogleCode(code, redirectUri);
  saveToken(token);
}

export async function processPlannerCommand({ audioBase64, mimeType, text, timezone = DEFAULT_TIMEZONE }) {
  const transcript = (text || '').trim() || await transcribeAudio({ audioBase64, mimeType });
  const parsed = await parsePlannerText(transcript, timezone);
  const command = normalizeParsedCommand(parsed, transcript, timezone);

  if (command.type === 'calendar') {
    const googleResult = await createCalendarEvent(command, transcript, timezone);
    return { transcript, parsed: command, googleResult };
  }

  if (command.type === 'task') {
    const googleResult = await createTask(command, transcript);
    return { transcript, parsed: command, googleResult };
  }

  throw new Error('Start the recording with "משימה" or "זימון".');
}

async function exchangeGoogleCode(code, redirectUri) {
  const { clientId, clientSecret } = assertGoogleConfigured();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'Failed to exchange Google OAuth code.');
  }
  return addExpiry(data);
}

async function getGoogleAccessToken() {
  const token = readToken();
  if (!token) throw new Error('Google is not connected yet.');
  if (token.access_token && token.expiry_date && token.expiry_date > Date.now() + 60_000) {
    return token.access_token;
  }
  if (!token.refresh_token) throw new Error('Google token expired. Reconnect Google.');

  const { clientId, clientSecret } = assertGoogleConfigured();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'Failed to refresh Google token.');
  }

  const refreshed = { ...token, ...addExpiry(data), refresh_token: token.refresh_token };
  saveToken(refreshed);
  return refreshed.access_token;
}

function readToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveToken(token) {
  const existing = readToken() || {};
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...existing, ...addExpiry(token) }, null, 2));
}

function addExpiry(token) {
  if (!token?.expires_in) return token;
  return { ...token, expiry_date: Date.now() + Number(token.expires_in) * 1000 };
}

async function transcribeAudio({ audioBase64, mimeType = 'audio/webm' }) {
  const openaiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!openaiKey) throw new Error('OPENAI_API_KEY is not configured.');
  if (!audioBase64) throw new Error('No audio was received.');

  const cleanBase64 = String(audioBase64).includes(',')
    ? String(audioBase64).split(',').pop()
    : String(audioBase64);
  const audioBuffer = Buffer.from(cleanBase64, 'base64');
  const extension = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('mpeg') ? 'mp3' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), `voice-command.${extension}`);
  form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1');
  form.append('language', 'he');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || 'Audio transcription failed.');
  }
  return (data.text || '').trim();
}

async function parsePlannerText(transcript, timezone) {
  const fallback = fallbackParse(transcript);
  const openaiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!openaiKey) return fallback;

  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENAI_PARSE_MODEL || 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Parse Hebrew voice commands into JSON only. The first word decides routing: "משימה" means task, "זימון" or "זימן" means calendar. Resolve relative dates using the supplied timezone and today. Return keys: type, title, date, startTime, endTime, dueDate, dueTime, location, notes. Dates must be YYYY-MM-DD, times HH:mm, unknown values null.'
        },
        {
          role: 'user',
          content: JSON.stringify({ today, timezone, transcript })
        }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) return fallback;
  try {
    return JSON.parse(data.choices?.[0]?.message?.content || '{}');
  } catch {
    return fallback;
  }
}

function normalizeParsedCommand(parsed, transcript, timezone) {
  const firstWord = transcript.trim().split(/\s+/)[0] || '';
  const type = parsed.type || (firstWord === 'משימה' ? 'task' : ['זימון', 'זימן'].includes(firstWord) ? 'calendar' : null);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  const title = cleanTitle(parsed.title || transcript.replace(/^(משימה|זימון|זימן)\s*/u, '').trim() || 'ללא כותרת');

  if (type === 'calendar') {
    const date = parsed.date || today;
    const startTime = normalizeTime(parsed.startTime || parsed.time || '09:00');
    const endTime = normalizeTime(parsed.endTime) || addMinutes(date, startTime, 60).time;
    return {
      type,
      title,
      date,
      startTime,
      endTime,
      location: parsed.location || '',
      notes: parsed.notes || ''
    };
  }

  if (type === 'task') {
    return {
      type,
      title,
      dueDate: parsed.dueDate || parsed.date || today,
      dueTime: normalizeTime(parsed.dueTime || parsed.time || parsed.startTime || ''),
      location: parsed.location || '',
      notes: parsed.notes || ''
    };
  }

  return { type: null, title };
}

function fallbackParse(transcript) {
  const firstWord = transcript.trim().split(/\s+/)[0] || '';
  return {
    type: firstWord === 'משימה' ? 'task' : ['זימון', 'זימן'].includes(firstWord) ? 'calendar' : null,
    title: transcript.replace(/^(משימה|זימון|זימן)\s*/u, '').trim()
  };
}

function cleanTitle(title) {
  return String(title || '').replace(/^(משימה|זימון|זימן)\s*/u, '').trim() || 'ללא כותרת';
}

function normalizeTime(value) {
  if (!value) return '';
  const match = String(value).match(/^(\d{1,2}):?(\d{2})?$/);
  if (!match) return '';
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2] || '00')));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function addMinutes(date, time, minutes) {
  const d = new Date(`${date}T${time}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return {
    date: d.toISOString().slice(0, 10),
    time: d.toISOString().slice(11, 16)
  };
}

async function createCalendarEvent(command, transcript, timezone) {
  const accessToken = await getGoogleAccessToken();
  const end = addMinutes(command.date, command.endTime, 0);
  const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      summary: command.title,
      location: command.location || undefined,
      description: [command.notes, `תמלול: ${transcript}`].filter(Boolean).join('\n\n'),
      start: { dateTime: `${command.date}T${command.startTime}:00`, timeZone: timezone },
      end: { dateTime: `${end.date}T${end.time}:00`, timeZone: timezone }
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || 'Failed to create Google Calendar event.');
  }
  return { id: data.id, htmlLink: data.htmlLink };
}

async function createTask(command, transcript) {
  const accessToken = await getGoogleAccessToken();
  const notes = [
    command.notes,
    command.dueTime ? `שעה: ${command.dueTime}` : '',
    command.location ? `מיקום: ${command.location}` : '',
    `תמלול: ${transcript}`
  ].filter(Boolean).join('\n');

  const response = await fetch('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: command.title,
      notes,
      due: command.dueDate ? `${command.dueDate}T00:00:00.000Z` : undefined
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || 'Failed to create Google Task.');
  }
  return { id: data.id, selfLink: data.selfLink };
}
