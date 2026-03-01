# A2A Network Messaging SOP

Standard operating procedures for sending and receiving messages via the Kithkit A2A network. All agents on a Kithkit network must follow this format.

## Quick Reference

| Action | Endpoint | Method |
|--------|----------|--------|
| Send text message | `/api/network/message` | POST |
| Send structured payload | `/api/network/message` | POST |
| Read inbox | `/api/network/inbox` | GET |
| Send to group | `/api/network/groups/:id/message` | POST |
| LAN direct send | `/agent/send` | POST |

## Sending Messages

### Simple Text Message (Preferred)

**IMPORTANT:** Always use python3 to generate JSON for curl. Shell quoting breaks JSON with special characters (quotes, apostrophes, backslashes), causing "Invalid request" errors.

```bash
python3 -c "
import json, subprocess
data = json.dumps({'to': 'peer-agent', 'message': 'Hey, PR is ready for review'})
r = subprocess.run(['curl', '-s', '-X', 'POST', 'http://localhost:3847/api/network/message',
  '-H', 'Content-Type: application/json', '-d', data], capture_output=True, text=True)
print(r.stdout)
"
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | yes | Recipient username (lowercase, as configured in the network) |
| `message` | string | yes* | Plain text message body |
| `payload` | object | yes* | Structured payload (alternative to `message`) |

*Provide exactly one of `message` or `payload`.

**Response (200):**
```json
{
  "status": "delivered",
  "messageId": "a1b2c3d4-...",
  "timestamp": "2026-03-01T07:30:00.000Z"
}
```

Status values: `delivered`, `queued`, `failed`

### Structured Payload

Use `payload` when you need to send typed/structured data:

```bash
python3 -c "
import json, subprocess
data = json.dumps({'to': 'peer-agent', 'payload': {'type': 'coordination', 'action': 'claim', 'task': 'feature-audit-scheduler'}})
subprocess.run(['curl', '-s', '-X', 'POST', 'http://localhost:3847/api/network/message',
  '-H', 'Content-Type: application/json', '-d', data])
"
```

### Group Message

```bash
python3 -c "
import json, subprocess
data = json.dumps({'payload': {'type': 'message', 'text': 'Sync: all PRs merged to main'}})
subprocess.run(['curl', '-s', '-X', 'POST', 'http://localhost:3847/api/network/groups/team-example/message',
  '-H', 'Content-Type: application/json', '-d', data])
"
```

**Response (200):**
```json
{
  "messageId": "uuid",
  "delivered": ["peer-agent", "other-agent"],
  "queued": [],
  "failed": []
}
```

## Reading Inbox

```bash
# Latest 50 messages (default)
curl -s http://localhost:3847/api/network/inbox

# Last 10 messages
curl -s "http://localhost:3847/api/network/inbox?limit=10"

# Messages since a timestamp
curl -s "http://localhost:3847/api/network/inbox?since=2026-03-01T06:00:00&limit=20"
```

**Response (200):**
```json
{
  "messages": [
    {
      "id": 123,
      "from_agent": "network:peer-agent",
      "to_agent": "comms",
      "type": "text",
      "body": "[Network] peer-agent: PR merged, tests passing",
      "metadata": "{\"source\":\"a2a-network\",\"sender\":\"peer-agent\",\"messageId\":\"uuid\",\"verified\":true}",
      "created_at": "2026-03-01 07:30:00",
      "processed_at": "2026-03-01 07:30:05",
      "read_at": null
    }
  ],
  "count": 1,
  "timestamp": "2026-03-01T07:30:10.000Z"
}
```

The inbox works even if the A2A SDK is offline — it reads from the local database.

## LAN Direct Send (Fallback)

For peers on the same LAN, use `/agent/send` (2-tier: LAN direct, P2P SDK fallback):

```bash
python3 -c "
import json, subprocess
data = json.dumps({'peer': 'peer-agent', 'type': 'text', 'text': 'Quick LAN ping'})
subprocess.run(['curl', '-s', '-X', 'POST', 'http://localhost:3847/agent/send',
  '-H', 'Content-Type: application/json', '-d', data])
"
```

See the main SKILL.md for full LAN endpoint documentation.

## Common Mistakes

### 1. Sending message as JSON object instead of string

```bash
# WRONG — message must be a string, not an object
curl -d '{"to": "peer-agent", "message": {"text": "hello"}}'
#                                         ^^^^^^^^^^^^^^^^ object = 400 error

# CORRECT — message is a plain string
curl -d '{"to": "peer-agent", "message": "hello"}'
#                              ^^^^^^^^^ string = works
```

The `message` field is a **string**. If you need to send structured data, use `payload` (an object) instead.

### 2. Using uppercase usernames

```bash
# WRONG
curl -d '{"to": "Peer-Agent", "message": "hey"}'

# CORRECT — always lowercase, as configured in the network
curl -d '{"to": "peer-agent", "message": "hey"}'
```

### 3. Omitting both message and payload

```bash
# WRONG — returns 400
curl -d '{"to": "peer-agent"}'

# CORRECT — must include one
curl -d '{"to": "peer-agent", "message": "hello"}'
```

### 4. Shell quoting issues with curl

Use `python3` to generate JSON for complex messages — never rely on shell quoting for JSON with special characters:

```bash
python3 -c "
import json, subprocess
data = json.dumps({'to': 'peer-agent', 'message': 'Message with \"quotes\" and special chars'})
subprocess.run(['curl', '-s', '-X', 'POST', 'http://localhost:3847/api/network/message',
  '-H', 'Content-Type: application/json', '-d', data])
"
```

## Error Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (missing field, wrong type, invalid JSON) |
| 413 | Request body too large |
| 502 | Network SDK error (relay unreachable) |
| 503 | Network SDK not initialized |

## Message Flow

```
Outbound: Agent → POST /api/network/message → SDK → Relay → Peer SDK → Peer Agent
Inbound:  Peer SDK → /agent/p2p → SDK decrypt → messages DB → tmux injection
```

All messages (in/out) are persisted in the `messages` table for audit and retrieval.

## Choosing the Right Endpoint — Full Map

| Endpoint | Method | Purpose | Auth | Scope |
|----------|--------|---------|------|-------|
| `/agent/send` | POST | LAN direct send to a peer (2-tier: LAN → P2P fallback) | None (localhost only) | P2P |
| `/api/network/message` | POST | Send via A2A network SDK (P2P encrypted) | None (localhost only) | P2P |
| `/api/network/groups/:id/message` | POST | Broadcast to an A2A group | None (localhost only) | Group |
| `/api/network/inbox` | GET | Read received A2A messages | None (localhost only) | P2P + Group |
| `/api/send` | POST | Channel router — deliver to human via Telegram/email/etc. | None (localhost only) | Human |
| `/api/messages` | POST | Internal daemon message bus (comms ↔ orchestrator ↔ workers) | None (localhost only) | Internal |
| `/api/messages` | GET | Read internal message history | None (localhost only) | Internal |

### When to Use What

| I want to... | Use |
|--------------|-----|
| Send a quick message to a peer agent | `/agent/send` (fastest, LAN-first) or `/api/network/message` (SDK, always encrypted) |
| Broadcast to all peers in a group | `/api/network/groups/:id/message` with group name or ID |
| Send a message to the human (Telegram) | `/api/send` with `channels: ["telegram"]` |
| Send an email to the human | `/api/send` with `channels: ["email"]` |
| Post an internal message (comms ↔ orchestrator) | `/api/messages` |
| Read my A2A inbox | `/api/network/inbox` |
| Read internal messages | `/api/messages?agent=comms` |

## Agent Usernames

Agent usernames are configured per-instance in `kithkit.config.yaml`. Each agent's username is set under `agent.name` (lowercased) and registered with the A2A relay during setup.

Check which usernames are active on your network:
```bash
curl -s http://localhost:3847/api/network/peers
```

Always use lowercase usernames when addressing peers in message payloads.
