"""Text-to-speech service using ElevenLabs."""
from __future__ import annotations

from typing import Any, Optional

import httpx

from ..config import (
    ELEVENLABS_API_KEY,
    ELEVENLABS_DEFAULT_CLARITY,
    ELEVENLABS_DEFAULT_LANGUAGE_CODE,
    ELEVENLABS_DEFAULT_PLAYBACK_SPEED,
    ELEVENLABS_DEFAULT_SEED,
    ELEVENLABS_DEFAULT_STABILITY,
    ELEVENLABS_DEFAULT_STYLE_EXAGGERATION,
    ELEVENLABS_DEFAULT_USE_SPEAKER_BOOST,
    ELEVENLABS_MODEL,
    ELEVENLABS_OPTIMIZE_STREAMING_LATENCY,
    ELEVENLABS_OUTPUT_FORMAT,
    ELEVENLABS_TEXT_NORMALIZATION,
    ELEVENLABS_TTS_URL,
    ELEVENLABS_VOICE_ID,
)
from ..database import SessionLocal
from ..models import VoiceProfile

_http: Optional[httpx.AsyncClient] = None
_no_key_warned = False
_TEXT_NORMALIZATION_VALUES = {"auto", "on", "off"}


def _get_http() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=10.0)
    return _http


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return default


def _as_optional_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _as_optional_str(value: Any) -> Optional[str]:
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned or None
    return None


def _as_optional_str_list(value: Any) -> Optional[list[str]]:
    if not isinstance(value, list):
        return None
    cleaned = [item.strip() for item in value if isinstance(item, str) and item.strip()]
    return cleaned or None


def _normalize_text_normalization(value: Any) -> Optional[str]:
    raw = _as_optional_str(value)
    if not raw:
        return None
    lowered = raw.lower()
    if lowered in _TEXT_NORMALIZATION_VALUES:
        return lowered
    return None


def _resolve_advanced_options(advanced_options: Optional[dict[str, Any]]) -> dict[str, Any]:
    options = advanced_options or {}
    default_seed = None if ELEVENLABS_DEFAULT_SEED < 0 else ELEVENLABS_DEFAULT_SEED
    default_text_norm = _normalize_text_normalization(ELEVENLABS_TEXT_NORMALIZATION)
    default_lang = _as_optional_str(ELEVENLABS_DEFAULT_LANGUAGE_CODE)

    return {
        "model_id": _as_optional_str(options.get("model_id")) or ELEVENLABS_MODEL,
        "output_format": _as_optional_str(options.get("output_format")) or ELEVENLABS_OUTPUT_FORMAT,
        "optimize_streaming_latency": _as_optional_str(options.get("optimize_streaming_latency"))
        or ELEVENLABS_OPTIMIZE_STREAMING_LATENCY,
        "language_code": _as_optional_str(options.get("language_code")) or default_lang,
        "seed": _as_optional_int(options.get("seed")) if options.get("seed") is not None else default_seed,
        "apply_text_normalization": (
            _normalize_text_normalization(options.get("apply_text_normalization")) or default_text_norm
        ),
        "previous_text": _as_optional_str(options.get("previous_text")),
        "next_text": _as_optional_str(options.get("next_text")),
        "previous_request_ids": _as_optional_str_list(options.get("previous_request_ids")),
        "next_request_ids": _as_optional_str_list(options.get("next_request_ids")),
        "enable_logging": (
            _as_bool(options.get("enable_logging"), True)
            if options.get("enable_logging") is not None
            else None
        ),
        "stream": _as_bool(options.get("stream"), True),
        "use_speaker_boost": (
            _as_bool(options.get("use_speaker_boost"), ELEVENLABS_DEFAULT_USE_SPEAKER_BOOST)
            if options.get("use_speaker_boost") is not None
            else ELEVENLABS_DEFAULT_USE_SPEAKER_BOOST
        ),
    }


def _resolve_active_profile(user_id: Optional[int] = None) -> dict[str, Any]:
    defaults = {
        "voice_id": ELEVENLABS_VOICE_ID,
        "stability": ELEVENLABS_DEFAULT_STABILITY,
        "clarity": ELEVENLABS_DEFAULT_CLARITY,
        "style_exaggeration": ELEVENLABS_DEFAULT_STYLE_EXAGGERATION,
        "playback_speed": ELEVENLABS_DEFAULT_PLAYBACK_SPEED,
    }
    db = SessionLocal()
    try:
        query = db.query(VoiceProfile)
        if user_id is not None:
            profile = query.filter(VoiceProfile.user_id == user_id).first()
        else:
            profile = (
                query.filter(VoiceProfile.is_active.is_(True))
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
    advanced_options: dict[str, Any],
    override_settings: Optional[dict[str, Any]] = None,
    override_speed: Optional[float] = None,
) -> dict[str, Any]:
    settings = override_settings or {}
    stability = float(settings.get("stability", profile["stability"]))
    clarity = float(settings.get("clarity", settings.get("similarity_boost", profile["clarity"])))
    style = float(settings.get("style_exaggeration", settings.get("style", profile["style_exaggeration"])))
    speed = float(profile["playback_speed"] if override_speed is None else override_speed)
    use_speaker_boost = (
        _as_bool(settings.get("use_speaker_boost"), advanced_options["use_speaker_boost"])
        if "use_speaker_boost" in settings
        else advanced_options["use_speaker_boost"]
    )

    return {
        "stability": _clamp(stability, 0.0, 1.0),
        "similarity_boost": _clamp(clarity, 0.0, 1.0),
        "style": _clamp(style, 0.0, 1.0),
        "speed": _clamp(speed, 0.5, 2.0),
        "use_speaker_boost": bool(use_speaker_boost),
    }


def _build_payload(
    text: str,
    voice_settings: dict[str, Any],
    options: dict[str, Any],
    include_advanced: bool,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "text": text,
        "model_id": options["model_id"],
        "voice_settings": voice_settings,
    }

    if not include_advanced:
        return payload

    if options["language_code"]:
        payload["language_code"] = options["language_code"]
    if options["seed"] is not None:
        payload["seed"] = options["seed"]
    if options["apply_text_normalization"]:
        payload["apply_text_normalization"] = options["apply_text_normalization"]
    if options["previous_text"]:
        payload["previous_text"] = options["previous_text"]
    if options["next_text"]:
        payload["next_text"] = options["next_text"]
    if options["previous_request_ids"]:
        payload["previous_request_ids"] = options["previous_request_ids"]
    if options["next_request_ids"]:
        payload["next_request_ids"] = options["next_request_ids"]
    return payload


def _build_params(options: dict[str, Any]) -> dict[str, str]:
    params = {
        "output_format": options["output_format"],
        "optimize_streaming_latency": options["optimize_streaming_latency"],
    }
    if options["enable_logging"] is not None:
        params["enable_logging"] = "true" if options["enable_logging"] else "false"
    return params


def _build_url(voice: str, options: dict[str, Any]) -> str:
    suffix = "/stream" if options["stream"] else ""
    return f"{ELEVENLABS_TTS_URL}/{voice}{suffix}"


async def _post_with_fallback_async(
    *,
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    params: dict[str, str],
    text: str,
    options: dict[str, Any],
    full_settings: dict[str, Any],
) -> httpx.Response:
    full_payload = _build_payload(text, full_settings, options, include_advanced=True)
    resp = await client.post(url, json=full_payload, headers=headers, params=params)
    if resp.status_code < 400:
        return resp

    simpler_payload = _build_payload(text, full_settings, options, include_advanced=False)
    resp = await client.post(url, json=simpler_payload, headers=headers, params=params)
    if resp.status_code < 400:
        return resp

    fallback_settings = {
        "stability": full_settings["stability"],
        "similarity_boost": full_settings["similarity_boost"],
    }
    fallback_payload = _build_payload(text, fallback_settings, options, include_advanced=False)
    return await client.post(url, json=fallback_payload, headers=headers, params=params)


def _post_with_fallback_sync(
    *,
    client: httpx.Client,
    url: str,
    headers: dict[str, str],
    params: dict[str, str],
    text: str,
    options: dict[str, Any],
    full_settings: dict[str, Any],
) -> httpx.Response:
    full_payload = _build_payload(text, full_settings, options, include_advanced=True)
    resp = client.post(url, json=full_payload, headers=headers, params=params)
    if resp.status_code < 400:
        return resp

    simpler_payload = _build_payload(text, full_settings, options, include_advanced=False)
    resp = client.post(url, json=simpler_payload, headers=headers, params=params)
    if resp.status_code < 400:
        return resp

    fallback_settings = {
        "stability": full_settings["stability"],
        "similarity_boost": full_settings["similarity_boost"],
    }
    fallback_payload = _build_payload(text, fallback_settings, options, include_advanced=False)
    return client.post(url, json=fallback_payload, headers=headers, params=params)


async def synthesize_async(
    text: str,
    voice_id: Optional[str] = None,
    voice_settings: Optional[dict[str, Any]] = None,
    playback_speed: Optional[float] = None,
    advanced_options: Optional[dict[str, Any]] = None,
    user_id: Optional[int] = None,
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

    profile = _resolve_active_profile(user_id=user_id)
    options = _resolve_advanced_options(advanced_options)
    voice = voice_id or profile["voice_id"] or ELEVENLABS_VOICE_ID
    url = _build_url(voice, options)
    params = _build_params(options)
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    full_settings = _build_voice_settings(profile, options, voice_settings, playback_speed)

    try:
        client = _get_http()
        resp = await _post_with_fallback_async(
            client=client,
            url=url,
            headers=headers,
            params=params,
            text=text,
            options=options,
            full_settings=full_settings,
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
    voice_settings: Optional[dict[str, Any]] = None,
    playback_speed: Optional[float] = None,
    advanced_options: Optional[dict[str, Any]] = None,
    user_id: Optional[int] = None,
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

    profile = _resolve_active_profile(user_id=user_id)
    options = _resolve_advanced_options(advanced_options)
    voice = voice_id or profile["voice_id"] or ELEVENLABS_VOICE_ID
    url = _build_url(voice, options)
    params = _build_params(options)
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    full_settings = _build_voice_settings(profile, options, voice_settings, playback_speed)

    try:
        with httpx.Client(timeout=15.0) as client:
            resp = _post_with_fallback_sync(
                client=client,
                url=url,
                headers=headers,
                params=params,
                text=text,
                options=options,
                full_settings=full_settings,
            )
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
