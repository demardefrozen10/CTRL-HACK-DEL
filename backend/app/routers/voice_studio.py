"""Voice Studio API endpoints."""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
import httpx
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..config import (
    ELEVENLABS_API_KEY,
    ELEVENLABS_DEFAULT_CLARITY,
    ELEVENLABS_DEFAULT_PLAYBACK_SPEED,
    ELEVENLABS_DEFAULT_STABILITY,
    ELEVENLABS_DEFAULT_STYLE_EXAGGERATION,
    ELEVENLABS_DEFAULT_USE_SPEAKER_BOOST,
    ELEVENLABS_MODEL,
    ELEVENLABS_OPTIMIZE_STREAMING_LATENCY,
    ELEVENLABS_OUTPUT_FORMAT,
    ELEVENLABS_TEXT_NORMALIZATION,
    ELEVENLABS_VOICE_ID,
)
from ..database import get_db
from ..models import User, VoiceProfile
from ..services.elevenlabs_voices import fetch_models, fetch_voices
from ..services.tts import synthesize_async

router = APIRouter(prefix="/voice-studio", tags=["voice-studio"])


def _unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


class VoiceCatalogItem(BaseModel):
    voice_id: str
    name: str
    category: str
    preview_url: Optional[str] = None
    quality: str
    gender: str
    age: str
    notice_period: str
    custom_rates: Optional[bool] = None
    live_moderation: Optional[bool] = None
    descriptive: Optional[str] = None


class VoiceCatalogResponse(BaseModel):
    voices: list[VoiceCatalogItem]


class VoiceProfileIn(BaseModel):
    voice_id: str = Field(..., min_length=1)
    stability: float = Field(ELEVENLABS_DEFAULT_STABILITY, ge=0.0, le=1.0)
    clarity: float = Field(ELEVENLABS_DEFAULT_CLARITY, ge=0.0, le=1.0)
    style_exaggeration: float = Field(ELEVENLABS_DEFAULT_STYLE_EXAGGERATION, ge=0.0, le=1.0)
    playback_speed: float = Field(ELEVENLABS_DEFAULT_PLAYBACK_SPEED, ge=0.5, le=2.0)


class VoiceProfileResponse(VoiceProfileIn):
    profile_id: Optional[int] = None
    user_id: Optional[int] = None
    is_active: bool = True
    updated_at: Optional[datetime] = None


class VoicePreviewRequest(VoiceProfileIn):
    text: str = Field(..., min_length=1, max_length=320)
    model_id: Optional[str] = Field(default=None, min_length=1, max_length=128)
    output_format: Optional[str] = Field(default=None, min_length=1, max_length=64)
    optimize_streaming_latency: Optional[str] = Field(default=None, pattern=r"^[0-4]$")
    use_speaker_boost: Optional[bool] = None
    apply_text_normalization: Optional[Literal["auto", "on", "off"]] = None
    language_code: Optional[str] = Field(default=None, min_length=2, max_length=16)
    seed: Optional[int] = None
    enable_logging: Optional[bool] = None
    stream: Optional[bool] = None


class VoiceCapabilitiesResponse(BaseModel):
    models: list[str]
    output_formats: list[str]
    optimize_streaming_latency: list[str]
    text_normalization: list[str]
    defaults: dict[str, object]


class ElevenLabsProbeResult(BaseModel):
    endpoint: str
    method: str
    status_code: int
    access: str


class ElevenLabsProbeResponse(BaseModel):
    key_configured: bool
    checks: list[ElevenLabsProbeResult]


def _default_profile() -> VoiceProfileResponse:
    return VoiceProfileResponse(
        voice_id=ELEVENLABS_VOICE_ID,
        stability=ELEVENLABS_DEFAULT_STABILITY,
        clarity=ELEVENLABS_DEFAULT_CLARITY,
        style_exaggeration=ELEVENLABS_DEFAULT_STYLE_EXAGGERATION,
        playback_speed=ELEVENLABS_DEFAULT_PLAYBACK_SPEED,
        is_active=True,
    )


def _to_profile_response(profile: VoiceProfile) -> VoiceProfileResponse:
    return VoiceProfileResponse(
        profile_id=profile.id,
        user_id=profile.user_id,
        voice_id=profile.voice_id,
        stability=float(profile.stability),
        clarity=float(profile.clarity),
        style_exaggeration=float(profile.style_exaggeration),
        playback_speed=float(profile.playback_speed),
        is_active=bool(profile.is_active),
        updated_at=profile.updated_at,
    )


def _payload_to_advanced_options(payload: VoicePreviewRequest) -> dict[str, object]:
    if hasattr(payload, "model_dump"):
        raw = payload.model_dump(exclude_none=True)
    else:
        raw = payload.dict(exclude_none=True)
    for key in (
        "text",
        "voice_id",
        "stability",
        "clarity",
        "style_exaggeration",
        "playback_speed",
    ):
        raw.pop(key, None)
    return raw


def _access_from_status(status_code: int) -> str:
    if status_code in {200, 201, 202, 204, 400, 404, 422}:
        return "granted"
    if status_code in {401, 403}:
        return "denied"
    return "unknown"


@router.get("/capabilities", response_model=VoiceCapabilitiesResponse)
async def voice_capabilities(current_user: User = Depends(get_current_user)):
    _ = current_user
    dynamic_models: list[str] = []
    try:
        dynamic_models = await fetch_models()
    except Exception:
        dynamic_models = []

    return VoiceCapabilitiesResponse(
        models=_unique([
            *dynamic_models,
            "eleven_flash_v2_5",
            "eleven_turbo_v2_5",
            "eleven_multilingual_v2",
            ELEVENLABS_MODEL,
        ]),
        output_formats=_unique([
            "mp3_22050_32",
            "mp3_44100_64",
            "mp3_44100_128",
            "pcm_16000",
            "pcm_22050",
            ELEVENLABS_OUTPUT_FORMAT,
        ]),
        optimize_streaming_latency=_unique(["0", "1", "2", "3", "4", ELEVENLABS_OPTIMIZE_STREAMING_LATENCY]),
        text_normalization=_unique(["auto", "on", "off", ELEVENLABS_TEXT_NORMALIZATION]),
        defaults={
            "model_id": ELEVENLABS_MODEL,
            "output_format": ELEVENLABS_OUTPUT_FORMAT,
            "optimize_streaming_latency": ELEVENLABS_OPTIMIZE_STREAMING_LATENCY,
            "use_speaker_boost": ELEVENLABS_DEFAULT_USE_SPEAKER_BOOST,
            "apply_text_normalization": ELEVENLABS_TEXT_NORMALIZATION,
        },
    )


@router.get("/voices", response_model=VoiceCatalogResponse)
async def get_voices(current_user: User = Depends(get_current_user)):
    _ = current_user
    try:
        voices = await fetch_voices()
        return VoiceCatalogResponse(voices=voices)
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to fetch voices: {exc}",
        )


@router.get("/profile", response_model=VoiceProfileResponse)
def get_profile(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    profile = db.query(VoiceProfile).filter(VoiceProfile.user_id == current_user.id).first()
    if profile is None:
        return _default_profile()
    return _to_profile_response(profile)


@router.put("/profile", response_model=VoiceProfileResponse)
def save_profile(
    payload: VoiceProfileIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    profile = db.query(VoiceProfile).filter(VoiceProfile.user_id == current_user.id).first()
    if profile is None:
        profile = VoiceProfile(user_id=current_user.id, voice_id=payload.voice_id)
        db.add(profile)

    profile.voice_id = payload.voice_id
    profile.stability = float(payload.stability)
    profile.clarity = float(payload.clarity)
    profile.style_exaggeration = float(payload.style_exaggeration)
    profile.playback_speed = float(payload.playback_speed)
    profile.is_active = True

    db.commit()
    db.refresh(profile)
    return _to_profile_response(profile)


@router.post("/preview")
async def preview_voice(
    payload: VoicePreviewRequest,
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    audio = await synthesize_async(
        text=payload.text,
        voice_id=payload.voice_id,
        voice_settings={
            "stability": payload.stability,
            "clarity": payload.clarity,
            "style_exaggeration": payload.style_exaggeration,
        },
        playback_speed=payload.playback_speed,
        advanced_options=_payload_to_advanced_options(payload),
    )
    if not audio:
        return Response(content=b"", status_code=204)
    return Response(content=audio, media_type="audio/mpeg")


@router.get("/permissions", response_model=ElevenLabsProbeResponse)
async def probe_permissions(current_user: User = Depends(get_current_user)):
    _ = current_user
    if not ELEVENLABS_API_KEY:
        return ElevenLabsProbeResponse(key_configured=False, checks=[])

    checks: list[ElevenLabsProbeResult] = []
    headers = {"xi-api-key": ELEVENLABS_API_KEY}
    routes = [
        ("GET", "https://api.elevenlabs.io/v1/voices"),
        ("GET", "https://api.elevenlabs.io/v1/models"),
        ("GET", "https://api.elevenlabs.io/v1/user"),
    ]

    async with httpx.AsyncClient(timeout=12.0) as client:
        for method, url in routes:
            try:
                response = await client.request(method, url, headers=headers)
                checks.append(
                    ElevenLabsProbeResult(
                        endpoint=url.rsplit("/", 1)[-1],
                        method=method,
                        status_code=response.status_code,
                        access=_access_from_status(response.status_code),
                    )
                )
            except Exception:
                checks.append(
                    ElevenLabsProbeResult(
                        endpoint=url.rsplit("/", 1)[-1],
                        method=method,
                        status_code=0,
                        access="unknown",
                    )
                )

    return ElevenLabsProbeResponse(key_configured=True, checks=checks)
