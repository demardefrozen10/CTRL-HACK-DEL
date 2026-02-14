"""Text-to-speech service using ElevenLabs."""
from __future__ import annotations

from typing import Any, Optional

import httpx

from ..config import ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
from ..database import SessionLocal
from ..models import VoiceProfile

_http: Optional[httpx.AsyncClient] = None
_no_key_warned = False


def _get_http() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=10.0)
    return _http


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _resolve_active_profile() -> dict[str, Any]:
    defaults = {
        "voice_id": ELEVENLABS_VOICE_ID,
        "stability": 0.5,
        "clarity": 0.75,
        "style_exaggeration": 0.0,
        "playback_speed": 1.0,
    }
    db = SessionLocal()
    try:
        profile = (
            db.query(VoiceProfile)
            .filter(VoiceProfile.is_active.is_(True))
            .order_by(VoiceProfile.updated_at.desc(), VoiceProfile.id.desc())
            .first()
        )
        if profile is None:
            return defaults
        return {
            "voice_id": profile.voice_id or ELEVENLABS_VOICE_ID,
            "stability": float(profile.stability),
            "clarity": float(profile.clarity),
            "style_exaggeration": float(profile.style_exaggeration),
            "playback_speed": float(profile.playback_speed),
        }
    except Exception:
        return defaults
    finally:
        db.close()


def _build_voice_settings(
    profile: dict[str, Any],
    override_settings: Optional[dict[str, float]] = None,
    override_speed: Optional[float] = None,
) -> dict[str, float]:
    settings = override_settings or {}
    stability = float(settings.get("stability", profile["stability"]))
    clarity = float(settings.get("clarity", settings.get("similarity_boost", profile["clarity"])))
    style = float(settings.get("style_exaggeration", settings.get("style", profile["style_exaggeration"])))
    speed = float(profile["playback_speed"] if override_speed is None else override_speed)

    return {
        "stability": _clamp(stability, 0.0, 1.0),
        "similarity_boost": _clamp(clarity, 0.0, 1.0),
        "style": _clamp(style, 0.0, 1.0),
        "speed": _clamp(speed, 0.5, 2.0),
    }


def _build_payload(
    text: str,
    voice_settings: dict[str, float],
) -> dict[str, Any]:
    return {
        "text": text,
        "model_id": "eleven_flash_v2_5",
        "voice_settings": voice_settings,
    }


async def synthesize_async(
    text: str,
    voice_id: Optional[str] = None,
    voice_settings: Optional[dict[str, float]] = None,
    playback_speed: Optional[float] = None,
) -> Optional[bytes]:
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

    profile = _resolve_active_profile()
    voice = voice_id or profile["voice_id"] or ELEVENLABS_VOICE_ID
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice}"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
    }
    full_settings = _build_voice_settings(profile, voice_settings, playback_speed)
    payload = _build_payload(text, full_settings)

    try:
        client = _get_http()
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code >= 400 and ("style" in full_settings or "speed" in full_settings):
            fallback_settings = {
                "stability": full_settings["stability"],
                "similarity_boost": full_settings["similarity_boost"],
            }
            resp = await client.post(
                url,
                json=_build_payload(text, fallback_settings),
                headers=headers,
            )
        if resp.status_code == 200:
            return resp.content
        print(f"[TTS] ElevenLabs error {resp.status_code}: {resp.text[:200]}")
        return None
    except Exception as exc:
        print(f"[TTS] Error: {exc}")
        return None


def synthesize_sync(
    text: str,
    voice_id: Optional[str] = None,
    voice_settings: Optional[dict[str, float]] = None,
    playback_speed: Optional[float] = None,
) -> Optional[bytes]:
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

    profile = _resolve_active_profile()
    voice = voice_id or profile["voice_id"] or ELEVENLABS_VOICE_ID
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice}"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
    }
    full_settings = _build_voice_settings(profile, voice_settings, playback_speed)
    payload = _build_payload(text, full_settings)

    try:
        with httpx.Client(timeout=15.0) as client:
            resp = client.post(url, json=payload, headers=headers)
            if resp.status_code >= 400 and ("style" in full_settings or "speed" in full_settings):
                fallback_settings = {
                    "stability": full_settings["stability"],
                    "similarity_boost": full_settings["similarity_boost"],
                }
                resp = client.post(url, json=_build_payload(text, fallback_settings), headers=headers)
        if resp.status_code == 200:
            return resp.content
        print(f"[TTS] ElevenLabs error {resp.status_code}: {resp.text[:200]}")
        return None
    except Exception as exc:
        print(f"[TTS] synthesis error: {exc}")
        return None


async def speak(text: str) -> None:
    """Synthesize and (optionally) play audio."""
    audio = await synthesize_async(text)
    if audio:
        # Audio playback can be handled by the client
        pass
