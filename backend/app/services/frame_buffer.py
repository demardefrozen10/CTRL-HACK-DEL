"""Thread-safe frame buffer for camera frames."""
from __future__ import annotations

import base64
import threading
import time
from typing import Optional

import cv2
import numpy as np


class FrameBuffer:
    """Thread-safe shared frame buffer for latest camera frame."""

    def __init__(self, source: int = 0) -> None:
        self._lock = threading.Lock()
        self._frame: Optional[np.ndarray] = None
        self._running = False
        self._cap = None
        self._source = source
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        """Start the capture thread."""
        if self._running:
            return
        self._cap = cv2.VideoCapture(self._source)
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        self._cap.set(cv2.CAP_PROP_FPS, 30)
        self._running = True
        self._thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._thread.start()
        print(f"[FrameBuffer] Started capture from source {self._source}")

    def _capture_loop(self) -> None:
        while self._running:
            if self._cap is None:
                break
            ret, frame = self._cap.read()
            if ret:
                with self._lock:
                    self._frame = frame
            time.sleep(1 / 60)

    def update(self, frame: np.ndarray) -> None:
        """Manually update the frame (for external sources like ESP32-CAM)."""
        if frame is None:
            return
        with self._lock:
            self._frame = frame.copy()

    def get(self) -> Optional[np.ndarray]:
        """Get a copy of the latest frame."""
        with self._lock:
            return self._frame.copy() if self._frame is not None else None

    def get_jpeg(self, quality: int = 80) -> Optional[bytes]:
        """Get the latest frame as JPEG bytes."""
        frame = self.get()
        if frame is None:
            return None
        ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if not ok:
            return None
        return jpg.tobytes()

    def get_base64_jpeg(self, quality: int = 75) -> Optional[str]:
        """Get the latest frame as base64-encoded JPEG."""
        jpg = self.get_jpeg(quality=quality)
        if jpg is None:
            return None
        return base64.b64encode(jpg).decode("ascii")

    def stop(self) -> None:
        """Stop the capture thread."""
        self._running = False
        if self._cap:
            self._cap.release()
            self._cap = None
        print("[FrameBuffer] Stopped capture")


# Global singleton instance
frame_buffer = FrameBuffer()
