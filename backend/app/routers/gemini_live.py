"""Gemini Live API WebSocket proxy.

Browser  ──WS──▶  FastAPI  ──WS──▶  Gemini Live API
  webcam frames (JPEG b64)           send_realtime_input(media=…)
  mic audio   (PCM  b64)            send_realtime_input(audio=…)
◀── audio chunks (PCM b64)     ◀──  response audio
◀── text   (transcript)        ◀──  response text
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types

logger = logging.getLogger("echo-sight.gemini-live")

router = APIRouter(tags=["gemini-live"])

_viewer_clients: set[WebSocket] = set()
_viewer_lock = asyncio.Lock()
_source_lock = asyncio.Lock()
_control_queue: asyncio.Queue[dict] = asyncio.Queue()
_source_connected = False

# ---------------------------------------------------------------------------
# Gemini Live session configuration
# ---------------------------------------------------------------------------
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
MODEL = "gemini-2.5-flash-native-audio-latest"

SYSTEM_INSTRUCTION = (
    "You are a helpful assistant. Answer any questions as necessary."
)


def _build_config() -> types.LiveConnectConfig:
    """Build the Gemini Live session config."""
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=types.Content(
            parts=[types.Part(text=SYSTEM_INSTRUCTION)]
        ),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name="Puck"
                )
            )
        ),
    )


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@router.websocket("/ws/live")
async def gemini_live_proxy(ws: WebSocket) -> None:
    """Proxy between WebSocket clients and Gemini Live API session.

    role=source: sends video/audio to Gemini (Pi client)
    role=viewer: receives Gemini responses and can send text commands (dashboard)
    """
    role = (ws.query_params.get("role") or "source").lower()
    if role == "viewer":
        await _viewer_loop(ws)
        return

    await ws.accept()
    logger.info("Source connected to /ws/live")

    global _source_connected
    async with _source_lock:
        if _source_connected:
            await ws.send_text(json.dumps({
                "type": "error",
                "message": "A source session is already active.",
            }))
            await ws.close()
            return
        _source_connected = True

    if not GEMINI_API_KEY:
        await ws.send_text(json.dumps({
            "type": "error",
            "message": "GEMINI_API_KEY is not configured on the server.",
        }))
        await ws.close()
        return

    client = genai.Client(
        api_key=GEMINI_API_KEY,
        http_options={"api_version": "v1beta"},
    )

    config = _build_config()

    try:
        async with client.aio.live.connect(model=MODEL, config=config) as session:
            logger.info("Gemini Live session opened")
            await ws.send_text(json.dumps({"type": "session_started"}))
            await _broadcast_to_viewers({"type": "session_started"})

            source_send_task = asyncio.create_task(
                _forward_source_to_gemini(ws, session)
            )
            control_send_task = asyncio.create_task(
                _forward_viewer_commands_to_gemini(session)
            )
            recv_task = asyncio.create_task(_forward_gemini_to_clients(ws, session))

            done, pending = await asyncio.wait(
                [source_send_task, control_send_task, recv_task],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            # Propagate any exception from the completed task
            for task in done:
                task.result()

    except WebSocketDisconnect:
        logger.info("Source disconnected from /ws/live")
    except Exception as exc:
        logger.exception("Gemini Live proxy error: %s", exc)
        try:
            await ws.send_text(json.dumps({
                "type": "error",
                "message": str(exc),
            }))
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass
        async with _source_lock:
            _source_connected = False
        logger.info("Gemini Live session closed")
        await _broadcast_to_viewers({"type": "source_disconnected"})


async def _viewer_loop(ws: WebSocket) -> None:
    await ws.accept()
    async with _viewer_lock:
        _viewer_clients.add(ws)
    logger.info("Viewer connected to /ws/live")

    try:
        await ws.send_text(json.dumps({"type": "viewer_connected"}))
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")
            if msg_type == "text":
                text = str(msg.get("text", "")).strip()
                if not text:
                    continue
                if not _source_connected:
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "message": "No Pi source connected.",
                    }))
                    continue
                await _control_queue.put({"type": "text", "text": text})

            elif msg_type == "end_audio_stream":
                if _source_connected:
                    await _control_queue.put({"type": "end_audio_stream"})

    except WebSocketDisconnect:
        logger.info("Viewer disconnected from /ws/live")
    finally:
        async with _viewer_lock:
            _viewer_clients.discard(ws)
        try:
            await ws.close()
        except Exception:
            pass


async def _forward_source_to_gemini(
    ws: WebSocket,
    session,
) -> None:
    """Read messages from source WS and forward to Gemini Live."""
    while True:
        raw = await ws.receive_text()
        msg = json.loads(raw)
        msg_type = msg.get("type")

        if msg_type == "video":
            # Browser sends: {"type":"video","data":"<base64 JPEG>"}
            b64_data = msg["data"]
            await session.send_realtime_input(
                media=types.Blob(
                    mime_type="image/jpeg",
                    data=base64.b64decode(b64_data),
                )
            )

        elif msg_type == "audio":
            # Browser sends: {"type":"audio","data":"<base64 PCM 16-bit 16kHz mono>"}
            b64_data = msg["data"]
            await session.send_realtime_input(
                audio=types.Blob(
                    data=base64.b64decode(b64_data),
                    mime_type="audio/pcm;rate=16000",
                )
            )

        elif msg_type == "text":
            # Browser sends: {"type":"text","text":"hello"}
            text = msg.get("text", "")
            await session.send_client_content(
                turns=types.Content(parts=[types.Part(text=text)]),
                turn_complete=True,
            )

        elif msg_type == "end_audio_stream":
            await session.send_realtime_input(audio_stream_end=True)


async def _forward_viewer_commands_to_gemini(session) -> None:
    while True:
        command = await _control_queue.get()
        msg_type = command.get("type")

        if msg_type == "text":
            text = str(command.get("text", "")).strip()
            if text:
                await session.send_client_content(
                    turns=types.Content(parts=[types.Part(text=text)]),
                    turn_complete=True,
                )
        elif msg_type == "end_audio_stream":
            await session.send_realtime_input(audio_stream_end=True)


async def _forward_gemini_to_clients(
    ws: WebSocket,
    session,
) -> None:
    """Read responses from Gemini Live and forward to source + viewers."""
    while True:
        turn = session.receive()
        async for response in turn:
            # Audio data
            if data := response.data:
                payload = {
                    "type": "audio",
                    "data": base64.b64encode(data).decode("ascii"),
                }
                await ws.send_text(json.dumps(payload))
                await _broadcast_to_viewers(payload)
                continue

            # Text content
            if text := response.text:
                payload = {
                    "type": "text",
                    "text": text,
                }
                await ws.send_text(json.dumps(payload))
                await _broadcast_to_viewers(payload)
                continue

            # Check for interruption
            sc = response.server_content
            if sc and getattr(sc, "interrupted", False):
                payload = {"type": "interrupted"}
                await ws.send_text(json.dumps(payload))
                await _broadcast_to_viewers(payload)

            # Turn complete
            sc = response.server_content
            if sc and getattr(sc, "turn_complete", False):
                payload = {"type": "turn_complete"}
                await ws.send_text(json.dumps(payload))
                await _broadcast_to_viewers(payload)


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
