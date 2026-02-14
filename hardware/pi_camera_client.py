from __future__ import annotations

import asyncio
import base64
import json
import os
import signal
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import cv2
import websockets
from dotenv import load_dotenv

# Try to import pyaudio for microphone capture
try:
    import pyaudio
    PYAUDIO_AVAILABLE = True
except ImportError:
    PYAUDIO_AVAILABLE = False
    print("[Warning] pyaudio not installed. Run: pip install pyaudio (or apt install python3-pyaudio on Pi)")

load_dotenv(dotenv_path=Path(__file__).with_name(".env"))

BACKEND_WS_URL = os.getenv("BACKEND_WS_URL", "").strip()
BACKEND_HOST = os.getenv("BACKEND_HOST", "").strip()
BACKEND_PORT = int(os.getenv("BACKEND_PORT", "8000"))
BACKEND_WS_PATH = os.getenv("BACKEND_WS_PATH", "/ws/live").strip() or "/ws/live"
PC_LAN_IP = os.getenv("PC_LAN_IP", "").strip()
CAMERA_INDEX = int(os.getenv("CAMERA_INDEX", "0"))
CAMERA_INDEX_CANDIDATES = os.getenv("CAMERA_INDEX_CANDIDATES", "").strip()
USE_V4L2 = os.getenv("USE_V4L2", "true").strip().lower() in {"1", "true", "yes", "on"}
FRAME_FPS = float(os.getenv("FRAME_FPS", "12"))
JPEG_QUALITY = int(os.getenv("JPEG_QUALITY", "60"))
FRAME_WIDTH = int(os.getenv("FRAME_WIDTH", "640"))
FRAME_HEIGHT = int(os.getenv("FRAME_HEIGHT", "360"))
RECONNECT_DELAY_SEC = float(os.getenv("RECONNECT_DELAY_SEC", "3"))

# Audio settings
AUDIO_ENABLED = os.getenv("AUDIO_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}
AUDIO_DEVICE_INDEX = os.getenv("AUDIO_DEVICE_INDEX", "").strip()  # Empty = default mic
AUDIO_SAMPLE_RATE = 16000  # Gemini expects 16kHz
AUDIO_CHANNELS = 1  # Mono
AUDIO_CHUNK_SIZE = 1024  # Samples per chunk


def _build_backend_ws_url() -> str:
    if BACKEND_WS_URL:
        if ("localhost" in BACKEND_WS_URL or "127.0.0.1" in BACKEND_WS_URL) and PC_LAN_IP:
            return BACKEND_WS_URL.replace("localhost", PC_LAN_IP).replace("127.0.0.1", PC_LAN_IP)
        return BACKEND_WS_URL

    host = BACKEND_HOST or PC_LAN_IP
    if not host:
        host = "127.0.0.1"

    path = BACKEND_WS_PATH if BACKEND_WS_PATH.startswith("/") else f"/{BACKEND_WS_PATH}"
    return f"ws://{host}:{BACKEND_PORT}{path}"


def _ensure_source_role(url: str) -> str:
    parsed = urlparse(url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.setdefault("role", "source")
    return urlunparse(parsed._replace(query=urlencode(query)))


RESOLVED_BACKEND_WS_URL = _ensure_source_role(_build_backend_ws_url())


def _camera_index_candidates() -> list[int]:
    if CAMERA_INDEX_CANDIDATES:
        values: list[int] = []
        for part in CAMERA_INDEX_CANDIDATES.split(","):
            token = part.strip()
            if not token:
                continue
            try:
                values.append(int(token))
            except ValueError:
                continue
        if values:
            seen: set[int] = set()
            ordered: list[int] = []
            for value in values:
                if value not in seen:
                    seen.add(value)
                    ordered.append(value)
            return ordered

    defaults = [CAMERA_INDEX, 0, 1, 2, 3]
    seen: set[int] = set()
    ordered: list[int] = []
    for value in defaults:
        if value not in seen:
            seen.add(value)
            ordered.append(value)
    return ordered


def _open_camera() -> cv2.VideoCapture:
    candidates = _camera_index_candidates()
    backend_flag = cv2.CAP_V4L2 if USE_V4L2 and hasattr(cv2, "CAP_V4L2") else None

    for index in candidates:
        capture = cv2.VideoCapture(index, backend_flag) if backend_flag is not None else cv2.VideoCapture(index)
        if capture.isOpened():
            if FRAME_WIDTH > 0:
                capture.set(cv2.CAP_PROP_FRAME_WIDTH, float(FRAME_WIDTH))
            if FRAME_HEIGHT > 0:
                capture.set(cv2.CAP_PROP_FRAME_HEIGHT, float(FRAME_HEIGHT))
            if FRAME_FPS > 0:
                capture.set(cv2.CAP_PROP_FPS, float(FRAME_FPS))
            print(f"[Camera] Opened camera index {index}" + (" with CAP_V4L2" if backend_flag is not None else ""))
            return capture
        capture.release()

    raise RuntimeError(
        f"Could not open camera. Tried indices={candidates}"
        + (" using CAP_V4L2" if backend_flag is not None else "")
        + ". Set CAMERA_INDEX or CAMERA_INDEX_CANDIDATES in hardware/.env."
    )


def _encode_frame_to_base64_jpeg(frame) -> str:
    success, buffer = cv2.imencode(
        ".jpg",
        frame,
        [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY],
    )
    if not success:
        raise RuntimeError("Failed to encode frame as JPEG")
    return base64.b64encode(buffer.tobytes()).decode("ascii")


async def _recv_loop(ws: websockets.ClientConnection) -> None:
    async for raw in ws:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            continue

        message_type = message.get("type")
        if message_type in {"session_started", "turn_complete", "interrupted"}:
            print(f"[WS] {message_type}")
        elif message_type == "text":
            print(f"[Gemini] {message.get('text', '')}")
        elif message_type == "error":
            print(f"[WS Error] {message.get('message', 'Unknown error')}")
        elif message_type == "audio":
            pass


async def _send_video_loop(ws: websockets.ClientConnection, stop_event: asyncio.Event) -> None:
    capture = _open_camera()

    frame_interval = 1.0 / max(FRAME_FPS, 0.1)
    next_send = asyncio.get_running_loop().time()

    try:
        while not stop_event.is_set():
            ok, frame = capture.read()
            if not ok:
                await asyncio.sleep(0.1)
                continue

            if FRAME_WIDTH > 0 and FRAME_HEIGHT > 0:
                if frame.shape[1] != FRAME_WIDTH or frame.shape[0] != FRAME_HEIGHT:
                    frame = cv2.resize(frame, (FRAME_WIDTH, FRAME_HEIGHT), interpolation=cv2.INTER_AREA)

            payload = {
                "type": "video",
                "data": _encode_frame_to_base64_jpeg(frame),
            }
            await ws.send(json.dumps(payload))

            next_send += frame_interval
            sleep_for = next_send - asyncio.get_running_loop().time()
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)
            else:
                next_send = asyncio.get_running_loop().time()
    finally:
        capture.release()


async def _send_audio_loop(ws: websockets.ClientConnection, stop_event: asyncio.Event) -> None:
    """Capture audio from microphone and send to backend as PCM chunks."""
    if not PYAUDIO_AVAILABLE:
        print("[Audio] pyaudio not available, skipping audio capture")
        return
    
    if not AUDIO_ENABLED:
        print("[Audio] Audio capture disabled via AUDIO_ENABLED=false")
        return

    pa = pyaudio.PyAudio()
    
    # Determine device index
    device_index = None
    if AUDIO_DEVICE_INDEX:
        try:
            device_index = int(AUDIO_DEVICE_INDEX)
        except ValueError:
            print(f"[Audio] Invalid AUDIO_DEVICE_INDEX: {AUDIO_DEVICE_INDEX}, using default")
    
    # List available devices for debugging
    print("[Audio] Available audio input devices:")
    for i in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(i)
        if info.get("maxInputChannels", 0) > 0:
            print(f"  [{i}] {info.get('name')} (inputs: {info.get('maxInputChannels')})")
    
    try:
        stream = pa.open(
            format=pyaudio.paInt16,
            channels=AUDIO_CHANNELS,
            rate=AUDIO_SAMPLE_RATE,
            input=True,
            input_device_index=device_index,
            frames_per_buffer=AUDIO_CHUNK_SIZE,
        )
        print(f"[Audio] Microphone opened (device={device_index or 'default'}, rate={AUDIO_SAMPLE_RATE}Hz)")
    except Exception as e:
        print(f"[Audio] Failed to open microphone: {e}")
        pa.terminate()
        return

    try:
        while not stop_event.is_set():
            try:
                # Read audio chunk (blocking, but short enough not to matter)
                audio_data = stream.read(AUDIO_CHUNK_SIZE, exception_on_overflow=False)
                
                # Encode as base64 and send
                b64_audio = base64.b64encode(audio_data).decode("ascii")
                payload = {"type": "audio", "data": b64_audio}
                await ws.send(json.dumps(payload))
                
            except Exception as e:
                print(f"[Audio] Error reading/sending audio: {e}")
                await asyncio.sleep(0.1)
    finally:
        stream.stop_stream()
        stream.close()
        pa.terminate()
        print("[Audio] Microphone closed")


async def stream_camera_to_backend(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            print(f"[WS] Connecting to {RESOLVED_BACKEND_WS_URL}")
            async with websockets.connect(
                RESOLVED_BACKEND_WS_URL,
                ping_interval=20,
                ping_timeout=20,
                compression=None,
            ) as ws:
                recv_task = asyncio.create_task(_recv_loop(ws))
                video_task = asyncio.create_task(_send_video_loop(ws, stop_event))
                audio_task = asyncio.create_task(_send_audio_loop(ws, stop_event))

                done, pending = await asyncio.wait(
                    [recv_task, video_task, audio_task],
                    return_when=asyncio.FIRST_EXCEPTION,
                )

                for task in pending:
                    task.cancel()

                for task in done:
                    task.result()

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"[WS] Connection lost: {exc}")
            if not stop_event.is_set():
                await asyncio.sleep(RECONNECT_DELAY_SEC)


async def main() -> None:
    stop_event = asyncio.Event()

    loop = asyncio.get_running_loop()

    def _request_stop() -> None:
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _request_stop)
        except NotImplementedError:
            pass

    print(f"[Config] BACKEND_WS_URL={RESOLVED_BACKEND_WS_URL}")
    if "localhost" in RESOLVED_BACKEND_WS_URL or "127.0.0.1" in RESOLVED_BACKEND_WS_URL:
        print("[Warning] Backend URL points to localhost. On Raspberry Pi, set PC_LAN_IP or BACKEND_HOST to your PC IP.")
    print(f"[Config] CAMERA_INDEX={CAMERA_INDEX}, CAMERA_INDEX_CANDIDATES={CAMERA_INDEX_CANDIDATES or 'auto'}, USE_V4L2={USE_V4L2}")
    print(
        f"[Config] FRAME_FPS={FRAME_FPS}, JPEG_QUALITY={JPEG_QUALITY}, "
        f"FRAME_WIDTH={FRAME_WIDTH}, FRAME_HEIGHT={FRAME_HEIGHT}"
    )
    print(f"[Config] AUDIO_ENABLED={AUDIO_ENABLED}, AUDIO_DEVICE_INDEX={AUDIO_DEVICE_INDEX or 'default'}")
    await stream_camera_to_backend(stop_event)


if __name__ == "__main__":
    asyncio.run(main())
