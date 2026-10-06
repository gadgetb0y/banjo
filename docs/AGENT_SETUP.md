# Connecting an agent to Banjo

Banjo is built to be driven by an agent: you tell your agent "get me a haircut Thursday," and the
agent asks Banjo to make the call. This page covers connecting three of them: Claude Code, Hermes
Agent and OpenClaw. Any agent that speaks MCP over HTTP should work the same way.

There are three pieces, and an agent can use any of them:

1. **The MCP server** at `https://<PUBLIC_HOSTNAME>/mcp`: Banjo's 11 tools (`place_call`,
   `get_task_status`, `find_contact`, …), over Streamable HTTP, with `MCP_API_KEY` as a bearer
   token.
2. **The `schedule-appointment` skill** (`skills/schedule-appointment/`): teaches the agent when
   to book online and when to hand the job to Banjo.
3. **The task webhook** (`TASK_WEBHOOK_URL`): Banjo POSTs a signed event when a call finishes,
   so the agent hears back without polling.

## What's been tested

Tested on 2026-10-05, in Docker, against a Banjo instance with fake telephony credentials (so it
couldn't place a real call):

| | Claude Code | Hermes Agent v0.21.5 | OpenClaw 2026.9.8 |
|---|---|---|---|
| Connects to `/mcp` | Not yet (its live setup still uses `/mcp/sse`) | ✓ | ✓ |
| Read-only tool filter | n/a | ✓ | ✓ |
| Agent turn calls a Banjo tool | ✓ over `/mcp/sse` | ✓ | ✓ |
| Receives the task webhook | n/a | ✓ (HMAC signature) | ✓ (bearer token) |
| Loads the skill | ✓ | ✓ (mounted from a checkout) | ✓ (mounted from a checkout) |

Not tested yet: installing the skill straight from GitHub with the Hermes and OpenClaw commands
below, and either agent driving a real call end to end. If you try either, please open an issue
with what happened.

## Before you start

- **Start read-only.** Both Hermes and OpenClaw can limit which Banjo tools an agent sees. The
  examples below allow only the five read tools, so you can try the connection without the agent
  being able to place a call. Remove the filter when you're ready to let it dial.
- **The tools carry MCP annotations.** The read tools are marked `readOnlyHint`, and
  `place_call` and `stop_call` are marked `openWorldHint` (they act on a real phone call). Clients
  that honour these can skip approval for reads and still ask before a call. They're hints, not
  a security boundary: Banjo's own limits (the call cap per number, AI disclosure) apply whatever
  the client does.
- **Tool names get a prefix.** Hermes shows `place_call` as `mcp__banjo__place_call`, OpenClaw as
  `banjo__place_call`. The skill knows to expect this.
- Keep `MCP_API_KEY` out of config files where you can. Both agents below read it from an
  environment variable.

## Claude Code

```bash
claude mcp add --transport http banjo https://YOUR-HOSTNAME/mcp \
  --header "Authorization: Bearer $MCP_API_KEY"
ln -s "$(pwd)/skills/schedule-appointment" ~/.claude/skills/schedule-appointment
```

Older setups that use `--transport sse` and `/mcp/sse` keep working, but lose their session on
every Banjo restart and need `/mcp` to reconnect. `/mcp` doesn't.

## Hermes Agent

In `~/.hermes/config.yaml` (or `/opt/data/config.yaml` in the Docker image):

```yaml
mcp_servers:
  banjo:
    url: "https://YOUR-HOSTNAME/mcp"
    headers:
      Authorization: "Bearer ${BANJO_MCP_KEY}"
    tools:
      # Read-only to start. Remove this block to give the agent every tool.
      include: [find_contact, list_contacts, list_recent_tasks, get_task_status, get_call_transcript]
```

Set `BANJO_MCP_KEY` (your Banjo `MCP_API_KEY`) in Hermes's environment or its `.env`. Check the
connection with `hermes mcp test banjo`, which should report 11 tools discovered. The filter is
applied when the agent loads them.

Install the skill:

```bash
hermes skills install shatch/banjo/skills/schedule-appointment
```

**Model and credit.** Hermes's default model is Claude Opus, and it asks for up to 64,000 output
tokens per request. With OpenRouter, a key with a low credit limit fails every request with HTTP
402 ("You requested up to 64000 tokens, but can only afford …"). Either add credit, or pick a
cheaper model under `model:` in `config.yaml`, for example:

```yaml
model:
  default: "anthropic/claude-haiku-4.5"
  provider: "openrouter"
```

### Receiving the webhook in Hermes

Banjo signs its webhook the way Hermes checks generic webhooks, so no adapter is needed. Add a
route under `platforms` in `config.yaml`:

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      port: 8644
      routes:
        banjo:
          secret: "${BANJO_WEBHOOK_SECRET}"   # the same value as Banjo's TASK_WEBHOOK_SECRET
          prompt: |
            Banjo finished a phone task ({taskId}, status {status}): {text}
          deliver: "log"   # or telegram, discord, … to have the agent tell you
```

Then set Banjo's `TASK_WEBHOOK_URL` to `http(s)://<hermes-host>:8644/webhooks/banjo`. Put only
`{text}`, `{taskId}` and `{status}` in the prompt, never fields from `{outcome}`: see
[Untrusted fields](#untrusted-fields).

## OpenClaw

In `~/.openclaw/openclaw.json` (`/home/node/.openclaw/openclaw.json` in the Docker image):

```json
{
  "mcp": {
    "servers": {
      "banjo": {
        "url": "https://YOUR-HOSTNAME/mcp",
        "transport": "streamable-http",
        "headers": { "Authorization": "Bearer ${BANJO_MCP_KEY}" },
        "toolFilter": {
          "include": ["find_contact", "list_contacts", "list_recent_tasks", "get_task_status", "get_call_transcript"]
        }
      }
    }
  }
}
```

`openclaw mcp probe` should list `banjo: 5 tools`, or 11 without the filter.

Install the skill from a checkout of this repo:

```bash
openclaw skills install ./skills/schedule-appointment --global
```

### Receiving the webhook in OpenClaw

OpenClaw's hooks authenticate with a bearer token rather than a signature. Set Banjo's
`TASK_WEBHOOK_TOKEN` to the same value as `hooks.token`, and map the event to an agent turn:

```json
{
  "hooks": {
    "enabled": true,
    "token": "${BANJO_HOOK_TOKEN}",
    "path": "/hooks",
    "allowedAgentIds": ["main"],
    "mappings": [
      {
        "id": "banjo",
        "match": { "path": "banjo" },
        "action": "agent",
        "agentId": "main",
        "name": "Banjo",
        "messageTemplate": "Banjo finished a phone task ({{taskId}}, status {{status}}): {{text}}",
        "deliver": false
      }
    ]
  }
}
```

Then set Banjo's `TASK_WEBHOOK_URL` to `http(s)://<openclaw-host>:18789/hooks/banjo`. OpenClaw
wraps hook content as untrusted external content by default. Leave `allowUnsafeExternalContent`
off.

## The task webhook

Set these in Banjo's `.env`:

```bash
TASK_WEBHOOK_URL=https://agent.example.com/webhooks/banjo
TASK_WEBHOOK_SECRET=$(openssl rand -hex 32)   # at least 32 characters
TASK_WEBHOOK_TOKEN=                           # optional: also sent as a bearer token
```

When a call finishes, after it has hung up, Banjo POSTs:

```json
{
  "event": "task.finished",
  "taskId": "6f0c…",
  "status": "confirmed",
  "outcome": { "kind": "confirmed", "start": "2026-10-09T18:00:00.000Z", "durationMinutes": 30, "details": "…" },
  "contact": { "id": "1b2e…", "name": "Luigi's" },
  "text": "Banjo booked with Luigi's: Friday, October 9 at 2:00 PM (30 min). Call details are in outcome, …",
  "finishedAt": "2026-10-05T20:00:00.000Z"
}
```

with these headers:

| Header | Value |
|---|---|
| `X-Webhook-Timestamp` | Unix seconds, regenerated on each attempt |
| `X-Webhook-Signature-V2` | Hex HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with `TASK_WEBHOOK_SECRET` |
| `Authorization` | `Bearer <TASK_WEBHOOK_TOKEN>`, only if it's set |
| `Idempotency-Key` | `<taskId>:<status>`, so you can drop a repeat |

To verify it yourself (Node):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isFromBanjo(rawBody, headers, secret) {
  const ts = headers['x-webhook-timestamp'];
  const sig = Buffer.from(headers['x-webhook-signature-v2'] ?? '');
  const want = Buffer.from(createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex'));
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
  return fresh && sig.length === want.length && timingSafeEqual(sig, want);
}
```

Delivery is at most two attempts: Banjo retries once after 5 seconds on a network error or a
5xx, and doesn't retry a 4xx. A failed webhook never affects the call or the owner's
notification. Agent-initiated `cancel_task` and `record_task_outcome` don't send one, since the
agent already knows the result.

### Untrusted fields

`text` is written entirely by Banjo: the outcome, the time and the contact's name from your own
contacts. It's safe to put in an agent's prompt. The free-text fields in `outcome` (`details`,
`reason`, `summary`, a voicemail's `message`) are written by the voice model from what the other
person said on the call, so anyone who answers the phone can influence them. Show them to a
person, or pass them to an agent as clearly marked data, never as instructions.

### Plain http only to localhost or a Docker service name

`TASK_WEBHOOK_URL` must be `https`, because the body carries the call's outcome. There are two
exceptions:

- `localhost` / `127.0.0.1` / `[::1]`, for an agent on the same machine.
- A single-label hostname, such as a Docker Compose service name, for an agent in another
  container on the same Docker network.

Anything else needs `https`, for example through your reverse proxy or a tunnel. That includes
dotted hostnames and IP addresses other than loopback.

To run an agent next to Banjo in Docker, point the webhook at the agent's service name:

```yaml
services:
  banjo:
    image: ghcr.io/shatch/banjo:latest
    # … Banjo's usual settings, plus:
    environment:
      TASK_WEBHOOK_URL: http://hermes:8644/webhooks/banjo
  hermes:
    image: nousresearch/hermes-agent:latest
    command: gateway run
    volumes:
      - ./hermes-data:/opt/data
```

In this layout the agent's MCP URL is `http://banjo:3000/mcp`.

The event is signed but not encrypted, so anything else on that Docker network can read the call's
outcome. Keep the agent on a network that only it and Banjo share. Banjo logs a warning at startup
whenever the webhook uses plain `http` to anything but localhost. Encrypting this hop is tracked in
[#115](https://github.com/shatch/banjo/issues/115).
