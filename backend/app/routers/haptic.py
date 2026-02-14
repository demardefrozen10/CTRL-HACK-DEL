"""Haptic feedback API endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services import send_intensity, haptic_connected

router = APIRouter(prefix="/haptic", tags=["haptic"])


class HapticRequest(BaseModel):
    intensity: int = Field(..., ge=0, le=255, description="Haptic intensity (0-255)")


class HapticResponse(BaseModel):
    success: bool
    intensity: int
    message: str


class HapticStatus(BaseModel):
    connected: bool


@router.post("/send", response_model=HapticResponse)
async def send_haptic(request: HapticRequest):
    """Send haptic feedback intensity to the device."""
    import asyncio
    
    success = await asyncio.to_thread(send_intensity, request.intensity)
    
    if success:
        return HapticResponse(
            success=True,
            intensity=request.intensity,
            message=f"Sent intensity {request.intensity}",
        )
    else:
        return HapticResponse(
            success=False,
            intensity=request.intensity,
            message="Failed to send - device may not be connected",
        )


@router.get("/send")
async def send_haptic_get(intensity: int):
    """Send haptic feedback intensity (GET for easy testing)."""
    import asyncio
    
    intensity = max(0, min(255, intensity))
    success = await asyncio.to_thread(send_intensity, intensity)
    
    return HapticResponse(
        success=success,
        intensity=intensity,
        message=f"Sent intensity {intensity}" if success else "Failed to send",
    )


@router.get("/status", response_model=HapticStatus)
async def get_haptic_status():
    """Check if haptic device is connected."""
    return HapticStatus(connected=haptic_connected())
