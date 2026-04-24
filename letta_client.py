"""Async client for the Letta Cloud API."""

import json
import os
import ssl
from typing import AsyncIterator, Optional

import aiohttp
import certifi


class LettaClient:
    def __init__(self, base_url: str, api_key: Optional[str] = None, timeout: int = 180):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or os.getenv("LETTA_API_KEY", "")
        self.timeout = aiohttp.ClientTimeout(total=timeout)
        self._ssl = ssl.create_default_context(cafile=certifi.where())

    async def send_message(self, agent_id: str, text: str) -> str:
        """Send a message to a Letta agent and return the assistant reply (non-streaming fallback)."""
        url = f"{self.base_url}/agents/{agent_id}/messages"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {"input": text}

        connector = aiohttp.TCPConnector(ssl=self._ssl)
        async with aiohttp.ClientSession(timeout=self.timeout, connector=connector) as session:
            async with session.post(url, headers=headers, json=payload) as resp:
                body = await resp.text()
                if resp.status == 404:
                    raise AgentNotFoundError(f"Agent {agent_id} not found")
                if resp.status == 429:
                    raise RateLimitError("Rate limited by Letta API")
                if resp.status >= 400:
                    raise APIError(resp.status, body[:200])
                data = await resp.json()

        messages = data.get("messages", [])
        for msg in messages:
            if msg.get("message_type") == "assistant_message":
                return msg.get("content", "")
        return "(no response)"

    async def stream_message(self, agent_id: str, text: str) -> AsyncIterator[dict]:
        """Stream SSE events from Letta /messages/stream endpoint."""
        url = f"{self.base_url}/agents/{agent_id}/messages/stream"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        payload = {"input": text}

        connector = aiohttp.TCPConnector(ssl=self._ssl)
        async with aiohttp.ClientSession(timeout=self.timeout, connector=connector) as session:
            async with session.post(url, headers=headers, json=payload) as resp:
                if resp.status == 404:
                    raise AgentNotFoundError(f"Agent {agent_id} not found")
                if resp.status == 429:
                    raise RateLimitError("Rate limited by Letta API")
                if resp.status >= 400:
                    body = await resp.text()
                    raise APIError(resp.status, body[:200])

                async for line in resp.content:
                    line = line.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    if line.startswith("data: "):
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            return
                        try:
                            yield json.loads(data_str)
                        except json.JSONDecodeError:
                            continue


class AgentNotFoundError(Exception):
    pass


class RateLimitError(Exception):
    pass


class APIError(Exception):
    """Non-2xx HTTP response from Letta API."""

    def __init__(self, status: int, body: str):
        self.status = status
        self.body = body
        super().__init__(f"HTTP {status}: {body}")
