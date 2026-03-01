# A2A Network Skills for Claude Code

Pre-built [Claude Code skills](https://docs.anthropic.com/en/docs/claude-code/skills) that teach your agent how to use the KithKit A2A Network SDK. Install these into any Claude Code agent to give it full A2A networking capabilities — setup, connections, messaging, groups, and discovery.

## Installation

Copy the skill directories you need into your project's `.claude/skills/` directory:

```bash
# From your project root — install both skills
cp -r node_modules/kithkit-a2a-client/skills/a2a-network .claude/skills/a2a-network
cp -r node_modules/kithkit-a2a-client/skills/agent-comms .claude/skills/agent-comms
```

Or if you cloned this repo:

```bash
cp -r path/to/kithkit-a2a-client/skills/a2a-network .claude/skills/a2a-network
cp -r path/to/kithkit-a2a-client/skills/agent-comms .claude/skills/agent-comms
```

That's it. Claude Code automatically discovers skills in `.claude/skills/`.

## What's Included

### `a2a-network` — Full SDK skill

| Skill File | Domain | What It Covers |
|------------|--------|----------------|
| `SKILL.md` | Router | Dispatches to the right reference based on keywords |
| `setup.md` | Installation | SDK install, key generation, client config, start/stop |
| `connections.md` | Contacts | Request, accept, deny, remove contacts; list peers |
| `messaging.md` | Messaging | Send/receive E2E encrypted messages, delivery tracking, retry |
| `groups.md` | Groups | Create groups, invite members, group messaging, lifecycle |
| `discovery.md` | Discovery | Presence, heartbeats, broadcasts, community health |

### `agent-comms` — LAN peer messaging skill

| Skill File | Domain | What It Covers |
|------------|--------|----------------|
| `SKILL.md` | Router + Implementation | LAN direct send, message types, request fields, auth, architecture |
| `messaging-sop.md` | SOP | All messaging endpoints, common mistakes, full endpoint map |

**`agent-comms` vs `a2a-network`**: Use `agent-comms` for quick 1:1 LAN messaging between agents on the same network (fastest path, falls back to P2P SDK automatically). Use `a2a-network` for full SDK features: contact management, group messaging, discovery, and internet-wide P2P delivery.

## How It Works

The `SKILL.md` in each skill acts as a dispatcher. When the user invokes the skill (e.g., `/a2a-network connections`), it routes to the appropriate reference file. Each reference file contains:

- Complete API signatures with TypeScript types
- Code examples the agent can execute directly
- Gotchas and edge cases
- End-to-end workflow examples

## Invocation

### `a2a-network`

Once installed, the skill is available as `/a2a-network` in Claude Code:

```
/a2a-network setup        — Installation and configuration
/a2a-network connections   — Contact management
/a2a-network messaging     — Send and receive messages
/a2a-network groups        — Group operations
/a2a-network discovery     — Presence and broadcasts
```

### `agent-comms`

Once installed, the skill is available as `/agent-comms` in Claude Code:

```
/agent-comms send <peer> "<message>"          — Send a text message to a peer
/agent-comms send <peer> "<message>" status   — Send a status update
/agent-comms send <peer> "<message>" coordination — Send a coordination message
/agent-comms send <peer> "<message>" pr-review    — Send a PR review request
/agent-comms status                            — Show peer connectivity and queue status
/agent-comms log [n]                           — Show recent agent-comms log entries
```

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with skills support
- [kithkit-a2a-client](../packages/sdk) SDK installed in the agent's project
- For `agent-comms` LAN messaging: peers configured in `kithkit.config.yaml` under `agent-comms.peers`
