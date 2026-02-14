"""Voice catalog helpers for ElevenLabs Voice Studio."""
from __future__ import annotations

from typing import Any, Optional

import httpx

from ..config import ELEVENLABS_API_KEY


def _first_str(*values: Any) -> Optional[str]:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _normalize_gender(raw: Optional[str]) -> str:
    if not raw:
        return "any"
    value = raw.lower().strip()
    if value in {"male", "female", "neutral"}:
        return value
    return "any"


def _normalize_age(raw: Optional[str]) -> str:
    if not raw:
        return "any"
    value = raw.lower().strip().replace("-", " ").replace("_", " ")
    if "middle" in value:
        return "middle_aged"
    if "young" in value:
        return "young"
    if "old" in value:
        return "old"
    return "any"


def _normalize_notice_period(raw: Optional[str]) -> str:
    if not raw:
        return "any"
    value = raw.lower().replace(" ", "")
    if "30" in value:
        return "30d"
    if "90" in value:
        return "90d"
    if "1y" in value or "1year" in value or "12m" in value:
        return "1y"
    return "any"


def _as_bool(raw: Any) -> Optional[bool]:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        value = raw.strip().lower()
        if value in {"true", "yes", "1", "enabled"}:
            return True
        if value in {"false", "no", "0", "disabled"}:
            return False
    if isinstance(raw, (int, float)):
        if raw == 1:
            return True
        if raw == 0:
            return False
    return None


def _extract_custom_rates(voice: dict[str, Any]) -> Optional[bool]:
    sharing = voice.get("sharing") or {}
    permission = voice.get("permission_on_resource") or {}
    candidates = [
        voice.get("custom_rates"),
        voice.get("has_custom_rates"),
        voice.get("allow_custom_rates"),
        sharing.get("custom_rates"),
        sharing.get("has_custom_rates"),
        sharing.get("allow_custom_rates"),
        permission.get("custom_rates"),
        permission.get("has_custom_rates"),
        permission.get("allow_custom_rates"),
    ]
    for candidate in candidates:
        parsed = _as_bool(candidate)
        if parsed is not None:
            return parsed
    return None


def _extract_live_moderation(voice: dict[str, Any]) -> Optional[bool]:
    safety = voice.get("safety_control") or {}
    sharing = voice.get("sharing") or {}
    candidates = [
        voice.get("live_moderation"),
        voice.get("live_moderation_enabled"),
        voice.get("requires_live_moderation"),
        sharing.get("live_moderation"),
        sharing.get("live_moderation_enabled"),
        safety.get("enabled") if isinstance(safety, dict) else None,
        safety.get("live_moderation") if isinstance(safety, dict) else None,
    ]
    for candidate in candidates:
        parsed = _as_bool(candidate)
        if parsed is not None:
            return parsed
    return None


def normalize_voice(voice: dict[str, Any]) -> dict[str, Any]:
    labels = voice.get("labels") or {}
    sharing = voice.get("sharing") or {}
    quality = "hq" if bool(voice.get("high_quality_base_model_ids")) else "any"
    notice_period = _normalize_notice_period(
        _first_str(
            labels.get("notice_period"),
            labels.get("notice"),
            voice.get("notice_period"),
            sharing.get("notice_period"),
        )
    )

    return {
        "voice_id": str(voice.get("voice_id", "")),
        "name": str(voice.get("name", "Unnamed Voice")),
        "category": str(voice.get("category", "unknown")),
        "preview_url": voice.get("preview_url"),
        "quality": quality,
        "gender": _normalize_gender(_first_str(labels.get("gender"))),
        "age": _normalize_age(_first_str(labels.get("age"))),
        "notice_period": notice_period,
        "custom_rates": _extract_custom_rates(voice),
        "live_moderation": _extract_live_moderation(voice),
        "descriptive": _first_str(labels.get("descriptive"), voice.get("description")),
    }


async def fetch_voices() -> list[dict[str, Any]]:
    """Fetch and normalize voices from ElevenLabs."""
    if not ELEVENLABS_API_KEY:
        raise RuntimeError("ELEVENLABS_API_KEY is not configured")

    headers = {"xi-api-key": ELEVENLABS_API_KEY}
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get("https://api.elevenlabs.io/v1/voices", headers=headers)
    response.raise_for_status()
    payload = response.json()
    voices = payload.get("voices", [])
    normalized = [normalize_voice(voice) for voice in voices if isinstance(voice, dict)]
    return sorted(normalized, key=lambda voice: voice["name"].lower())
