# Swarm

A multi-channel Letta bot that connects to IRC and can also ingest read-only Bluesky feeds, dispatching messages to [Letta](https://letta.com) agents.

The runnable entrypoint is TypeScript: `npm start`.

## Features

- **@mention dispatch** — tag an agent like `@researcher tell me about Python`
- **Letta Cloud integration** — talks to your Letta agents via the official REST API
- **No auto-threading** — every command must include an explicit `@agent` mention
- **Reconnect logic** — automatically reconnects to IRC with exponential backoff
- **Chunked replies** — long agent responses are split safely across multiple IRC lines
- **Read-only Bluesky feed ingest** — polls a specific feed URI and mirrors new posts into `#latha` without posting back to Bluesky or sending them through Letta
- **@updates command** — fetches the latest five posts from the configured Bluesky feed into IRC on demand

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Create a `.env` file** in the repo root:
   ```bash
   LETTA_API_KEY=your-api-key-here
   LETTA_AGENT_RESEARCHER_ID=agent-...
   LETTA_AGENT_OBSIDIAN_ID=agent-...
   FREEQ_CREDS_PATH=/home/nandi/code/rookery/scripts/rookery-creds.json
   ```
   `npm start` reads this file automatically. You can still export env vars in the shell if you prefer.

3. **Point `FREEQ_CREDS_PATH` at a Rookery creds JSON** — the bot uses the same PDS session flow as `scripts/freeq-connect.ts` in the rookery repo. The file needs `did`, `handle`, `access_token`, `private_key_pem`, `public_jwk`, and `pds_origin`.

4. **Review `swarm.yaml`** — defaults are already set for `#swarm` and `#latha` on `wss://irc.freeq.at/irc`. Update `channels.irc.joinChannels`, the optional `channels.bluesky` feed settings, and the `agents:` map as needed.

## Running

```bash
npm start
```

The bot will load the local creds, create a short-lived PDS session, join the configured IRC rooms (default `#swarm` and `#latha`), and mirror any enabled Bluesky feed(s) into `#latha`.

## Usage in #swarm

```irc
<alice> @researcher what is the capital of France
<swarmbot> alice: The capital of France is Paris.

<bob> @obsidian fix my bug
<swarmbot> bob: Unknown agent '@obsidian'. Available: researcher, obsidian
```

## Configuration (`swarm.yaml`)

Key fields:

- `server.mode` / `server.apiKey` — Letta API auth
- `agent.name` / `agent.id` — default Letta agent
- `channels.irc.server` — IRC WebSocket URL
- `channels.irc.nick` / `channels.irc.joinChannels` — IRC identity and ordered rooms to join (Freeq defaults to `#swarm` and `#latha`)
- `channels.irc.allowedUsers` — exact allowlist for inbound messages
- `channels.irc.messageReadDelayMs` — ignore initial Freeq scrollback after joining
- `channels.bluesky.feedUri` / `channels.bluesky.mirrorChannel` / `channels.bluesky.limit` / `channels.bluesky.pollIntervalMs` — Bluesky feed generator URI, mirror target, fetch limit, and polling cadence (the current config uses the For You feed at `at://did:plc:3guzzweuqraryl3rdkimjamk/app.bsky.feed.generator/for-you` with `limit: 1`)
- `channels.bluesky.apiBaseUrl` — optional Bluesky AppView/XRPC base URL for anonymous requests; defaults to `https://public.api.bsky.app`
- `channels.bluesky.auth.identifier` / `channels.bluesky.auth.appPassword` / `channels.bluesky.auth.pdsUrl` — optional Bluesky session for personalized feeds like For You; `pdsUrl` defaults to `https://bsky.social`
- `channels.bluesky` is read-only — posts are ingested and mirrored into IRC, but the adapter will not publish back to Bluesky
- `agents.*` — map of `@name` → Letta `agent_id`

## Adding More Agents

Edit `swarm.yaml`:

```yaml
agents:
  researcher: "agent-ac7541ac-0292-463e-9b72-2182ad91ddf2"
  obsidian: "agent-62060ac1-999d-47cc-8d0e-eafa3f360a6b"
```

Then restart the bot. Users can immediately use `@obsidian ...`.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `401 Unauthorized` | Missing `LETTA_API_KEY` | Export the env var |
| `Freeq creds` error | `FREEQ_CREDS_PATH` is missing or wrong | Point it at a rookery creds JSON |
| `Unknown agent` | Name not in `agents` map | Add it to `swarm.yaml` |
| Timeout errors | Letta API is slow | Increase `letta.timeout` |
| Won't reconnect | Network blip | Wait — backoff handles it |

## Related Projects

- **[panproto](https://github.com/panproto/panproto)** — Schematic version control for data schemas.
  Relevant for evolving `swarm.yaml` structure, agent response formats, or conversation memory schemas as the bot grows.
