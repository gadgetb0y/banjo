# Spike: can Banjo drop the public hostname requirement?

**Date:** 2026-09-21 · **Status:** answered, no code written · **Outcome:** no — keep Twilio Media
Streams, bundle a named Cloudflare tunnel.

The single worst step in Banjo's setup is "get a publicly reachable hostname for your laptop". It's
the one prerequisite that isn't just an API key, it breaks every time a free ngrok URL rotates, and
it's the reason the Quickstart has a three-row options table. This spike asked whether the
architecture can be inverted — a worker that dials *out* to a broker, the way a LiveKit agent does,
needing no inbound hostname at all.

Everything below is from vendor documentation. **Nothing here was prototyped**; where that matters,
it's flagged.

## What we're actually up against

`PUBLIC_HOSTNAME` is one bare hostname used in five places:

| Where | What breaks without it |
| --- | --- |
| `src/server.ts` signature validation | Reconstructs `https://$PUBLIC_HOSTNAME$path$query` and HMACs it against Twilio's signature. A mismatch 403s **every** webhook. |
| `twilio.ts` answer webhook URL | Twilio has nowhere to fetch TwiML from. |
| `twilio.ts` async AMD callback | Answering-machine detection result never arrives. |
| `twilio.ts` outbound `wss://` stream URL | No audio. The call connects and sits silent. |
| `twilio.ts` inbound `wss://` stream URL | Same, for the inbound line. |

Two constraints follow, and they killed most of the options:

1. **Config is parsed once at import.** Any dynamically-assigned hostname must exist *before* the
   process starts. A sidecar that prints a URL after the app boots is useless.
2. **The signature check makes the hostname load-bearing twice over** — it's not just where Twilio
   reaches us, it's part of a cryptographic comparison. A tunnel that rewrites `Host` silently
   breaks authentication rather than connectivity, which is a much worse failure to debug.

## Options

### 1. Twilio Media Streams — the status quo

Twilio connects **to** us. Twilio's docs are explicit that you must allow secure WebSocket
connections on TCP 443 *from Twilio* to your server from any public IP. There is no configuration
that inverts this.

### 2. Twilio ConversationRelay

Twilio's newer voice-AI product. Checked because it's adjacent and recent. Same direction —
Twilio initiates the WebSocket to your server — so it doesn't help. It would also swallow the STT
and TTS layers, which is the opposite of what `VoiceAIProvider` exists to keep swappable.

**Rejected.** Doesn't solve the problem, and costs the vendor-agnostic seam.

### 3. Twilio SIP Registration — the one that genuinely inverts it

This is the real find. Twilio Programmable Voice SIP Domains support **SIP Registration**: an
endpoint with no fixed, publicly-reachable IP sends a `REGISTER` to Twilio, Twilio stores the
binding, and the endpoint can then make and receive calls. Twilio's own documentation frames this
as the normal case — "most SIP endpoints do not have a permanent, fixed, publicly-reachable IP
address". Outbound PSTN calling from a registered endpoint is called out as the most common use case.

So the *signaling* problem is solved, for free, inside the vendor Banjo already uses.

**But it replaces the media path.** Media Streams gives us µ-law frames in a JSON envelope over one
WebSocket, plus `clear` for barge-in and `<Parameter>` to smuggle our `callId` past Twilio's
query-string stripping. SIP gives us RTP. That means:

- Rewriting `twilio.ts` around a SIP stack and an RTP path — the majority of the file, and the part
  with the most live-call scar tissue in its comments.
- Owning jitter buffering, packet loss and interruption handling ourselves. Media Streams' `clear`
  message currently does barge-in flushing for us; there's no drop-in RTP equivalent.
- **NAT traversal moves from signaling to media.** Registration fixes SIP reaching us. It does not
  by itself fix RTP reaching us. In practice that means ICE/STUN/TURN, which is a tunnel by another
  name — with worse failure modes and no `curl` to debug it with. **This is the part that most needs
  a prototype before anyone trusts this paragraph.**

**Rejected for now**, but this is the option to revisit if the tunnel ever becomes intolerable. It's
the only one that removes the requirement without adding a hosted dependency.

### 4. LiveKit agent worker — the model the spike was named after

LiveKit's worker is a long-running process holding an **outbound** WebSocket to LiveKit, receiving
jobs as room events. That is exactly the inversion we wanted, and for the *application* it works:
Banjo would need no inbound hostname.

The catch is where the telephony lands. LiveKit's SIP service still has to expose a public IP for
SIP peers — LiveKit's docs say so directly. On LiveKit Cloud, LiveKit runs that for you. Self-hosted,
you're back to needing a public address, only now for a component that's harder to tunnel than an
HTTPS endpoint.

So this doesn't eliminate the requirement. It **relocates it into a hosted service**, and for a
project whose pitch is "you can actually run this yourself", trading "run a tunnel" for "depend on
LiveKit Cloud" is a downgrade, not an upgrade.

Costs, if it were pursued anyway: LiveKit Cloud agent-session minutes at ~$0.01/min and SIP minutes
at ~$0.003–0.004/min, **on top of** existing voice-AI and telephony spend — a meaningful increase on
a ~$0.11–0.17/min baseline.

Worth recording: a LiveKit adapter was scaffolded in this repo once and deleted as unmaintained dead
code. Nothing found here contradicts that call. Re-adding it would mean maintaining a second
telephony integration *and* a hosted dependency, to remove a setup step.

**Rejected.**

### 5. TwiML Bins for the webhook

Twilio-hosted static TwiML removes the *HTTP webhook* hostname but not the `wss://` stream URL,
which is the part that actually carries the call. Partial at best, and it would push per-call
routing into template variables.

**Rejected** — solves the easy half.

### 6. Named Cloudflare tunnel as a compose sidecar — recommended

Doesn't eliminate the hostname; eliminates the *hassle*, which is what actually hurts.

A **named** tunnel (not a quick tunnel) has a stable hostname on a domain you control, which is what
makes it compatible with constraint 1 — the hostname is known before the app starts, so it can just
live in `.env` like any other value. It's free, it handles WebSocket upgrades, and it terminates TLS
with a certificate Twilio will accept.

What this gets us: `docker compose up` becomes the whole story after a one-time tunnel setup, instead
of a terminal you must keep open and a URL you must re-paste whenever it rotates.

What it doesn't get us: someone without a domain in Cloudflare still needs ngrok, and the README
still needs a setup step. Be honest about that rather than claiming zero-config.

**Prototype needed before shipping:** confirm the tunnel forwards WebSocket upgrades on both
`/telephony/twilio/stream` and `/telephony/twilio/inbound-stream`, and — the one most likely to
bite — confirm Twilio's signature still validates through it, since the check compares against
`PUBLIC_HOSTNAME` rather than the request's own `Host`.

## Recommendation

Ship option 6. Keep option 3 (Twilio SIP registration) written down as the only real escape hatch,
to revisit if the tunnel step keeps costing users.

Do not pursue option 4. The spike's framing — "LiveKit-style outbound registration" — turned out to
describe a real and appealing pattern that, for a self-hostable project, solves the problem by making
it someone else's hosted infrastructure.

**Follow-up:** add the `cloudflared` sidecar, behind a compose profile so it's opt-in, and rewrite
the README's tunnel table around it.

## Sources

- [Twilio Media Streams overview](https://www.twilio.com/docs/voice/media-streams)
- [TwiML Voice: `<Stream>`](https://www.twilio.com/docs/voice/twiml/stream)
- [Twilio ConversationRelay](https://www.twilio.com/docs/voice/conversationrelay)
- [Twilio SIP Registration](https://www.twilio.com/docs/voice/api/sip-registration)
- [Register a SIP phone directly to Twilio](https://www.twilio.com/en-us/blog/registering-sip-phone-twilio-inbound-outbound)
- [LiveKit agents telephony integration](https://docs.livekit.io/agents/v1/start/telephony)
- [LiveKit firewall configuration](https://docs.livekit.io/home/cloud/firewall/)
- [LiveKit pricing](https://livekit.com/pricing)
