#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

// ─── Config ──────────────────────────────────────────────────────────
const CREDENTIALS_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.claude',
  '.credentials.json'
);
const API_URL = 'https://api.anthropic.com/v1/messages';
const REFRESH_INTERVAL = 120_000; // 2 minutes

// ─── Args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const watchMode = args.includes('--watch');
const rawMode = args.includes('--raw');
const helpMode = args.includes('--help') || args.includes('-h');

if (helpMode) {
  console.log(`
claude-rate-monitor - Real-time Claude API rate limit usage

Usage:
  claude-rate-monitor              Show current usage
  claude-rate-monitor --json       Output as JSON
  claude-rate-monitor --watch      Refresh every 2 minutes
  claude-rate-monitor --raw        Show raw header values
  claude-rate-monitor --help       Show this help

Requires Claude CLI to be installed and authenticated.
Token is read from CLAUDE_CODE_AUTH_TOKEN env var (if set),
or from ~/.claude/.credentials.json as fallback.
`);
  process.exit(0);
}

// ─── Token ───────────────────────────────────────────────────────────
function getToken() {
  if (process.env.CLAUDE_CODE_AUTH_TOKEN) {
    return process.env.CLAUDE_CODE_AUTH_TOKEN;
  }

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('Error: Claude CLI credentials not found.');
    console.error('');
    console.error('Either set the CLAUDE_CODE_AUTH_TOKEN environment variable,');
    console.error('or ensure credentials exist at ' + CREDENTIALS_PATH);
    console.error('');
    console.error('Make sure Claude CLI is installed and you have logged in:');
    console.error('  npm install -g @anthropic-ai/claude-code');
    console.error('  claude');
    process.exit(1);
  }

  try {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token) {
      console.error('Error: No OAuth access token found in credentials file.');
      console.error('Try re-authenticating: claude');
      process.exit(1);
    }
    return token;
  } catch (e) {
    console.error('Error reading credentials:', e.message);
    process.exit(1);
  }
}

// ─── API Call ────────────────────────────────────────────────────────
function fetchUsage(token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const url = new URL(API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 401) {
          reject(new Error('OAuth token expired. Re-authenticate with: claude'));
          return;
        }

        const headers = {};
        const prefix = 'anthropic-ratelimit-';
        for (const [key, value] of Object.entries(res.headers)) {
          if (key.startsWith(prefix)) {
            headers[key] = value;
          }
        }

        resolve({
          statusCode: res.statusCode,
          headers,
          session: {
            utilization: parseFloat(headers['anthropic-ratelimit-unified-5h-utilization'] || '0'),
            reset: headers['anthropic-ratelimit-unified-5h-reset'] || null,
            status: headers['anthropic-ratelimit-unified-5h-status'] || 'unknown',
          },
          weekly: {
            utilization: parseFloat(headers['anthropic-ratelimit-unified-7d-utilization'] || '0'),
            reset: headers['anthropic-ratelimit-unified-7d-reset'] || null,
            status: headers['anthropic-ratelimit-unified-7d-status'] || 'unknown',
          },
          overallStatus: headers['anthropic-ratelimit-unified-status'] || 'unknown',
          overageStatus: headers['anthropic-ratelimit-unified-overage-status'] || null,
        });
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Display ─────────────────────────────────────────────────────────
function progressBar(ratio, width = 20) {
  const filled = Math.round(Math.min(ratio, 1) * width);
  const empty = width - filled;
  const pct = (ratio * 100).toFixed(1);

  let color;
  if (ratio >= 0.8) color = '\x1b[31m';      // red
  else if (ratio >= 0.5) color = '\x1b[33m';  // yellow
  else color = '\x1b[32m';                     // green

  const reset = '\x1b[0m';
  const bar = color + '█'.repeat(filled) + reset + '░'.repeat(empty);
  return `${bar}  ${pct}%`;
}

function formatReset(resetValue) {
  if (!resetValue) return 'unknown';
  try {
    // Reset values are Unix epoch seconds
    const epoch = typeof resetValue === 'string' ? parseInt(resetValue, 10) : resetValue;
    if (isNaN(epoch) || epoch === 0) return 'unknown';
    const d = new Date(epoch * 1000);
    const now = new Date();
    const diffMs = d - now;

    if (diffMs < 0) return 'just reset';

    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMin / 60);
    const remainMin = diffMin % 60;

    const timeStr = d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });

    if (diffHr > 0) {
      return `${timeStr} (${diffHr}h ${remainMin}m)`;
    }
    return `${timeStr} (${diffMin}m)`;
  } catch {
    return isoString;
  }
}

function display(data) {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (rawMode) {
    console.log('\nRaw rate limit headers:');
    console.log('─'.repeat(60));
    for (const [key, value] of Object.entries(data.headers)) {
      console.log(`  ${key}: ${value}`);
    }
    console.log('');
    return;
  }

  const clear = watchMode ? '\x1b[2J\x1b[H' : '';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';

  let statusColor = '\x1b[32m'; // green
  if (data.overallStatus === 'rate_limited') statusColor = '\x1b[31m';
  else if (data.overallStatus === 'warning') statusColor = '\x1b[33m';

  console.log(`${clear}
${bold}Claude API Rate Limits${reset}
${'━'.repeat(41)}

${bold}Session (5h window)${reset}
${progressBar(data.session.utilization)}
Resets: ${dim}${formatReset(data.session.reset)}${reset}

${bold}Weekly (7d window)${reset}
${progressBar(data.weekly.utilization)}
Resets: ${dim}${formatReset(data.weekly.reset)}${reset}

Status: ${statusColor}${data.overallStatus}${reset}${data.overageStatus ? `  |  Overage: ${data.overageStatus}` : ''}
`);

  if (watchMode) {
    console.log(`${dim}Refreshing every 2 minutes. Ctrl+C to exit.${reset}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────
async function run() {
  const token = getToken();

  try {
    const data = await fetchUsage(token);
    display(data);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }

  if (watchMode) {
    setInterval(async () => {
      try {
        const data = await fetchUsage(token);
        display(data);
      } catch (e) {
        console.error('Error refreshing:', e.message);
      }
    }, REFRESH_INTERVAL);
  }
}

run();
