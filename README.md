# swarmbot

An async IRC bot that connects to `irc.freeq.at` and dispatches `@mention` messages to [Letta](https://letta.com) agents.

## Features

- **@mention dispatch** — tag an agent like `@researcher tell me about Python`
- **Letta Cloud integration** — talks to your Letta agents via the official REST API
- **No auto-threading** — every command must include an explicit `@agent` mention
- **Reconnect logic** — automatically reconnects to IRC with exponential backoff
- **Chunked replies** — long agent responses are split safely across multiple IRC lines

## Setup

1. **Install uv** (if you don't have it):
   ```bash
   pip install uv
   # or: curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

2. **Set your Letta API key**:
   ```bash
   export LETTA_API_KEY="your-api-key-here"
   ```
   Get your key at [app.letta.com/api-keys](https://app.letta.com/api-keys).

3. **Review `config.yaml`** — defaults are already set for `#swarm` on `irc.freeq.at`. Update agent mappings under the `agents:` key as needed.

## Running

```bash
uv run bot.py
```

Logging is **verbose by default** (shows every IRC line, agent reasoning, tool calls, and API events). To quiet down:

```bash
BOT_LOG_LEVEL=INFO uv run bot.py
```

Or install and run as a script:
```bash
uv pip install .
swarmbot
```

The bot will join `#swarm` as `swarmbot` and wait for `@mention` commands.

## Usage in #swarm

```irc
<alice> @researcher what is the capital of France
<swarmbot> alice: The capital of France is Paris.

<bob> @coder fix my bug
<swarmbot> bob: Unknown agent '@coder'. Available: researcher
```

## Configuration (`config.yaml`)

| Key | Default | Description |
|-----|---------|-------------|
| `irc.server` | `irc.freeq.at` | IRC server hostname |
| `irc.port` | `6667` | IRC server port |
| `irc.nick` | `swarmbot` | Bot nickname |
| `irc.channel` | `#swarm` | Channel to join |
| `letta.base_url` | `https://api.letta.com/v1` | Letta API base URL |
| `letta.timeout` | `60` | Request timeout in seconds |
| `agents.*` | *(see file)* | Map of `@name` → Letta `agent_id` |

## Adding More Agents

Edit `config.yaml`:

```yaml
agents:
  researcher: "agent-941987c9-9a0e-4076-9ff2-f05354529d47"
  coder: "agent-your-coder-agent-id-here"
```

Then restart the bot. Users can immediately use `@coder ...`.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `401 Unauthorized` | Missing `LETTA_API_KEY` | Export the env var |
| `Unknown agent` | Name not in `agents` map | Add it to `config.yaml` |
| Timeout errors | Letta API is slow | Increase `letta.timeout` |
| Won't reconnect | Network blip | Wait — backoff handles it |
