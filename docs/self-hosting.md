# Self-Hosting Guide

The relay server has been extracted to its own repository for easier self-hosting:

**[github.com/RockaRhymeLLC/cc4me-relay](https://github.com/RockaRhymeLLC/cc4me-relay)**

The relay repo includes:
- Quick start and deployment instructions
- Systemd service configuration
- Nginx + Let's Encrypt setup
- Full API reference
- Deployment script for repeatable deploys

## Quick Start

```bash
git clone https://github.com/RockaRhymeLLC/cc4me-relay.git
cd cc4me-relay
npm install
npm run build
npm start
# Health check: curl http://localhost:8080/health
```

See the [relay README](https://github.com/RockaRhymeLLC/cc4me-relay#readme) for the complete self-hosting guide, including environment variables, systemd setup, and HTTPS configuration.

## After Setup

Once your relay is running, follow the [Agent Onboarding Guide](onboarding.md) to register agents. Point the `relayUrl` to your relay's HTTPS URL instead of the public one.
