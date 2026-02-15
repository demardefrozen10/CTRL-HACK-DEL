"""Gemini Live API WebSocket proxy.

Pi source (role=source) sends camera frames only.
Browser viewer (role=viewer) sends mic audio and optional text commands.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

try:
    from google import genai
    from google.genai import types
    _GENAI_IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover - import environment dependent
    genai = None  # type: ignore[assignment]
    types = None  # type: ignore[assignment]
    _GENAI_IMPORT_ERROR = exc

logger = logging.getLogger("echo-sight.gemini-live")

router = APIRouter(tags=["gemini-live"])

_viewer_clients: set[WebSocket] = set()
_viewer_lock = asyncio.Lock()
_source_lock = asyncio.Lock()
_control_queue: asyncio.Queue[dict] = asyncio.Queue()
_source_connected = False
_session_active = False
_source_last_seen_monotonic = 0.0
_SOURCE_STALE_SECONDS = 12.0
_last_preview_sent_monotonic = 0.0
_PREVIEW_MAX_FPS = 6.0


def _offer_latest_video_frame(queue: asyncio.Queue[str], b64_data: str) -> None:
    """Keep only the most recent frame so Gemini never lags behind real-time."""
    while not queue.empty():
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            break
    try:
        queue.put_nowait(b64_data)
    except asyncio.QueueFull:
        pass


def _drain_control_queue() -> None:
    while not _control_queue.empty():
        try:
            _control_queue.get_nowait()
        except asyncio.QueueEmpty:
            break


# ---------------------------------------------------------------------------
# Gemini Live session configuration
# ---------------------------------------------------------------------------
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
MODEL = "gemini-2.5-flash-native-audio-latest"

SYSTEM_INSTRUCTION = (
    "You are Echo-Sight, a live multimodal assistant. "
    "Use the camera feed plus user speech/text to answer questions directly. "
    "Prioritize safety and navigation details when relevant. "
    "Keep responses concise and natural unless the user asks for detail."
)


def _build_config() -> Any:
    """Build the Gemini Live session config."""
    if types is None:
        raise RuntimeError(
            f"Gemini Live SDK unavailable: {_GENAI_IMPORT_ERROR!r}. "
            "Install/upgrade google-genai in the active Python environment."
        )
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=types.Content(
            parts=[types.Part(text=SYSTEM_INSTRUCTION)]
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
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

    role=source: sends Pi video frames to Gemini
    role=viewer: sends browser mic audio/text and receives Gemini responses
    """
    role = (ws.query_params.get("role") or "source").lower()
    logger.info("[DEBUG] /ws/live hit  role=%s  client=%s", role, ws.client)
    if role == "viewer":
        await _viewer_loop(ws)
        return

    await ws.accept()
    logger.info("[DEBUG] Source WebSocket ACCEPTED  client=%s", ws.client)

    if genai is None:
        await ws.send_text(json.dumps({
            "type": "error",
            "message": (
                "Gemini Live SDK is unavailable on this server. "
                f"Import error: {_GENAI_IMPORT_ERROR!r}"
            ),
        }))
        await ws.close()
        return

    if not GEMINI_API_KEY:
        await ws.send_text(json.dumps({
            "type": "error",
            "message": "GEMINI_API_KEY is not configured on the server.",
        }))
        await ws.close()
        return

    global _source_connected, _source_last_seen_monotonic
    async with _source_lock:
        if _source_connected:
            age = time.monotonic() - _source_last_seen_monotonic
            if age > _SOURCE_STALE_SECONDS:
                logger.warning(
                    "Stale source session detected (last_seen %.2fs ago). Allowing takeover.",
                    age,
                )
                _source_connected = False
            else:
                await ws.send_text(json.dumps({
                    "type": "error",
                    "message": "A source session is already active.",
                }))
                await ws.close()
                return
        _source_connected = True
        _source_last_seen_monotonic = time.monotonic()

    logger.info("[DEBUG] source_connected broadcast sent to viewers")
    await _broadcast_to_viewers({"type": "source_connected"})
    _drain_control_queue()

    client = genai.Client(
        api_key=GEMINI_API_KEY,
        http_options={"api_version": "v1beta"},
    )

    config = _build_config()

    global _session_active
    try:
        async with client.aio.live.connect(model=MODEL, config=config) as session:
            logger.info("[DEBUG] Gemini Live session opened")
            video_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=1)
            _session_active = True
            await ws.send_text(json.dumps({"type": "session_started"}))
            logger.info("[DEBUG] session_started sent to source + broadcasting to %d viewers", len(_viewer_clients))
            await _broadcast_to_viewers({"type": "session_started"})

            source_send_task = asyncio.create_task(
                _forward_source_to_gemini(ws, session, video_queue)
            )
            video_send_task = asyncio.create_task(
                _forward_video_to_gemini(session, video_queue)
            )
            control_send_task = asyncio.create_task(
                _forward_viewer_commands_to_gemini(session)
            )
            recv_task = asyncio.create_task(_forward_gemini_to_clients(ws, session))

            done, pending = await asyncio.wait(
                [source_send_task, video_send_task, control_send_task, recv_task],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
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
        _session_active = False
        try:
            await ws.close()
        except Exception:
            pass
        async with _source_lock:
            _source_connected = False
            _source_last_seen_monotonic = 0.0
        logger.info("Gemini Live session closed")
        await _broadcast_to_viewers({"type": "source_disconnected"})


async def _viewer_loop(ws: WebSocket) -> None:
    await ws.accept()
    async with _viewer_lock:
        _viewer_clients.add(ws)
    logger.info("[DEBUG] Viewer ACCEPTED  client=%s  total_viewers=%d", ws.client, len(_viewer_clients))

    try:
        logger.info(
            "[DEBUG] Sending viewer_connected  source_connected=%s  session_active=%s",
            _source_connected, _session_active,
        )
        await ws.send_text(json.dumps({
            "type": "viewer_connected",
            "source_connected": _source_connected,
            "session_active": _session_active,
        }))
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

            elif msg_type == "audio":
                b64_data = msg.get("data", "")
                if b64_data and _source_connected:
                    await _control_queue.put({"type": "audio", "data": b64_data})

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
    video_queue: asyncio.Queue[str],
) -> None:
    """Read messages from source WS and forward video to Gemini Live."""
    global _source_last_seen_monotonic, _last_preview_sent_monotonic
    frame_count = 0
    while True:
        raw = await ws.receive_text()
        _source_last_seen_monotonic = time.monotonic()
        msg = json.loads(raw)
        msg_type = msg.get("type")

        if msg_type == "video":
            frame_count += 1
            b64_data = msg["data"]
            n_viewers = len(_viewer_clients)
            if frame_count <= 3 or frame_count % 10 == 0:
                logger.info(
                    "[DEBUG] video frame #%d received from source  "
                    "b64_len=%d  viewers=%d",
                    frame_count,
                    len(b64_data),
                    n_viewers,
                )
            if _viewer_clients:
                now = time.monotonic()
                min_interval = 1.0 / max(_PREVIEW_MAX_FPS, 0.1)
                if now - _last_preview_sent_monotonic >= min_interval:
                    _last_preview_sent_monotonic = now
                    await _broadcast_to_viewers({"type": "video_preview", "data": b64_data})
            _offer_latest_video_frame(video_queue, b64_data)

        elif msg_type == "audio":
            logger.warning(
                "Ignoring audio from source client. Use browser viewer mic for Live audio input."
            )

        elif msg_type == "text":
            text = str(msg.get("text", "")).strip()
            if text:
                await session.send_client_content(
                    turns=types.Content(parts=[types.Part(text=text)]),
                    turn_complete=True,
                )

        elif msg_type == "end_audio_stream":
            logger.warning("Ignoring end_audio_stream from source client.")


async def _forward_video_to_gemini(
    session,
    video_queue: asyncio.Queue[str],
) -> None:
    """Forward only the newest queued frame to Gemini to avoid stale-frame lag."""
    while True:
        b64_data = await video_queue.get()
        await session.send_realtime_input(
            video=types.Blob(
                mime_type="image/jpeg",
                data=base64.b64decode(b64_data),
            )
        )


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
        elif msg_type == "audio":
            b64_data = command.get("data", "")
            if b64_data:
                await session.send_realtime_input(
                    audio=types.Blob(
                        data=base64.b64decode(b64_data),
                        mime_type="audio/pcm;rate=16000",
                    )
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
            sent_text_chunk = False

            if data := response.data:
                payload = {
                    "type": "audio",
                    "data": base64.b64encode(data).decode("ascii"),
                }
                await ws.send_text(json.dumps(payload))
                await _broadcast_to_viewers(payload)

            if text := response.text:
                payload = {
                    "type": "text",
                    "text": text,
                }
                await ws.send_text(json.dumps(payload))
                await _broadcast_to_viewers(payload)
                sent_text_chunk = True

            sc = response.server_content

            if sc and sc.input_transcription:
                input_text = str(getattr(sc.input_transcription, "text", "") or "").strip()
                input_finished = bool(getattr(sc.input_transcription, "finished", False))
                if input_text and input_finished:
                    payload = {
                        "type": "input_transcription",
                        "text": input_text,
                    }
                    await ws.send_text(json.dumps(payload))
                    await _broadcast_to_viewers(payload)

            if sc and sc.output_transcription and not sent_text_chunk:
                output_text = str(getattr(sc.output_transcription, "text", "") or "").strip()
                output_finished = bool(getattr(sc.output_transcription, "finished", False))
                if output_text and output_finished:
                    payload = {
                        "type": "text",
                        "text": output_text,
                    }
                    await ws.send_text(json.dumps(payload))
                    await _broadcast_to_viewers(payload)

            if sc and getattr(sc, "interrupted", False):
                payload = {"type": "interrupted"}
                await ws.send_text(json.dumps(payload))
                await _broadcast_to_viewers(payload)

            if sc and getattr(sc, "turn_complete", False):
                payload = {"type": "turn_complete"}
                await ws.send_text(json.dumps(payload))
                await _broadcast_to_viewers(payload)


async def _broadcast_to_viewers(payload: dict) -> None:
    msg_type = payload.get("type", "?")
    raw = json.dumps(payload)
    async with _viewer_lock:
        viewers = list(_viewer_clients)

    if msg_type != "video_preview":
        logger.info("[DEBUG] broadcast  type=%s  to %d viewer(s)", msg_type, len(viewers))

    stale: list[WebSocket] = []
    for viewer in viewers:
        try:
            await viewer.send_text(raw)
        except Exception as exc:
            logger.warning("[DEBUG] broadcast to viewer failed: %s", exc)
            stale.append(viewer)

    if stale:
        async with _viewer_lock:
            for viewer in stale:
                _viewer_clients.discard(viewer)
        logger.info("[DEBUG] removed %d stale viewer(s)", len(stale))
