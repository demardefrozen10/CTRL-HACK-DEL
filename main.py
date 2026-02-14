import asyncio
import json
import time
import cv2
from contextlib import asynccontextmanager
from typing import List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles

from frame_buffer import FrameBuffer
from vision_processor import analyze_frame
from tts_service import synthesize
from haptic_serial import send_intensity, close as close_serial

# ── Globals ──────────────────────────────────────────────────────────────────
frame_buffer = FrameBuffer(source=0)
connected_ws: List[WebSocket] = []
latest_analysis: dict | None = None
analysis_lock = asyncio.Lock()

# ── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    frame_buffer.start()
    task = asyncio.create_task(keyframe_loop())
    yield
    task.cancel()
    frame_buffer.stop()
    close_serial()


app = FastAPI(title="Echo-Sight", lifespan=lifespan)


# ── MJPEG Stream (30 FPS) ───────────────────────────────────────────────────

def mjpeg_generator():
    """Yield JPEG frames at ~30 FPS as multipart stream."""
    interval = 1.0 / 30.0
    while True:
        frame = frame_buffer.get_frame()
        if frame is not None:
            _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + buf.tobytes() + b"\r\n"
            )
        time.sleep(interval)


@app.get("/video_feed")
def video_feed():
    return StreamingResponse(
        mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


# ── Key-Frame Analysis (1 FPS → Gemini) ─────────────────────────────────────

async def keyframe_loop():
    """Sample one frame per second, send to Gemini, dispatch results."""
    global latest_analysis
    while True:
        await asyncio.sleep(1.0)
        frame = frame_buffer.get_frame()
        if frame is None:
            continue

        # Run blocking Gemini call in threadpool
        result = await asyncio.to_thread(analyze_frame, frame)
        if result is None:
            continue

        async with analysis_lock:
            latest_analysis = result

        # ── Dispatch: Haptic ─────────────────────────────────────────────
        haptic = result.get("haptic_intensity", 0)
        await asyncio.to_thread(send_intensity, haptic)

        # ── Dispatch: TTS ────────────────────────────────────────────────
        voice_prompt = result.get("voice_prompt", "")
        if voice_prompt:
            await asyncio.to_thread(synthesize, voice_prompt)

        # ── Dispatch: WebSocket → Dashboard ──────────────────────────────
        detections = result.get("detections", [])
        payload = json.dumps(
            {
                "voice_prompt": voice_prompt,
                "haptic_intensity": haptic,
                "detections": detections,
                "ts": time.time(),
            }
        )
        stale = []
        for ws in connected_ws:
            try:
                await ws.send_text(payload)
            except Exception:
                stale.append(ws)
        for ws in stale:
            connected_ws.remove(ws)


# ── WebSocket Endpoint ──────────────────────────────────────────────────────

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    connected_ws.append(ws)
    try:
        while True:
            await ws.receive_text()  # keep-alive
    except WebSocketDisconnect:
        connected_ws.remove(ws)


# ── TTS on-demand endpoint ──────────────────────────────────────────────────

@app.get("/tts")
async def tts_endpoint(text: str = "Hello"):
    audio = await asyncio.to_thread(synthesize, text)
    if audio:
        return Response(content=audio, media_type="audio/mpeg")
    return Response(content=b"", status_code=204)


# ── Latest analysis JSON ────────────────────────────────────────────────────

@app.get("/api/latest")
async def api_latest():
    async with analysis_lock:
        return latest_analysis or {}


# ── Dashboard ────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def dashboard():
    with open("dashboard.html", "r") as f:
        return f.read()


# ── Run ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
