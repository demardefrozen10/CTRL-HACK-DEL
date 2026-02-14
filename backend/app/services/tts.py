"""Text-to-speech service using ElevenLabs."""
from __future__ import annotations

import asyncio
import io
from typing import Optional

import httpx

from ..config import ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID

_http: Optional[httpx.AsyncClient] = None
_no_key_warned = False


def _get_http() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=10.0)
    return _http


async def synthesize_async(text: str, voice_id: Optional[str] = None) -> Optional[bytes]:
    """
    Asynchronously synthesize text to speech using ElevenLabs.
    Returns raw audio bytes (mp3) or None on failure.
    """
    global _no_key_warned
    if not text:
        return None
    if not ELEVENLABS_API_KEY:
        if not _no_key_warned:
            print("[TTS] No API key configured, TTS disabled")
            _no_key_warned = True
        return None

    voice = voice_id or ELEVENLABS_VOICE_ID
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice}"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
    }
    payload = {
        "text": text,
        "model_id": "eleven_flash_v2_5",
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75,
        },
    }

    try:
        client = _get_http()
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code == 200:
            return resp.content
        else:
            print(f"[TTS] ElevenLabs error {resp.status_code}: {resp.text[:200]}")
            return None
    except Exception as exc:
        print(f"[TTS] Error: {exc}")
        return None


def synthesize_sync(text: str, voice_id: Optional[str] = None) -> Optional[bytes]:
    """
    Synchronously synthesize text to speech using ElevenLabs.
    Returns raw audio bytes (mp3) or None on failure.
    """
    global _no_key_warned
    if not text:
        return None
    if not ELEVENLABS_API_KEY:
        if not _no_key_warned:
            print("[TTS] No API key configured, TTS disabled")
            _no_key_warned = True
        return None

    try:
        from elevenlabs.client import ElevenLabs
        client = ElevenLabs(api_key=ELEVENLABS_API_KEY)
        voice = voice_id or ELEVENLABS_VOICE_ID
        
        audio_iter = client.text_to_speech.convert(
            text=text,
            voice_id=voice,
            model_id="eleven_flash_v2_5",
            output_format="mp3_22050_32",
        )
        buf = io.BytesIO()
        for chunk in audio_iter:
            buf.write(chunk)
        return buf.getvalue()
    except ImportError:
        print("[TTS] elevenlabs package not installed, using async fallback")
        return asyncio.run(synthesize_async(text, voice_id))
    except Exception as e:
        print(f"[TTS] synthesis error: {e}")
        return None


async def speak(text: str) -> None:
    """Synthesize and (optionally) play audio."""
    audio = await synthesize_async(text)
    if audio:
        # Audio playback can be handled by the client
        pass
