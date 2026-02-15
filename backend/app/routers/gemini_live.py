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
from dataclasses import dataclass
import json
import logging
import os
import re

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from ..auth import get_user_from_token
from ..config import GEMINI_API_KEY as CONFIG_GEMINI_API_KEY
from ..database import SessionLocal
from ..services.tts import synthesize_async

try:
    from google import genai
    from google.genai import types
    _genai_import_error: str | None = None
except Exception as exc:
    genai = None  # type: ignore[assignment]
    types = None  # type: ignore[assignment]
    _genai_import_error = str(exc)

logger = logging.getLogger("echo-sight.gemini-live")

router = APIRouter(tags=["gemini-live"])

# ---------------------------------------------------------------------------
# Gemini Live session configuration
# ---------------------------------------------------------------------------
MODEL = "gemini-2.5-flash-native-audio-latest"

SYSTEM_INSTRUCTION = ( ""
    
)


@dataclass
class LiveVoiceSettings:
    voice_provider: str = "gemini"  # "gemini" | "elevenlabs"


def _normalize_transcript_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _build_config():
    """Build the Gemini Live session config."""
    if types is None:
        raise RuntimeError(
            "google-genai package is required for Gemini Live. "
            f"Import failure: {_genai_import_error or 'unknown'}"
        )
    return types.LiveConnectConfig(
        # Native-audio models accept AUDIO modality here. Text comes through
        # output_audio_transcription and text parts in server content.
        response_modalities=["AUDIO"],
        system_instruction=types.Content(
            parts=[types.Part(text=SYSTEM_INSTRUCTION)]
        ),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        thinking_config=types.ThinkingConfig(
            include_thoughts=False,
            thinking_budget=0,
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

    if genai is None:
        await ws.send_text(json.dumps({
            "type": "error",
            "message": (
                "Gemini Live dependency missing on server. "
                "Install 'google-genai' in backend venv."
            ),
        }))
        await ws.close()
        return

    # Pull from loaded config first so .env is honored even when module import order differs.
    gemini_api_key = (CONFIG_GEMINI_API_KEY or os.getenv("GEMINI_API_KEY", "")).strip()
    if not gemini_api_key:
        await ws.send_text(json.dumps({
            "type": "error",
            "message": "GEMINI_API_KEY is not configured on the server.",
        }))
        await ws.close()
        return

    client = genai.Client(
        api_key=gemini_api_key,
        http_options={"api_version": "v1beta"},
    )

    config = _build_config()
    voice_settings = LiveVoiceSettings()
    user_id: int | None = None
    token = ws.query_params.get("token")
    if token:
        db = SessionLocal()
        try:
            user = get_user_from_token(db, token)
            if user is not None:
                user_id = int(user.id)
        finally:
            db.close()

    try:
        async with client.aio.live.connect(model=MODEL, config=config) as session:
            logger.info("Gemini Live session opened")
            await ws.send_text(json.dumps({"type": "session_started"}))
            await ws.send_text(
                json.dumps(
                    {
                        "type": "settings_ack",
                        "voice_provider": voice_settings.voice_provider,
                        "voice_customization_enabled": bool(user_id is not None),
                    }
                )
            )

            # Run send + receive concurrently
            send_task = asyncio.create_task(_forward_browser_to_gemini(ws, session, voice_settings))
            recv_task = asyncio.create_task(
                _forward_gemini_to_browser(
                    ws,
                    session,
                    voice_settings,
                    user_id=user_id,
                )
            )

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
    voice_settings: LiveVoiceSettings,
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
            text = str(msg.get("text", "")).strip()
            if not text:
                continue
            # Force question priority over passive guidance for this turn.
            prompt = f"User question (priority): {text}"
            await session.send_client_content(
                turns=[types.Content(role="user", parts=[types.Part(text=prompt)])],
                turn_complete=True,
            )

        elif msg_type == "end_audio_stream":
            await session.send_realtime_input(audio_stream_end=True)

        elif msg_type == "settings":
            provider = str(msg.get("voice_provider", "")).strip().lower()
            if provider in {"gemini", "elevenlabs"}:
                voice_settings.voice_provider = provider
            await ws.send_text(
                json.dumps(
                    {
                        "type": "settings_ack",
                        "voice_provider": voice_settings.voice_provider,
                    }
                )
            )


async def _forward_gemini_to_browser(
    ws: WebSocket,
    session,
    voice_settings: LiveVoiceSettings,
    *,
    user_id: int | None = None,
) -> None:
    """Read responses from Gemini Live and forward to the browser WS."""
    turn_text_chunks: list[str] = []
    while True:
        turn = session.receive()
        async for response in turn:
            # Audio data
            if data := response.data:
                # Send raw PCM audio as base64 to browser
                if voice_settings.voice_provider != "elevenlabs":
                    await ws.send_text(json.dumps({
                        "type": "audio",
                        "data": base64.b64encode(data).decode("ascii"),
                    }))

            # Text content from output transcription chunks.
            sc = getattr(response, "server_content", None)
            output_tx = getattr(sc, "output_transcription", None) if sc else None
            output_tx_text = getattr(output_tx, "text", None) if output_tx else None
            if output_tx_text and str(output_tx_text).strip():
                turn_text_chunks.append(str(output_tx_text))
                await ws.send_text(json.dumps({
                    "type": "text",
                    "text": str(output_tx_text).strip(),
                }))

            # Check for interruption
            sc = response.server_content
            if sc and getattr(sc, "interrupted", False):
                await ws.send_text(json.dumps({"type": "interrupted"}))

            # Turn complete
            sc = response.server_content
            if sc and getattr(sc, "turn_complete", False):
                if voice_settings.voice_provider == "elevenlabs":
                    transcript_text = _normalize_transcript_text("".join(turn_text_chunks))
                    if transcript_text:
                        mp3_audio = await synthesize_async(transcript_text, user_id=user_id)
                        if mp3_audio:
                            await ws.send_text(
                                json.dumps(
                                    {
                                        "type": "audio_mp3",
                                        "data": base64.b64encode(mp3_audio).decode("ascii"),
                                    }
                                )
                            )
                        else:
                            await ws.send_text(
                                json.dumps(
                                    {
                                        "type": "warning",
                                        "message": "ElevenLabs voice generation failed for this response.",
                                    }
                                )
                            )
                turn_text_chunks.clear()
                await ws.send_text(json.dumps({"type": "turn_complete"}))
