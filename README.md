# claude-rate-monitor

**See your real-time Claude API rate limit usage — the same data Claude CLI sees internally.**

```bash
npx claude-rate-monitor
```

```
Claude API Rate Limits
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Session (5h window)
████████░░░░░░░░░░░░  32.4%
Resets at 2:59 PM EST

Weekly (7d window)
████████████████░░░░  40.1%
Resets Jan 31 at 8:00 AM EST

Status: active
```

## The Discovery

Anthropic's API returns real-time rate limit utilization data in HTTP response headers — but **only when you use the OAuth beta header**. This is the same mechanism Claude CLI (`/usage` command) uses internally to display your session and weekly usage percentages.

These headers are **not in Anthropic's public documentation**. We found them by reverse-engineering the Claude CLI binary.

## The Headers

When you include `anthropic-beta: oauth-2025-04-20` in your API request (with a valid OAuth token), the response includes:

| Header | Description |
|--------|-------------|
| `anthropic-ratelimit-unified-5h-utilization` | Session usage (0.0 - 1.0+) over a rolling 5-hour window |
| `anthropic-ratelimit-unified-5h-reset` | Unix epoch timestamp (seconds) when the 5h window resets |
| `anthropic-ratelimit-unified-5h-status` | `active`, `warning`, or `rate_limited` |
| `anthropic-ratelimit-unified-7d-utilization` | Weekly usage (0.0 - 1.0+) over a rolling 7-day window |
| `anthropic-ratelimit-unified-7d-reset` | Unix epoch timestamp (seconds) when the 7d window resets |
| `anthropic-ratelimit-unified-7d-status` | `active`, `warning`, or `rate_limited` |
| `anthropic-ratelimit-unified-status` | Overall status across all windows |
| `anthropic-ratelimit-unified-overage-status` | Whether you've exceeded your plan limits |
| `anthropic-ratelimit-unified-representative-claim` | Which window is the binding constraint (`five_hour` or `seven_day`) |
| `anthropic-ratelimit-unified-fallback-percentage` | Fallback rate when rate-limited (e.g., `0.5` = 50% throughput) |
| `anthropic-ratelimit-unified-reset` | Overall reset time (epoch seconds) |
| `anthropic-ratelimit-unified-overage-disabled-reason` | Why overage is disabled (if applicable) |

> **Important:** OAuth tokens are restricted to certain models. Use `claude-haiku-4-5-20251001` for the probe — it's the cheapest and works reliably. Sonnet and Opus models may return `400 invalid_request_error`.

## Quick Start

### Option 1: npx (no install)

```bash
npx claude-rate-monitor
```

On first run, it will find your Claude CLI OAuth token automatically (from `~/.claude/.credentials.json`).

### Option 2: curl

```bash
# Get your OAuth token
TOKEN=$(cat ~/.claude/.credentials.json | jq -r '.claudeAiOauth.accessToken')

# Make a minimal API call and inspect headers
curl -s -D - https://api.anthropic.com/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 1,
    "messages": [{"role": "user", "content": "hi"}]
  }' 2>&1 | grep -i "anthropic-ratelimit"
```

### Option 3: Install globally

```bash
npm install -g claude-rate-monitor
claude-rate-monitor
```

### Options

```bash
claude-rate-monitor              # Show current usage
claude-rate-monitor --json       # Output as JSON
claude-rate-monitor --watch      # Refresh every 2 minutes
claude-rate-monitor --raw        # Show raw header values
```

## How It Works

1. Reads your Claude CLI OAuth token from `~/.claude/.credentials.json`
2. Makes a **minimal API call** (1 max token, trivial prompt) — costs ~$0.001
3. Reads the rate limit headers from the response
4. Displays your utilization in a human-readable format

The API call is necessary because the rate limit data only comes back as HTTP response headers — there's no dedicated "check usage" endpoint.

## Requirements

- **Claude CLI** must be installed and authenticated (`claude` command)
- **Node.js** 18+
- Your OAuth token must be valid (re-run `claude` if expired)

## Integrating Into Your Own App

The core logic is simple — make any API call with the right headers and read the response headers:

```javascript
const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${oauthToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',  // This is the key!
  },
  body: JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  }),
});

const sessionUsage = response.headers.get('anthropic-ratelimit-unified-5h-utilization');
const weeklyUsage = response.headers.get('anthropic-ratelimit-unified-7d-utilization');
const sessionReset = response.headers.get('anthropic-ratelimit-unified-5h-reset');
const weeklyReset = response.headers.get('anthropic-ratelimit-unified-7d-reset');

console.log(`Session: ${(sessionUsage * 100).toFixed(1)}%`);
console.log(`Weekly: ${(weeklyUsage * 100).toFixed(1)}%`);
```

```python
import json, requests
from pathlib import Path

creds = json.loads(Path.home().joinpath('.claude/.credentials.json').read_text())
token = creds['claudeAiOauth']['accessToken']

r = requests.post('https://api.anthropic.com/v1/messages',
    headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
    },
    json={
        'model': 'claude-haiku-4-5-20251001',
        'max_tokens': 1,
        'messages': [{'role': 'user', 'content': 'hi'}],
    }
)

print(f"Session: {float(r.headers.get('anthropic-ratelimit-unified-5h-utilization', 0)) * 100:.1f}%")
print(f"Weekly: {float(r.headers.get('anthropic-ratelimit-unified-7d-utilization', 0)) * 100:.1f}%")
```

```bash
# One-liner bash
curl -s -D /dev/stderr https://api.anthropic.com/v1/messages \
  -H "Authorization: Bearer $(jq -r '.claudeAiOauth.accessToken' ~/.claude/.credentials.json)" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
  >/dev/null 2>&1 | grep ratelimit
```

## Cost

Each check costs approximately **$0.001** (one-tenth of a cent). The probe uses the smallest possible request: 1 max token with a 2-character prompt.

## Credits

Built by [Sanden Solutions](https://sandensolutions.com). Discovered by reverse-engineering the Claude CLI binary to understand how `/usage` works internally.

## License

MIT
