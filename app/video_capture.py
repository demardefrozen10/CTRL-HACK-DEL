import threading
import time
import cv2
import numpy as np
import urllib.request

from app.config import ESP32_CAM_URL
from app.frame_buffer import frame_buffer

_stream_bytes = b""
_running = False
_thread: threading.Thread | None = None


def _capture_loop() -> None:
    """Continuously read MJPEG stream from ESP32-CAM."""
    global _stream_bytes, _running

    while _running:
        try:
            stream = urllib.request.urlopen(ESP32_CAM_URL, timeout=5)
            _stream_bytes = b""
            while _running:
                chunk = stream.read(4096)
                if not chunk:
                    break
                _stream_bytes += chunk
                # Look for JPEG boundaries
                a = _stream_bytes.find(b"\xff\xd8")
                b = _stream_bytes.find(b"\xff\xd9")
                if a != -1 and b != -1 and b > a:
                    jpg = _stream_bytes[a : b + 2]
                    _stream_bytes = _stream_bytes[b + 2 :]
                    frame = cv2.imdecode(
                        np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_COLOR
                    )
                    if frame is not None:
                        frame_buffer.update(frame)
        except Exception as exc:
            print(f"[video_capture] Connection error: {exc}. Retrying in 2s…")
            time.sleep(2)


def start() -> None:
    global _running, _thread
    if _running:
        return
    _running = True
    _thread = threading.Thread(target=_capture_loop, daemon=True)
    _thread.start()
    print("[video_capture] Started capture thread.")


def stop() -> None:
    global _running
    _running = False
