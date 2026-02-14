"""Services package."""
from .frame_buffer import frame_buffer, FrameBuffer
from .websocket import ws_manager, ConnectionManager
from .haptic import send_intensity, close as close_haptic, is_connected as haptic_connected
from .tts import synthesize_async, synthesize_sync, speak
from .vision import (
    analyze_frame_sync,
    analyze_frame_async,
    inference_loop,
    get_latest_analysis,
    set_latest_analysis,
)

__all__ = [
    "frame_buffer",
    "FrameBuffer",
    "ws_manager",
    "ConnectionManager",
    "send_intensity",
    "close_haptic",
    "haptic_connected",
    "synthesize_async",
    "synthesize_sync",
    "speak",
    "analyze_frame_sync",
    "analyze_frame_async",
    "inference_loop",
    "get_latest_analysis",
    "set_latest_analysis",
]
