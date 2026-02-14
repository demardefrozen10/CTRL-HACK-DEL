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
    """Proxy between browser WebSocket and Gemini Live API session."""
    await ws.accept()
    logger.info("Browser connected to /ws/live")

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

            # Run send + receive concurrently
            send_task = asyncio.create_task(_forward_browser_to_gemini(ws, session))
            recv_task = asyncio.create_task(_forward_gemini_to_browser(ws, session))

            done, pending = await asyncio.wait(
                [send_task, recv_task],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            # Propagate any exception from the completed task
            for task in done:
                task.result()

    except WebSocketDisconnect:
        logger.info("Browser disconnected from /ws/live")
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
        logger.info("Gemini Live session closed")


async def _forward_browser_to_gemini(
    ws: WebSocket,
    session,
) -> None:
    """Read messages from the browser WS and forward to Gemini Live."""
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


async def _forward_gemini_to_browser(
    ws: WebSocket,
    session,
) -> None:
    """Read responses from Gemini Live and forward to the browser WS."""
    while True:
        turn = session.receive()
        async for response in turn:
            # Audio data
            if data := response.data:
                # Send raw PCM audio as base64 to browser
                await ws.send_text(json.dumps({
                    "type": "audio",
                    "data": base64.b64encode(data).decode("ascii"),
                }))
                continue

            # Text content
            if text := response.text:
                await ws.send_text(json.dumps({
                    "type": "text",
                    "text": text,
                }))
                continue

            # Check for interruption
            sc = response.server_content
            if sc and getattr(sc, "interrupted", False):
                await ws.send_text(json.dumps({"type": "interrupted"}))

            # Turn complete
            sc = response.server_content
            if sc and getattr(sc, "turn_complete", False):
                await ws.send_text(json.dumps({"type": "turn_complete"}))
