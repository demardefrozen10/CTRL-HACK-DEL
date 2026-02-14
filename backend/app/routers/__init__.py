"""API Routers package."""
from .auth import router as auth_router
from .vision import router as vision_router
from .tts import router as tts_router
from .haptic import router as haptic_router
from .stream import router as stream_router

__all__ = [
    "auth_router",
    "vision_router",
    "tts_router",
    "haptic_router",
    "stream_router",
]
