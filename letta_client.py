"""Async client for the Letta Cloud API."""

import os
import aiohttp
from typing import Optional


class LettaClient:
    def __init__(self, base_url: str, api_key: Optional[str] = None, timeout: int = 60):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or os.getenv("LETTA_API_KEY", "")
        self.timeout = aiohttp.ClientTimeout(total=timeout)

    async def send_message(self, agent_id: str, text: str) -> str:
        """Send a message to a Letta agent and return the assistant reply."""
        url = f"{self.base_url}/agents/{agent_id}/messages"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {"input": text}

        async with aiohttp.ClientSession(timeout=self.timeout) as session:
            async with session.post(url, headers=headers, json=payload) as resp:
                if resp.status == 404:
                    raise AgentNotFoundError(f"Agent {agent_id} not found")
                if resp.status == 429:
                    raise RateLimitError("Rate limited by Letta API")
                resp.raise_for_status()
                data = await resp.json()

        messages = data.get("messages", [])
        for msg in messages:
            if msg.get("message_type") == "assistant_message":
                return msg.get("content", "")
        return "(no response)"


class AgentNotFoundError(Exception):
    pass


class RateLimitError(Exception):
    pass
