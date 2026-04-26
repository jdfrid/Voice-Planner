import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createGoogleAuthUrl,
  getStatus,
  handleGoogleCallback,
  processPlannerCommand
} from './voicePlannerService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 3001;
const publicRoot = path.join(__dirname, '../public');
const maxBodyBytes = 25 * 1024 * 1024;

loadLocalEnv();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, getOrigin(req));

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'voice-planner', origin: getOrigin(req) });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, 200, getStatus());
    }

    if (req.method === 'GET' && url.pathname === '/api/google/auth-url') {
      const auth = requireOptionalAccessKey(req, url);
      if (auth) return sendJson(res, 401, { error: auth });
      try {
        return sendJson(res, 200, { url: createGoogleAuthUrl(getRedirectUri(req)) });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/google/callback') {
      try {
        await handleGoogleCallback({
          code: url.searchParams.get('code'),
          state: url.searchParams.get('state'),
          redirectUri: getRedirectUri(req)
        });
        return redirect(res, '/?google=connected');
      } catch (error) {
        return redirect(res, `/?google=error&message=${encodeURIComponent(error.message)}`);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/process') {
      const body = await readJsonBody(req);
      const auth = requireOptionalAccessKey(req, url, body);
      if (auth) return sendJson(res, 401, { error: auth });
      try {
        const result = await processPlannerCommand(body || {});
        return sendJson(res, 200, { success: true, ...result });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStaticOrIndex(req, res, url);
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Voice Planner listening on 0.0.0.0:${port}`);
});

function loadLocalEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function getOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}

function getRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${getOrigin(req)}/api/google/callback`;
}

function requireOptionalAccessKey(req, url, body = {}) {
  const configuredKey = (process.env.VOICE_PLANNER_ACCESS_KEY || '').trim();
  if (!configuredKey) return '';
  const supplied = req.headers['x-voice-planner-key'] || url.searchParams.get('key') || body.accessKey;
  return supplied === configuredKey ? '' : 'Voice Planner access key is required.';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON request body.'));
      }
    });
    req.on('error', reject);
  });
}

function serveStaticOrIndex(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(publicRoot, requested));
  const safePath = filePath.startsWith(publicRoot) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(publicRoot, 'index.html');
  const content = fs.readFileSync(safePath);
  res.writeHead(200, { 'Content-Type': getContentType(safePath) });
  if (req.method === 'HEAD') return res.end();
  return res.end(content);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}
