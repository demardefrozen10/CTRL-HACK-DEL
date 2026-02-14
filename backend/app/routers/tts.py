"""Text-to-Speech API endpoints."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from ..services import synthesize_async, synthesize_sync

router = APIRouter(prefix="/tts", tags=["tts"])


class TTSRequest(BaseModel):
    text: str
    voice_id: Optional[str] = None


@router.get("")
async def tts_get(text: str, voice_id: Optional[str] = None):
    """
    Synthesize text to speech (GET request).
    Returns audio/mpeg stream.
    """
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")
    
    audio = await synthesize_async(text, voice_id)
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
    
    audio = await synthesize_async(request.text, request.voice_id)
    if audio:
        return Response(content=audio, media_type="audio/mpeg")
    return Response(content=b"", status_code=204)
