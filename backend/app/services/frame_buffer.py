"""Thread-safe frame buffer for camera frames."""
from __future__ import annotations

import base64
import math
import os
import threading
import time
from typing import Optional

import cv2
import numpy as np

from ..config import CAMERA_SOURCE


class FrameBuffer:
    """Thread-safe shared frame buffer for latest camera frame."""

    def __init__(self, source: int | str = 0) -> None:
        self._lock = threading.Lock()
        self._frame: Optional[np.ndarray] = None
        self._running = False
        self._cap = None
        self._source = source
        self._thread: Optional[threading.Thread] = None
        self._demo_tick = 0
        self._using_demo_frames = False

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

    def _build_demo_frame(self) -> np.ndarray:
        """Generate a synthetic demo frame when no camera is available."""
        height, width = 720, 1280
        self._demo_tick += 1

        frame = np.zeros((height, width, 3), dtype=np.uint8)
        x_gradient = np.tile(np.linspace(10, 65, width, dtype=np.uint8), (height, 1))
        y_gradient = np.tile(np.linspace(5, 48, height, dtype=np.uint8)[:, None], (1, width))

        frame[:, :, 0] = np.clip(x_gradient // 2, 0, 255)
        frame[:, :, 1] = np.clip(x_gradient + y_gradient, 0, 255)
        frame[:, :, 2] = np.clip(y_gradient // 4, 0, 255)

        overlay = frame.copy()
        cv2.rectangle(overlay, (0, 0), (width, height), (0, 0, 0), -1)
        frame = cv2.addWeighted(overlay, 0.72, frame, 0.28, 0.0)

        warning = (210, 240, 30)

        margin = 58
        cv2.rectangle(frame, (margin, margin), (width - margin, height - margin), warning, 3)
        cv2.line(frame, (width // 2, margin), (width // 2, height - margin), (95, 145, 20), 1)
        cv2.line(frame, (margin, height // 2), (width - margin, height // 2), (95, 145, 20), 1)
        cv2.circle(frame, (width // 2, height // 2), 38, (205, 235, 70), 3)

        oscillation = math.sin(self._demo_tick / 11.0)
        obstacle_center = int(width * 0.75 + oscillation * width * 0.08)
        obstacle_top = int(height * 0.23)
        obstacle_bottom = int(height * 0.82)
        obstacle_half_width = int(width * 0.09)

        x1 = max(margin + 10, obstacle_center - obstacle_half_width)
        x2 = min(width - margin - 10, obstacle_center + obstacle_half_width)
        pulse = int(160 + 70 * (0.5 + 0.5 * math.sin(self._demo_tick / 5.5)))
        cv2.rectangle(frame, (x1, obstacle_top), (x2, obstacle_bottom), (pulse, 255, 245), 4)
        cv2.rectangle(frame, (x1, obstacle_top - 30), (x1 + 105, obstacle_top), (18, 55, 52), -1)
        cv2.rectangle(frame, (x1, obstacle_top - 30), (x1 + 105, obstacle_top), (pulse, 255, 245), 2)
        cv2.putText(
            frame,
            "obstacle",
            (x1 + 8, obstacle_top - 8),
            cv2.FONT_HERSHEY_DUPLEX,
            0.58,
            (240, 255, 250),
            1,
            cv2.LINE_AA,
        )

        cv2.putText(
            frame,
            "ECHO-SIGHT DEMO MODE",
            (95, 132),
            cv2.FONT_HERSHEY_DUPLEX,
            1.65,
            warning,
            3,
            cv2.LINE_AA,
        )
        cv2.putText(
            frame,
            "No physical camera connected. Set CAMERA_SOURCE or ESP32_CAM_URL.",
            (95, 185),
            cv2.FONT_HERSHEY_DUPLEX,
            0.95,
            (220, 240, 120),
            2,
            cv2.LINE_AA,
        )
        cv2.putText(
            frame,
            f"LOCAL TIME {time.strftime('%H:%M:%S')}",
            (95, height - 72),
            cv2.FONT_HERSHEY_DUPLEX,
            1.0,
            warning,
            2,
            cv2.LINE_AA,
        )
        cv2.putText(
            frame,
            "LIVE DEMO STREAM",
            (width - 430, height - 108),
            cv2.FONT_HERSHEY_DUPLEX,
            0.95,
            warning,
            2,
            cv2.LINE_AA,
        )

        return frame

    def _capture_loop(self) -> None:
        while self._running:
            if self._cap is None:
                break
            ret, frame = self._cap.read()
            if not ret or frame is None:
                frame = self._build_demo_frame()
                if not self._using_demo_frames:
                    print("[FrameBuffer] Camera feed unavailable. Using synthetic demo frames.")
                    self._using_demo_frames = True
            elif self._using_demo_frames:
                print("[FrameBuffer] Camera feed recovered. Returning to live frames.")
                self._using_demo_frames = False

            with self._lock:
                self._frame = frame
            time.sleep(1 / 30)

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


def _resolve_source() -> int | str:
    """Use explicit ESP32 URL when provided, otherwise local camera index."""
    explicit_esp32_url = os.getenv("ESP32_CAM_URL", "").strip()
    if explicit_esp32_url:
        return explicit_esp32_url
    return CAMERA_SOURCE


# Global singleton instance
frame_buffer = FrameBuffer(source=_resolve_source())
