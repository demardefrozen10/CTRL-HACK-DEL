from __future__ import annotations

import base64
import threading
from typing import Optional

import cv2
import numpy as np


class FrameBuffer:
    """Thread-safe shared frame buffer for latest camera frame."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._frame: Optional[np.ndarray] = None

    def update(self, frame: np.ndarray) -> None:
        if frame is None:
            return
        with self._lock:
            self._frame = frame.copy()

    def get(self) -> Optional[np.ndarray]:
        with self._lock:
            return self._frame.copy() if self._frame is not None else None

    def get_jpeg(self, quality: int = 80) -> Optional[bytes]:
        frame = self.get()
        if frame is None:
            return None
        ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if not ok:
            return None
        return jpg.tobytes()

    def get_base64_jpeg(self, quality: int = 75) -> Optional[str]:
        jpg = self.get_jpeg(quality=quality)
        if jpg is None:
            return None
        return base64.b64encode(jpg).decode("ascii")


frame_buffer = FrameBuffer()
