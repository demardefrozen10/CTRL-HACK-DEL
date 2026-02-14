"""WebSocket connection manager."""
from __future__ import annotations

import json
from typing import Any, List

from fastapi import WebSocket


class ConnectionManager:
    """Manages WebSocket connections for real-time updates."""

    def __init__(self) -> None:
        self._connections: List[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        """Accept and track a new WebSocket connection."""
        await ws.accept()
        self._connections.append(ws)
        print(f"[WebSocket] Client connected. Total: {len(self._connections)}")

    def disconnect(self, ws: WebSocket) -> None:
        """Remove a WebSocket connection."""
        if ws in self._connections:
            self._connections.remove(ws)
        print(f"[WebSocket] Client disconnected. Total: {len(self._connections)}")

    async def broadcast(self, data: dict[str, Any]) -> None:
        """Broadcast data to all connected clients."""
        payload = json.dumps(data)
        stale: List[WebSocket] = []
        for ws in self._connections:
            try:
                await ws.send_text(payload)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self.disconnect(ws)

    @property
    def connection_count(self) -> int:
        return len(self._connections)


# Global singleton instance
ws_manager = ConnectionManager()
