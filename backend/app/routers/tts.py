"""Text-to-Speech API endpoints."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..services import synthesize_async

router = APIRouter(prefix="/tts", tags=["tts"])


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=320)
    voice_id: Optional[str] = None
    stability: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    clarity: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    style_exaggeration: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    playback_speed: Optional[float] = Field(default=None, ge=0.5, le=2.0)
    model_id: Optional[str] = None
    output_format: Optional[str] = None
    optimize_streaming_latency: Optional[str] = Field(default=None, pattern=r"^[0-4]$")
    use_speaker_boost: Optional[bool] = None
    apply_text_normalization: Optional[str] = Field(default=None, pattern=r"^(auto|on|off)$")
    language_code: Optional[str] = None
    seed: Optional[int] = None
    enable_logging: Optional[bool] = None
    stream: Optional[bool] = None


def _build_voice_settings(request: TTSRequest) -> Optional[dict[str, object]]:
    settings: dict[str, object] = {}
    if request.stability is not None:
        settings["stability"] = float(request.stability)
    if request.clarity is not None:
        settings["clarity"] = float(request.clarity)
    if request.style_exaggeration is not None:
        settings["style_exaggeration"] = float(request.style_exaggeration)
    if request.use_speaker_boost is not None:
        settings["use_speaker_boost"] = bool(request.use_speaker_boost)
    return settings or None


def _build_advanced_options(request: TTSRequest) -> Optional[dict[str, object]]:
    options: dict[str, object] = {}
    for key in (
        "model_id",
        "output_format",
        "optimize_streaming_latency",
        "apply_text_normalization",
        "language_code",
        "seed",
        "enable_logging",
        "stream",
        "use_speaker_boost",
    ):
        value = getattr(request, key)
        if value is not None:
            options[key] = value
    return options or None


@router.get("")
async def tts_get(
    text: str,
    voice_id: Optional[str] = None,
    model_id: Optional[str] = None,
    output_format: Optional[str] = None,
    optimize_streaming_latency: Optional[str] = None,
    use_speaker_boost: Optional[bool] = None,
    apply_text_normalization: Optional[str] = None,
    language_code: Optional[str] = None,
    seed: Optional[int] = None,
    enable_logging: Optional[bool] = None,
    stream: Optional[bool] = None,
):
    """
    Synthesize text to speech (GET request).
    Returns audio/mpeg stream.
    """
    clean_text = (text or "").strip()
    if not clean_text:
        raise HTTPException(status_code=400, detail="Text is required")

    advanced_options: dict[str, object] = {}
    for key, value in {
        "model_id": model_id,
        "output_format": output_format,
        "optimize_streaming_latency": optimize_streaming_latency,
        "use_speaker_boost": use_speaker_boost,
        "apply_text_normalization": apply_text_normalization,
        "language_code": language_code,
        "seed": seed,
        "enable_logging": enable_logging,
        "stream": stream,
    }.items():
        if value is not None:
            advanced_options[key] = value

    audio = await synthesize_async(
        text=clean_text,
        voice_id=voice_id,
        advanced_options=advanced_options or None,
    )
    if audio:
        return Response(content=audio, media_type="audio/mpeg")
    return Response(content=b"", status_code=204)


@router.post("")
async def tts_post(request: TTSRequest):
    """
    Synthesize text to speech (POST request).
    Returns audio/mpeg stream.
    """
    if not request.text:
        raise HTTPException(status_code=400, detail="Text is required")

    audio = await synthesize_async(
        text=request.text.strip(),
        voice_id=request.voice_id,
        voice_settings=_build_voice_settings(request),
        playback_speed=request.playback_speed,
        advanced_options=_build_advanced_options(request),
    )
    if audio:
        return Response(content=audio, media_type="audio/mpeg")
    return Response(content=b"", status_code=204)
