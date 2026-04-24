"""Async IRC bot that dispatches @mentions to Letta agents."""

import asyncio
import json
import os
import pathlib
import re
import sys
import time
from typing import Dict, Optional

import yaml

from letta_client import LettaClient, AgentNotFoundError, RateLimitError, APIError

# Regex for @agentname followed by message text
MENTION_RE = re.compile(r"^@(\w+)\s+(.*)$", re.DOTALL)

# IRC protocol max is ~512 bytes including CRLF; stay well under
MAX_MSG_LEN = 400


def load_config(path: str = "config.yaml") -> dict:
    with open(path, "r") as f:
        raw = f.read()
    # Simple env var substitution for ${VAR} syntax
    def replacer(match):
        var = match.group(1)
        return os.getenv(var, f"${{{var}}}")
    raw = re.sub(r"\$\{([^}]+)\}", replacer, raw)
    return yaml.safe_load(raw)


def load_letta_key_from_settings() -> Optional[str]:
    """Load LETTA_API_KEY from Letta Code's settings.json if env var is unset."""
    path = pathlib.Path.home() / ".letta" / "settings.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        return data.get("env", {}).get("LETTA_API_KEY")
    except (json.JSONDecodeError, OSError):
        return None


class IRCBot:
    def __init__(self, config: dict):
        self.config = config
        irc_cfg = config["irc"]
        self.server = irc_cfg["server"]
        self.port = irc_cfg["port"]
        self.nick = irc_cfg["nick"]
        self.channel = irc_cfg["channel"]

        letta_cfg = config["letta"]
        self.letta = LettaClient(
            base_url=letta_cfg["base_url"],
            api_key=letta_cfg.get("api_key"),
            timeout=letta_cfg.get("timeout", 60),
        )

        self.agents: Dict[str, str] = config.get("agents", {})
        bot_cfg = config.get("bot", {})
        self.max_len = bot_cfg.get("max_message_length", MAX_MSG_LEN)
        self.reconnect_delay = bot_cfg.get("reconnect_delay", 5)
        self.reconnect_backoff = bot_cfg.get("reconnect_backoff", 2)

        self.reader: Optional[asyncio.StreamReader] = None
        self.writer: Optional[asyncio.StreamWriter] = None
        self.ready_after: float = 0.0

    async def connect(self):
        self.reader, self.writer = await asyncio.open_connection(self.server, self.port)
        self._send(f"NICK {self.nick}")
        self._send(f"USER {self.nick} 0 * :{self.nick}")
        self._send(f"JOIN {self.channel}")
        self.ready_after = time.time() + 3

    def _send(self, line: str):
        if self.writer:
            self.writer.write((line + "\r\n").encode("utf-8"))

    def _privmsg(self, target: str, text: str):
        for chunk in self._chunk_text(text):
            self._send(f"PRIVMSG {target} :{chunk}")

    def _chunk_text(self, text: str):
        # Split long text into IRC-safe chunks while preserving words
        if len(text) <= self.max_len:
            return [text]
        chunks = []
        while text:
            if len(text) <= self.max_len:
                chunks.append(text)
                break
            idx = text.rfind(" ", 0, self.max_len)
            if idx == -1:
                idx = self.max_len
            chunks.append(text[:idx])
            text = text[idx:].lstrip()
        return chunks

    async def handle_line(self, line: str):
        if line.startswith("PING "):
            payload = line.split(" ", 1)[1]
            self._send(f"PONG {payload}")
            return

        # Parse PRIVMSG
        # :nick!user@host PRIVMSG #channel :message text
        if " PRIVMSG " in line:
            prefix, _, rest = line.partition(" PRIVMSG ")
            sender = prefix[1:].split("!", 1)[0] if prefix.startswith(":") else ""
            target, _, msg = rest.partition(" :")
            msg = msg.strip()

            # Only respond to messages in our target channel that mention our bot or use @agent
            # But per user request: only @mention dispatch, no auto-threading
            if sender == self.nick:
                return  # ignore our own messages (echo-message / bouncers)
            if not target.startswith("#"):
                return  # ignore PMs for now
            if target != self.channel:
                return
            if time.time() < self.ready_after:
                return  # ignore scrollback replay for 3s after join

            match = MENTION_RE.match(msg)
            if not match:
                return  # silently ignore non-mention messages

            agent_name, payload = match.group(1), match.group(2).strip()
            await self.dispatch(sender, target, agent_name, payload)

    async def dispatch(self, sender: str, target: str, agent_name: str, payload: str):
        agent_id = self.agents.get(agent_name)
        if not agent_id:
            available = ", ".join(sorted(self.agents.keys()))
            self._privmsg(target, f"{sender}: Unknown agent '@{agent_name}'. Available: {available}")
            return

        try:
            reply = await self.letta.send_message(agent_id, payload)
        except AgentNotFoundError:
            self._privmsg(target, f"{sender}: Agent '@{agent_name}' no longer exists on Letta.")
            return
        except RateLimitError:
            self._privmsg(target, f"{sender}: Rate limited by Letta API, wait a moment.")
            return
        except asyncio.TimeoutError:
            self._privmsg(target, f"{sender}: Letta API timed out, try again later.")
            return
        except APIError as exc:
            self._privmsg(target, f"{sender}: Letta API error {exc.status}: {exc.body}")
            return
        except Exception as exc:
            self._privmsg(target, f"{sender}: Error talking to Letta: {type(exc).__name__}: {exc}")
            return

        if not reply:
            reply = "(no response)"

        self._privmsg(target, f"{sender}: {reply}")

    async def run(self):
        delay = self.reconnect_delay
        while True:
            try:
                await self.connect()
                print(f"Connected to {self.server}:{self.port} as {self.nick}")
                delay = self.reconnect_delay  # reset on successful connect
                while True:
                    raw = await self.reader.readline()
                    if not raw:
                        break
                    line = raw.decode("utf-8", errors="replace").strip()
                    if line:
                        await self.handle_line(line)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"Connection error: {exc}")
                print(f"Reconnecting in {delay}s...")
                await asyncio.sleep(delay)
                delay = min(delay * self.reconnect_backoff, 300)
            finally:
                if self.writer:
                    self.writer.close()
                    try:
                        await self.writer.wait_closed()
                    except Exception:
                        pass


def main():
    if not os.getenv("LETTA_API_KEY"):
        key = load_letta_key_from_settings()
        if key:
            os.environ["LETTA_API_KEY"] = key
    config = load_config()
    bot = IRCBot(config)
    try:
        asyncio.run(bot.run())
    except KeyboardInterrupt:
        print("\nShutting down.")
        sys.exit(0)


if __name__ == "__main__":
    main()
