---
name: agent-comms
description: Sends and receives messages with peer agents on the local network. Use when messaging a peer, checking peer availability, coordinating shared work, or reviewing agent-comms logs.
argument-hint: [send <peer> "<message>" | status | log]
---

# Agent-to-Agent Communication

Send and receive messages with peer agents on the local network.

> **Scope**: This skill covers A2A peer-to-peer messaging (LAN direct + P2P SDK). For A2A network features (groups, discovery, relay), see the `a2a-network` skill. For channel-based messaging to humans (Telegram, email), see your channel skill.

## Commands

Parse the arguments to determine action:

### Send
- `send <peer> "<message>"` - Send a text message to a peer
- `send <peer> "<message>" status` - Send a status update
- `send <peer> "<message>" coordination` - Send a coordination message
- `send <peer> "<message>" pr-review` - Send a PR review request

### Status
- `status` - Show agent-comms status (peers, queue, connectivity)

### Log
- `log` - Show recent agent-comms log entries
- `log <n>` - Show last n log entries

### Examples
- `/agent-comms send peer-agent "Hey, are you free to review a PR?"`
- `/agent-comms send peer-agent "Claiming the auth refactor" coordination`
- `/agent-comms send peer-agent "idle" status`
- `/agent-comms status`
- `/agent-comms log 10`

## Implementation

### Sending
Send via the daemon's `/agent/send` endpoint (2-tier routing: LAN direct → P2P SDK fallback).

**IMPORTANT:** Always use python3 to generate JSON for curl to avoid shell quoting issues. Raw `--data-raw` with shell-interpolated strings causes "Bad escaped character" JSON parse errors.

```bash
python3 -c "
import json, subprocess, sys
data = json.dumps({'peer': '<name>', 'type': 'text', 'text': '<message>'})
r = subprocess.run(['curl', '-s', '-X', 'POST', 'http://localhost:3847/agent/send',
  '-H', 'Content-Type: application/json', '-d', data], capture_output=True, text=True)
print(r.stdout)
"
```

**Request fields:**
| Field | Required | Description |
|-------|----------|-------------|
| `peer` | yes | Target peer name (e.g. `peer-agent`) |
| `type` | yes | `text`, `status`, `coordination`, or `pr-review` |
| `text` | no | Message body |
| `status` | no | For status messages (e.g. `idle`, `busy`) |
| `action` | no | For coordination (e.g. `claim`, `release`) |
| `task` | no | Task description |
| `context` | no | Additional context |
| `callbackUrl` | no | Callback endpoint for async replies |
| `repo` | no | For PR reviews |
| `branch` | no | For PR reviews |
| `pr` | no | PR number string |

**Success response (HTTP 200):**
```json
{"ok": true, "queued": false, "error": null}
```

**Failure response (HTTP 502):**
```json
{"ok": false, "queued": false, "error": "Failed to reach peer peer-agent (peer-host.local:3847): ..."}
```

If LAN delivery fails and the P2P SDK is active, the message is sent via P2P and `queued` is `true`.

### Receiving (Inbound)
Peers send to your `POST /agent/message` endpoint (handled by the daemon automatically). Inbound messages require Bearer auth and must include `messageId` and `timestamp`:

```json
{
  "from": "peer-agent",
  "type": "text",
  "text": "Hey, PR is ready for review",
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-02-27T15:30:00.000Z"
}
```

**Response:** `{"ok": true, "queued": false}`

The daemon validates the Bearer token, formats the message, and injects it into the comms tmux session.

### Checking Status
```bash
# Local daemon status
curl -s http://localhost:3847/status

# Peer status (direct)
curl -s http://<peer-host>:<peer-port>/agent/status
```

### Reading Logs
```bash
tail -20 logs/agent-comms.log
```

## Configuration

Peers are configured in `kithkit.config.yaml` under `agent-comms.peers`. Each peer needs a name, host, port, and optional fallback IP.

```yaml
agent-comms:
  enabled: true
  secret: "credential-agent-comms-secret"  # Keychain credential name
  peers:
    - name: "peer-agent"
      host: "peer-host.local"
      port: 3847
      ip: "192.168.1.100"  # Fallback IP for LAN retry
```

The `secret` value is the name of a macOS Keychain credential (or equivalent secret store) that holds the shared HMAC secret. Both your daemon and the peer's daemon must have the same secret configured.

## Architecture

### LAN (Direct)
- **Inbound**: Daemon receives on `POST /agent/message`, validates auth (Bearer token from Keychain), injects directly into tmux session with `[Network] Name:` prefix
- **Outbound**: Daemon sends via `curl` subprocess (not Node.js `http.request`, which has macOS LAN networking issues with some configurations)
- **Auth**: Shared secret stored in macOS Keychain (`credential-agent-comms-secret`)

### P2P SDK (Internet — Primary)
- **Transport**: HTTPS directly to peer's public endpoint (E2E encrypted)
- **Encryption**: X25519 ECDH key exchange + AES-256-GCM, Ed25519 signed envelopes
- **Sending**: If LAN fails and Kithkit A2A Network SDK is active, sends directly to peer via P2P SDK
- **Receiving**: SDK event handler routes incoming messages to session
- **Identity**: Agent Ed25519 keypair in Keychain (`credential-kithkit-agent-key`), public key in relay directory
- **Key point**: Messages go directly between agents — the relay is never in the message path

### Legacy Relay (Deprecated Fallback)
- **Transport**: HTTPS via Kithkit Relay (configured in `kithkit.config.yaml` under `network.relay_url`) — store-and-forward
- **Auth**: Ed25519 per-request signatures (X-Agent + X-Signature headers)
- **Sending**: Only used if both LAN and P2P SDK fail
- **Note**: Being deprecated in favor of P2P SDK. Messages through legacy relay are signed but not E2E encrypted

### Logging
- All messages logged as JSONL to `logs/agent-comms.log`
- Directions: `in` (LAN inbound), `out` (LAN outbound), `relay-in`, `relay-out`

### Group Messaging
For A2A group messaging (broadcast to multiple peers), use the `a2a-network` skill — specifically `POST /api/network/groups/:id/message`. This skill (`agent-comms`) handles only 1:1 peer messaging.

## Usage Protocol

This protocol governs how and when agents use agent-to-agent comms.

### When to Use Agent Comms
- **Coordination**: Claiming/releasing tasks, proposing approaches, agreeing on who does what
- **Status**: Quick presence pings and availability changes
- **PR notifications**: Ready for review, merged, needs changes
- **Direct questions**: Quick technical questions between agents
- **Handoffs**: Context handoff on shared work (when one agent hits context limits)

### When NOT to Use Agent Comms
- Anything needing human attention (use your channel router — Telegram, email, etc.)
- Long-form specs or proposals (use email)
- Anything requiring a paper trail for the humans (use email)

### Message Types
| Type | Use For |
|------|---------|
| `text` | General messages, questions, updates, FYIs |
| `status` | Availability changes: idle, busy, restarting |
| `coordination` | Claim/release tasks, propose approaches, agree on work split |
| `pr-review` | PR review requests (include repo, branch, PR number) |

### Etiquette
- Keep messages concise — both agents are context-limited
- Batch related updates when possible
- Trust delivery when the other agent is busy — tmux buffers input natively
- Acknowledge receipt on important coordination messages
- One topic per message when practical
- Respond to coordination claims promptly

## Troubleshooting

### Messages not delivering
1. Check peer is online: `curl -s http://<host>:<port>/agent/status`
2. Check daemon is running: `curl -s http://localhost:3847/health`
3. Check logs: `tail logs/agent-comms.log`

### Auth failures
- Verify shared secret matches: `security find-generic-password -s credential-agent-comms-secret -w`
- Both agents must have the same secret in their Keychain
