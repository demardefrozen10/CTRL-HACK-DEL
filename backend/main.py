from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse

from app.database import Base, engine
from app.routers import auth
from app.routers.haptic import router as app_haptic_router
from app.routers.stream import router as app_stream_router
from app.routers.tts import router as app_tts_router
from app.routers.vision import router as app_vision_router
from app.routers.voice_studio import router as app_voice_studio_router
from app.routers.gemini_live import router as gemini_live_router
from app.routers.gemini_live import router as gemini_live_router
from app.services import close_haptic as app_close_haptic
from app.services import frame_buffer as app_frame_buffer
from app.services.vision import inference_loop as app_inference_loop
from config import CAPTURE_FPS, CORS_ORIGINS, ESP32_CAM_URL, INFERENCE_INTERVAL_MS
from gemini_service import GeminiService
from haptic_service import HapticService
from tts_service import TTSService
from vision_pipeline import VisionPipeline, generate_mjpeg

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("echo-sight")


class WebSocketHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)
            total = len(self._clients)
        logger.info("WebSocket connected. Clients=%d", total)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)
            total = len(self._clients)
        logger.info("WebSocket disconnected. Clients=%d", total)

    async def broadcast(self, payload: dict) -> None:
        message = json.dumps(payload)
        async with self._lock:
            targets = list(self._clients)

        stale: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_text(message)
            except Exception:
                stale.append(ws)

        if stale:
            async with self._lock:
                for ws in stale:
                    self._clients.discard(ws)

    async def count(self) -> int:
        async with self._lock:
            return len(self._clients)


pipeline = VisionPipeline(source=ESP32_CAM_URL, target_fps=CAPTURE_FPS)
gemini = GeminiService()
haptic = HapticService()
tts = TTSService()
ws_hub = WebSocketHub()

_inference_task: asyncio.Task | None = None
_app_inference_task: asyncio.Task | None = None


async def on_inference_result(result: dict) -> None:
    await ws_hub.broadcast(result)

    intensity = result.get("haptic_intensity", 0)
    await asyncio.to_thread(haptic.send_intensity, intensity)

    voice_prompt = str(result.get("voice_prompt", "")).strip()
    if voice_prompt:
        await tts.enqueue(voice_prompt)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _inference_task, _app_inference_task

    logger.info("Starting Echo-Sight backend...")
    gemini.configure()
    gemini.set_pipeline(pipeline)
    gemini.on_result = on_inference_result

    Base.metadata.create_all(bind=engine)

    pipeline.start()
    app_frame_buffer.start()
    haptic.connect()
    await tts.start()

    # Legacy inference loops disabled – Gemini Live API replaces them.
    # _inference_task = asyncio.create_task(
    #     gemini.start_inference_loop(), name="gemini-inference-loop"
    # )
    # _app_inference_task = asyncio.create_task(
    #     app_inference_loop(), name="app-inference-loop"
    # )

    logger.info("Echo-Sight backend is live.")
    yield

    logger.info("Shutting down Echo-Sight backend...")
    gemini.stop()

    if _inference_task is not None:
        _inference_task.cancel()
        with suppress(asyncio.CancelledError):
            await _inference_task
        _inference_task = None

    if _app_inference_task is not None:
        _app_inference_task.cancel()
        with suppress(asyncio.CancelledError):
            await _app_inference_task
        _app_inference_task = None

    pipeline.stop()
    app_frame_buffer.stop()
    haptic.disconnect()
    app_close_haptic()
    await tts.stop()


app = FastAPI(
    title="Echo-Sight Backend",
    description="Dual-speed vision backend for accessibility wearable demo",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(app_vision_router)
app.include_router(app_tts_router)
app.include_router(app_haptic_router)
app.include_router(app_stream_router)
app.include_router(app_voice_studio_router)
app.include_router(gemini_live_router)
app.include_router(gemini_live_router)


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "capture_fps_target": CAPTURE_FPS,
            "inference_interval_ms": INFERENCE_INTERVAL_MS,
            "video_source": ESP32_CAM_URL,
            "gemini_enabled": gemini.enabled,
            "serial_connected": haptic.connected,
            "last_haptic_intensity": haptic.last_intensity,
            "ws_clients": await ws_hub.count(),
        }
    )


@app.get("/video_feed")
async def video_feed() -> StreamingResponse:
    return StreamingResponse(
        generate_mjpeg(pipeline),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.get("/detections")
async def detections() -> JSONResponse:
    return JSONResponse(pipeline.get_latest_detections())


@app.get("/audio/latest")
async def latest_audio() -> Response:
    audio = await tts.get_latest_audio()
    if not audio:
        return Response(status_code=204)
    return Response(content=audio, media_type="audio/mpeg")


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws_hub.connect(ws)
    await ws.send_text(json.dumps(pipeline.get_latest_detections()))

    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await ws_hub.disconnect(ws)


@app.get("/", response_class=HTMLResponse)
@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard() -> HTMLResponse:
    html_path = Path(__file__).parent / "static" / "dashboard.html"
    if not html_path.exists():
        return HTMLResponse("<h1>Dashboard not found</h1>", status_code=404)
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
