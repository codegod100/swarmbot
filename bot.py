"""Async IRC bot that dispatches @mentions to Letta agents."""

import asyncio
import json
import logging
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


def setup_logging() -> logging.Logger:
    """Configure stdout logging with optional level from BOT_LOG_LEVEL env var."""
    log = logging.getLogger("bot")
    log.setLevel(logging.DEBUG)

    handler = logging.StreamHandler(sys.stdout)
    level_name = os.getenv("BOT_LOG_LEVEL", "DEBUG").upper()
    handler.setLevel(getattr(logging, level_name, logging.INFO))

    fmt = logging.Formatter(
        "%(asctime)s [%(name)s] %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    handler.setFormatter(fmt)
    log.addHandler(handler)

    # child loggers inherit handler
    for child in ("irc.raw", "dispatch", "letta", "reply"):
        logging.getLogger(f"bot.{child}").setLevel(logging.DEBUG)

    return log


def load_config(path: str = "config.yaml") -> dict:
    with open(path, "r") as f:
        raw = f.read()

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
    def __init__(self, config: dict, log: logging.Logger):
        self.config = config
        self.log = log
        self.log_irc = logging.getLogger("bot.irc.raw")
        self.log_dispatch = logging.getLogger("bot.dispatch")
        self.log_letta = logging.getLogger("bot.letta")
        self.log_reply = logging.getLogger("bot.reply")

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
        self._send_raw(f"NICK {self.nick}")
        self._send_raw(f"USER {self.nick} 0 * :{self.nick}")
        self._send_raw(f"JOIN {self.channel}")
        self.ready_after = time.time() + 3
        self.log.info("Connected to %s:%s as %s", self.server, self.port, self.nick)

    def _send_raw(self, line: str):
        if self.writer:
            self.writer.write((line + "\r\n").encode("utf-8"))
            self.log_irc.debug(">> %s", line)

    def _privmsg(self, target: str, text: str):
        # Normalize whitespace (flatten newlines, collapse runs) and send as one chunk
        normalized = " ".join(text.split())
        if len(normalized) > self.max_len:
            normalized = normalized[: self.max_len - 3].rstrip() + "..."
        self._send_raw(f"PRIVMSG {target} :{normalized}")
        self.log_reply.info("<< %s: %s", target, normalized[:120])

    async def handle_line(self, line: str):
        self.log_irc.debug("<< %s", line)

        if line.startswith("PING "):
            payload = line.split(" ", 1)[1]
            self._send_raw(f"PONG {payload}")
            self.log.debug("PONG → %s", payload)
            return

        if " PRIVMSG " in line:
            prefix, _, rest = line.partition(" PRIVMSG ")
            sender = prefix[1:].split("!", 1)[0] if prefix.startswith(":") else ""
            target, _, msg = rest.partition(" :")
            msg = msg.strip()

            if sender == self.nick:
                return
            if not target.startswith("#"):
                return
            if target != self.channel:
                return
            if time.time() < self.ready_after:
                return

            match = MENTION_RE.match(msg)
            if not match:
                return

            agent_name, payload = match.group(1), match.group(2).strip()
            self.log_dispatch.info(
                "%s → @%s: %s", sender, agent_name, payload[:200])
            await self.dispatch(sender, target, agent_name, payload)
            return

        self.log.debug("Unhandled IRC line: %s", line)

    async def dispatch(self, sender: str, target: str, agent_name: str, payload: str):
        agent_id = self.agents.get(agent_name)
        if not agent_id:
            available = ", ".join(sorted(self.agents.keys()))
            self._privmsg(target, f"{sender}: Unknown agent '@{agent_name}'. Available: {available}")
            return

        assistant_reply = ""
        try:
            async for event in self.letta.stream_message(agent_id, payload):
                msg_type = event.get("message_type", "unknown")

                if msg_type == "reasoning_message":
                    reasoning = event.get("reasoning", "")
                    self.log_letta.info("[reasoning] %s", reasoning[:200])

                elif msg_type == "hidden_reasoning_message":
                    state = event.get("state", "")
                    self.log_letta.info("[hidden_reasoning] state=%s", state)

                elif msg_type == "assistant_message":
                    content = event.get("content", "")
                    self.log_letta.info("[assistant] %s", content[:200])
                    assistant_reply += content

                elif msg_type == "tool_call_message":
                    name = event.get("name", "unknown_tool")
                    args = event.get("arguments", {})
                    self.log_letta.info("[tool_call] %s(%s)", name, json.dumps(args)[:200])

                elif msg_type == "tool_return_message":
                    ret = event.get("return_value", "")
                    self.log_letta.info("[tool_return] %s", str(ret)[:200])

                elif msg_type == "stop_reason":
                    reason = event.get("stop_reason", "")
                    self.log_letta.info("[stop] %s", reason)

                elif msg_type == "usage_statistics":
                    total = event.get("total_tokens", 0)
                    steps = event.get("step_count", 0)
                    self.log_letta.info("[usage] %s tokens, %s steps", total, steps)

                elif msg_type == "ping":
                    self.log_letta.debug("[ping]")

                else:
                    self.log_letta.debug("[%s] %s", msg_type, str(event)[:200])

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

        if not assistant_reply:
            assistant_reply = "(no response)"

        self._privmsg(target, f"{sender}: {assistant_reply}")

    async def run(self):
        delay = self.reconnect_delay
        while True:
            try:
                await self.connect()
                delay = self.reconnect_delay
                while True:
                    raw = await self.reader.readline()
                    if not raw:
                        self.log.warning("Server closed connection (empty read)")
                        break
                    line = raw.decode("utf-8", errors="replace").strip()
                    if line:
                        await self.handle_line(line)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.log.error("Connection lost", exc_info=True)
                self.log.info("Reconnecting in %ss...", delay)
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
    log = setup_logging()
    bot = IRCBot(config, log)
    try:
        asyncio.run(bot.run())
    except KeyboardInterrupt:
        log.info("Shutting down.")
        sys.exit(0)


if __name__ == "__main__":
    main()
