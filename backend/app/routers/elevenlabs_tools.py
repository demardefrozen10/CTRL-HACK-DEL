"""Extra ElevenLabs feature endpoints for accessibility workflows."""
from __future__ import annotations

import json
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from ..auth import get_current_user
from ..config import (
    ELEVENLABS_API_KEY,
    ELEVENLABS_DEFAULT_USE_SPEAKER_BOOST,
    ELEVENLABS_MODEL,
    ELEVENLABS_STS_MODEL,
    ELEVENLABS_OPTIMIZE_STREAMING_LATENCY,
    ELEVENLABS_OUTPUT_FORMAT,
)
from ..models import User

router = APIRouter(prefix="/elevenlabs", tags=["elevenlabs"])

_ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1"


class SoundEffectsRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)
    duration_seconds: Optional[float] = Field(default=None, ge=0.5, le=22.0)
    prompt_influence: Optional[float] = Field(default=None, ge=0.0, le=1.0)


class TextToVoicePreviewRequest(BaseModel):
    voice_description: str = Field(..., min_length=10, max_length=500)
    text: str = Field(..., min_length=100, max_length=1000)


class TextToVoiceCreateRequest(BaseModel):
    voice_name: str = Field(..., min_length=1, max_length=80)
    voice_description: str = Field(..., min_length=1, max_length=500)
    generated_voice_id: str = Field(..., min_length=1, max_length=120)
    labels: Optional[dict[str, str]] = None
    played_not_selected_voice_ids: Optional[list[str]] = None


def _require_key() -> str:
    if not ELEVENLABS_API_KEY:
        raise HTTPException(status_code=503, detail="ELEVENLABS_API_KEY is not configured")
    return ELEVENLABS_API_KEY


def _error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            detail = payload.get("detail") or payload.get("message") or payload
        else:
            detail = payload
        text = json.dumps(detail)[:500]
    except Exception:
        text = response.text[:500]
    return f"ElevenLabs error {response.status_code}: {text}"


def _audio_media_type(output_format: str) -> str:
    if output_format.startswith("mp3_"):
        return "audio/mpeg"
    if output_format.startswith("ulaw_"):
        return "audio/basic"
    return "application/octet-stream"


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _voice_settings_json(
    *,
    stability: float,
    clarity: float,
    style_exaggeration: float,
    playback_speed: float,
    use_speaker_boost: bool,
) -> str:
    payload = {
        "stability": _clamp(float(stability), 0.0, 1.0),
        "similarity_boost": _clamp(float(clarity), 0.0, 1.0),
        "style": _clamp(float(style_exaggeration), 0.0, 1.0),
        "speed": _clamp(float(playback_speed), 0.5, 2.0),
        "use_speaker_boost": bool(use_speaker_boost),
    }
    return json.dumps(payload, separators=(",", ":"))


async def _speech_to_speech_impl(
    *,
    audio: UploadFile,
    voice_id: str,
    model_id: str,
    output_format: str,
    optimize_streaming_latency: str,
    enable_logging: bool,
    stream: bool,
    stability: float,
    clarity: float,
    style_exaggeration: float,
    playback_speed: float,
    use_speaker_boost: bool,
    seed: Optional[int],
    remove_background_noise: bool,
) -> Response:
    api_key = _require_key()
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio file is required")

    url = f"{_ELEVENLABS_API_BASE}/speech-to-speech/{voice_id}"
    if stream:
        url += "/stream"

    params = {
        "output_format": output_format,
        "optimize_streaming_latency": optimize_streaming_latency,
        "enable_logging": str(enable_logging).lower(),
    }
    data: dict[str, object] = {
        "model_id": model_id,
        "voice_settings": _voice_settings_json(
            stability=stability,
            clarity=clarity,
            style_exaggeration=style_exaggeration,
            playback_speed=playback_speed,
            use_speaker_boost=use_speaker_boost,
        ),
        "remove_background_noise": str(remove_background_noise).lower(),
    }
    if seed is not None:
        data["seed"] = int(seed)

    files = {
        "audio": (
            audio.filename or "source_audio.wav",
            audio_bytes,
            audio.content_type or "audio/wav",
        )
    }
    headers = {"xi-api-key": api_key, "Accept": "audio/mpeg"}

    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.post(url, params=params, data=data, files=files, headers=headers)

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_error_detail(resp))
    return Response(content=resp.content, media_type=_audio_media_type(output_format))


@router.post("/speech-to-speech")
async def speech_to_speech(
    current_user: User = Depends(get_current_user),
    audio: UploadFile = File(...),
    voice_id: str = Form(...),
    model_id: str = Form(ELEVENLABS_STS_MODEL),
    output_format: str = Form(ELEVENLABS_OUTPUT_FORMAT),
    optimize_streaming_latency: str = Form(ELEVENLABS_OPTIMIZE_STREAMING_LATENCY),
    enable_logging: bool = Form(True),
    stream: bool = Form(True),
    stability: float = Form(0.5),
    clarity: float = Form(0.75),
    style_exaggeration: float = Form(0.0),
    playback_speed: float = Form(1.0),
    use_speaker_boost: bool = Form(ELEVENLABS_DEFAULT_USE_SPEAKER_BOOST),
    seed: Optional[int] = Form(None),
    remove_background_noise: bool = Form(False),
):
    _ = current_user
    return await _speech_to_speech_impl(
        audio=audio,
        voice_id=voice_id,
        model_id=model_id,
        output_format=output_format,
        optimize_streaming_latency=optimize_streaming_latency,
        enable_logging=enable_logging,
        stream=stream,
        stability=stability,
        clarity=clarity,
        style_exaggeration=style_exaggeration,
        playback_speed=playback_speed,
        use_speaker_boost=use_speaker_boost,
        seed=seed,
        remove_background_noise=remove_background_noise,
    )


@router.post("/voice-changer")
async def voice_changer(
    current_user: User = Depends(get_current_user),
    audio: UploadFile = File(...),
    voice_id: str = Form(...),
    model_id: str = Form(ELEVENLABS_STS_MODEL),
    output_format: str = Form(ELEVENLABS_OUTPUT_FORMAT),
    optimize_streaming_latency: str = Form(ELEVENLABS_OPTIMIZE_STREAMING_LATENCY),
    enable_logging: bool = Form(True),
    stream: bool = Form(True),
    stability: float = Form(0.5),
    clarity: float = Form(0.75),
    style_exaggeration: float = Form(0.0),
    playback_speed: float = Form(1.0),
    use_speaker_boost: bool = Form(ELEVENLABS_DEFAULT_USE_SPEAKER_BOOST),
    seed: Optional[int] = Form(None),
    remove_background_noise: bool = Form(True),
):
    _ = current_user
    return await _speech_to_speech_impl(
        audio=audio,
        voice_id=voice_id,
        model_id=model_id,
        output_format=output_format,
        optimize_streaming_latency=optimize_streaming_latency,
        enable_logging=enable_logging,
        stream=stream,
        stability=stability,
        clarity=clarity,
        style_exaggeration=style_exaggeration,
        playback_speed=playback_speed,
        use_speaker_boost=use_speaker_boost,
        seed=seed,
        remove_background_noise=remove_background_noise,
    )


@router.post("/audio-isolation")
async def audio_isolation(
    current_user: User = Depends(get_current_user),
    audio: UploadFile = File(...),
    stream: bool = Form(True),
):
    _ = current_user
    api_key = _require_key()
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio file is required")

    url = f"{_ELEVENLABS_API_BASE}/audio-isolation"
    if stream:
        url += "/stream"

    files = {
        "audio": (
            audio.filename or "source_audio.wav",
            audio_bytes,
            audio.content_type or "audio/wav",
        )
    }
    headers = {"xi-api-key": api_key, "Accept": "audio/mpeg"}

    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.post(url, files=files, headers=headers)

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_error_detail(resp))
    return Response(content=resp.content, media_type="audio/mpeg")


@router.post("/sound-effects")
async def sound_effects(
    payload: SoundEffectsRequest,
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    api_key = _require_key()
    headers = {"xi-api-key": api_key, "Accept": "audio/mpeg"}

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"{_ELEVENLABS_API_BASE}/sound-generation",
            json=payload.model_dump(exclude_none=True),
            headers=headers,
        )

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_error_detail(resp))
    return Response(content=resp.content, media_type="audio/mpeg")


@router.post("/dubbing")
async def dubbing_create(
    current_user: User = Depends(get_current_user),
    target_lang: str = Form(...),
    file: Optional[UploadFile] = File(default=None),
    name: Optional[str] = Form(default=None),
    source_url: Optional[str] = Form(default=None),
    source_lang: Optional[str] = Form(default=None),
    num_speakers: Optional[int] = Form(default=None),
    watermark: Optional[bool] = Form(default=None),
    start_time: Optional[int] = Form(default=None),
    end_time: Optional[int] = Form(default=None),
    highest_resolution: Optional[bool] = Form(default=None),
    drop_background_audio: Optional[bool] = Form(default=None),
    use_profanity_filter: Optional[bool] = Form(default=None),
):
    _ = current_user
    api_key = _require_key()
    if file is None and not source_url:
        raise HTTPException(status_code=400, detail="Either file or source_url is required")

    data: dict[str, object] = {"target_lang": target_lang}
    for key, value in {
        "name": name,
        "source_url": source_url,
        "source_lang": source_lang,
        "num_speakers": num_speakers,
        "watermark": watermark,
        "start_time": start_time,
        "end_time": end_time,
        "highest_resolution": highest_resolution,
        "drop_background_audio": drop_background_audio,
        "use_profanity_filter": use_profanity_filter,
    }.items():
        if value is not None:
            data[key] = value

    files = None
    if file is not None:
        file_bytes = await file.read()
        files = {
            "file": (
                file.filename or "source_media.mp4",
                file_bytes,
                file.content_type or "application/octet-stream",
            )
        }

    headers = {"xi-api-key": api_key}
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{_ELEVENLABS_API_BASE}/dubbing",
            data=data,
            files=files,
            headers=headers,
        )

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_error_detail(resp))
    return JSONResponse(resp.json())


@router.get("/dubbing/{dubbing_id}")
async def dubbing_metadata(
    dubbing_id: str,
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    api_key = _require_key()
    headers = {"xi-api-key": api_key}

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{_ELEVENLABS_API_BASE}/dubbing/{dubbing_id}", headers=headers)

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_error_detail(resp))
    return JSONResponse(resp.json())


@router.get("/dubbing/{dubbing_id}/audio/{language_code}")
async def dubbing_audio(
    dubbing_id: str,
    language_code: str,
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    api_key = _require_key()
    headers = {"xi-api-key": api_key}

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.get(
            f"{_ELEVENLABS_API_BASE}/dubbing/{dubbing_id}/audio/{language_code}",
            headers=headers,
        )

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_error_detail(resp))
    return Response(content=resp.content, media_type=resp.headers.get("content-type", "application/octet-stream"))


@router.get("/dubbing/{dubbing_id}/transcript/{language_code}")
async def dubbing_transcript(
    dubbing_id: str,
    language_code: str,
    format_type: Optional[str] = Query(default=None),
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    api_key = _require_key()
    headers = {"xi-api-key": api_key}
    params = {"format_type": format_type} if format_type else None

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{_ELEVENLABS_API_BASE}/dubbing/{dubbing_id}/transcript/{language_code}",
            headers=headers,
            params=params,
        )

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_error_detail(resp))
    content_type = resp.headers.get("content-type", "")
    if "application/json" in content_type:
        return JSONResponse(resp.json())
    return Response(content=resp.content, media_type=content_type or "text/plain")


@router.post("/text-to-voice/previews")
async def text_to_voice_previews(
    payload: TextToVoicePreviewRequest,
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    api_key = _require_key()
    headers = {"xi-api-key": api_key, "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"{_ELEVENLABS_API_BASE}/text-to-voice/create-previews",
            json=payload.model_dump(),
            headers=headers,
        )

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_error_detail(resp))
    return JSONResponse(resp.json())


@router.post("/text-to-voice/create")
async def text_to_voice_create(
    payload: TextToVoiceCreateRequest,
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    api_key = _require_key()
    headers = {"xi-api-key": api_key, "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"{_ELEVENLABS_API_BASE}/text-to-voice/create-voice-from-preview",
            json=payload.model_dump(exclude_none=True),
            headers=headers,
        )

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_error_detail(resp))
    return JSONResponse(resp.json())


@router.post("/speech-to-text")
async def speech_to_text(
    current_user: User = Depends(get_current_user),
    audio: UploadFile = File(...),
    model_id: str = Form("scribe_v1"),
    language_code: Optional[str] = Form(default=None),
    diarize: Optional[bool] = Form(default=None),
    tag_audio_events: Optional[bool] = Form(default=None),
):
    _ = current_user
    api_key = _require_key()
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio file is required")

    data: dict[str, object] = {"model_id": model_id}
    if language_code:
        data["language_code"] = language_code
    if diarize is not None:
        data["diarize"] = diarize
    if tag_audio_events is not None:
        data["tag_audio_events"] = tag_audio_events

    files = {
        "file": (
            audio.filename or "speech_audio.wav",
            audio_bytes,
            audio.content_type or "audio/wav",
        )
    }

    headers = {"xi-api-key": api_key}
    async with httpx.AsyncClient(timeout=90.0) as client:
        resp = await client.post(
            f"{_ELEVENLABS_API_BASE}/speech-to-text",
            data=data,
            files=files,
            headers=headers,
        )

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_error_detail(resp))
    try:
        return JSONResponse(resp.json())
    except Exception:
        return Response(content=resp.content, media_type=resp.headers.get("content-type", "text/plain"))
