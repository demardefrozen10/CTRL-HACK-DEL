"""Live WebSocket relay for Pi video -> frontend viewers.

No Gemini API calls happen here. This router only relays source frames to viewers.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger("echo-sight.live-relay")
router = APIRouter(tags=["live-relay"])

_viewer_clients: set[WebSocket] = set()
_viewer_lock = asyncio.Lock()
_source_lock = asyncio.Lock()
_source_connected = False
_source_last_seen_monotonic = 0.0
_SOURCE_STALE_SECONDS = 12.0


async def _broadcast_to_viewers(payload: dict) -> None:
    raw = json.dumps(payload)
    async with _viewer_lock:
        viewers = list(_viewer_clients)

    stale: list[WebSocket] = []
    for viewer in viewers:
        try:
            await viewer.send_text(raw)
        except Exception:
            stale.append(viewer)

    if stale:
        async with _viewer_lock:
            for viewer in stale:
                _viewer_clients.discard(viewer)


@router.websocket("/ws/live")
async def live_relay(ws: WebSocket) -> None:
    global _source_connected, _source_last_seen_monotonic
    role = (ws.query_params.get("role") or "source").lower()

    if role == "viewer":
        await ws.accept()
        async with _viewer_lock:
            _viewer_clients.add(ws)

        await ws.send_text(
            json.dumps(
                {
                    "type": "viewer_connected",
                    "source_connected": _source_connected,
                }
            )
        )

        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            async with _viewer_lock:
                _viewer_clients.discard(ws)
            try:
                await ws.close()
            except Exception:
                pass
        return

    await ws.accept()

    async with _source_lock:
        if _source_connected:
            age = time.monotonic() - _source_last_seen_monotonic
            if age > _SOURCE_STALE_SECONDS:
                logger.warning("Stale source detected (%.2fs), allowing takeover", age)
                _source_connected = False
            else:
                await ws.send_text(
                    json.dumps(
                        {
                            "type": "error",
                            "message": "A source session is already active.",
                        }
                    )
                )
                await ws.close()
                return

        _source_connected = True
        _source_last_seen_monotonic = time.monotonic()

    await ws.send_text(json.dumps({"type": "session_started"}))
    await _broadcast_to_viewers({"type": "source_connected"})

    try:
        while True:
            raw = await ws.receive_text()
            _source_last_seen_monotonic = time.monotonic()

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if msg.get("type") == "video":
                data = msg.get("data")
                if data:
                    await _broadcast_to_viewers({"type": "video_preview", "data": data})

    except WebSocketDisconnect:
        pass
    finally:
        async with _source_lock:
            _source_connected = False
            _source_last_seen_monotonic = 0.0

        await _broadcast_to_viewers({"type": "source_disconnected"})
        try:
            await ws.close()
        except Exception:
            pass
