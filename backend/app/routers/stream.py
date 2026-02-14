"""Video streaming API endpoints."""
from __future__ import annotations

import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse

from ..services import frame_buffer, ws_manager

router = APIRouter(prefix="/stream", tags=["stream"])


def mjpeg_generator():
    """Yield JPEG frames at ~30 FPS as multipart stream."""
    import cv2
    
    interval = 1.0 / 30.0
    while True:
        frame = frame_buffer.get()
        if frame is not None:
            _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + buf.tobytes() + b"\r\n"
            )
        time.sleep(interval)


@router.get("/video")
def video_feed():
    """MJPEG video stream endpoint."""
    return StreamingResponse(
        mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """WebSocket endpoint for real-time analysis updates."""
    await ws_manager.connect(ws)
    try:
        while True:
            # Keep connection alive
            await ws.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)
