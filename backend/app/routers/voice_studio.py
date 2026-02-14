"""Voice Studio API endpoints."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..config import ELEVENLABS_VOICE_ID
from ..database import get_db
from ..models import User, VoiceProfile
from ..services.elevenlabs_voices import fetch_voices
from ..services.tts import synthesize_async

router = APIRouter(prefix="/voice-studio", tags=["voice-studio"])


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
    stability: float = Field(0.5, ge=0.0, le=1.0)
    clarity: float = Field(0.75, ge=0.0, le=1.0)
    style_exaggeration: float = Field(0.0, ge=0.0, le=1.0)
    playback_speed: float = Field(1.0, ge=0.5, le=2.0)


class VoiceProfileResponse(VoiceProfileIn):
    profile_id: Optional[int] = None
    user_id: Optional[int] = None
    is_active: bool = True
    updated_at: Optional[datetime] = None


class VoicePreviewRequest(VoiceProfileIn):
    text: str = Field(..., min_length=1, max_length=320)


def _default_profile() -> VoiceProfileResponse:
    return VoiceProfileResponse(
        voice_id=ELEVENLABS_VOICE_ID,
        stability=0.5,
        clarity=0.75,
        style_exaggeration=0.0,
        playback_speed=1.0,
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

    db.query(VoiceProfile).update({VoiceProfile.is_active: False})

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
    )
    if not audio:
        return Response(content=b"", status_code=204)
    return Response(content=audio, media_type="audio/mpeg")
