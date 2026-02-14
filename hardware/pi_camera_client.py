from __future__ import annotations

import asyncio
import base64
import json
import os
import signal
from pathlib import Path

import cv2
import websockets
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).with_name(".env"))

BACKEND_WS_URL = os.getenv("BACKEND_WS_URL", "").strip()
BACKEND_HOST = os.getenv("BACKEND_HOST", "").strip()
BACKEND_PORT = int(os.getenv("BACKEND_PORT", "8000"))
BACKEND_WS_PATH = os.getenv("BACKEND_WS_PATH", "/ws/live").strip() or "/ws/live"
PC_LAN_IP = os.getenv("PC_LAN_IP", "").strip()
CAMERA_INDEX = int(os.getenv("CAMERA_INDEX", "0"))
FRAME_FPS = float(os.getenv("FRAME_FPS", "1.0"))
JPEG_QUALITY = int(os.getenv("JPEG_QUALITY", "75"))
RECONNECT_DELAY_SEC = float(os.getenv("RECONNECT_DELAY_SEC", "3"))


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


RESOLVED_BACKEND_WS_URL = _build_backend_ws_url()


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
    capture = cv2.VideoCapture(CAMERA_INDEX)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open camera index {CAMERA_INDEX}")

    frame_interval = 1.0 / max(FRAME_FPS, 0.1)

    try:
        while not stop_event.is_set():
            ok, frame = capture.read()
            if not ok:
                await asyncio.sleep(0.1)
                continue

            payload = {
                "type": "video",
                "data": _encode_frame_to_base64_jpeg(frame),
            }
            await ws.send(json.dumps(payload))
            await asyncio.sleep(frame_interval)
    finally:
        capture.release()


async def stream_camera_to_backend(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            print(f"[WS] Connecting to {RESOLVED_BACKEND_WS_URL}")
            async with websockets.connect(RESOLVED_BACKEND_WS_URL, ping_interval=20, ping_timeout=20) as ws:
                recv_task = asyncio.create_task(_recv_loop(ws))
                send_task = asyncio.create_task(_send_video_loop(ws, stop_event))

                done, pending = await asyncio.wait(
                    [recv_task, send_task],
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
    print(f"[Config] CAMERA_INDEX={CAMERA_INDEX}, FRAME_FPS={FRAME_FPS}, JPEG_QUALITY={JPEG_QUALITY}")
    await stream_camera_to_backend(stop_event)


if __name__ == "__main__":
    asyncio.run(main())
