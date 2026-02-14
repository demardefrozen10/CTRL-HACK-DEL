"""Vision API endpoints."""
from __future__ import annotations

import asyncio
import base64
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..services import (
    analyze_frame_sync,
    analyze_frame_async,
    get_latest_analysis,
    frame_buffer,
)

router = APIRouter(prefix="/vision", tags=["vision"])


class AnalysisResponse(BaseModel):
    voice_prompt: str
    detections: list
    haptic_intensity: int
    ts: Optional[float] = None


@router.get("/latest", response_model=AnalysisResponse)
async def get_latest():
    """Get the latest vision analysis result."""
    result = await get_latest_analysis()
    if not result:
        return AnalysisResponse(
            voice_prompt="No analysis available",
            detections=[],
            haptic_intensity=0,
        )
    return result


@router.post("/analyze", response_model=AnalysisResponse)
async def analyze_uploaded_image(file: UploadFile = File(...)):
    """Analyze an uploaded image."""
    import cv2
    import numpy as np
    
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    if frame is None:
        raise HTTPException(status_code=400, detail="Invalid image file")
    
    result = await analyze_frame_async(frame)
    if result is None:
        raise HTTPException(status_code=500, detail="Analysis failed")
    
    return result


@router.get("/analyze-current", response_model=AnalysisResponse)
async def analyze_current_frame():
    """Analyze the current camera frame."""
    frame = frame_buffer.get()
    if frame is None:
        raise HTTPException(status_code=503, detail="No camera frame available")
    
    result = await analyze_frame_async(frame)
    if result is None:
        raise HTTPException(status_code=500, detail="Analysis failed")
    
    return result


@router.get("/frame")
async def get_current_frame():
    """Get the current camera frame as base64 JPEG."""
    b64 = frame_buffer.get_base64_jpeg()
    if b64 is None:
        raise HTTPException(status_code=503, detail="No camera frame available")
    
    return JSONResponse({"image": b64})
