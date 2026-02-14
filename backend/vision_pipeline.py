from __future__ import annotations

import base64
import copy
import logging
import threading
import time
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger("echo-sight.vision")


class VisionPipeline:
    """High-speed capture pipeline for latest-frame access and MJPEG streaming."""

    def __init__(
        self,
        source: str = "0",
        target_fps: int = 30,
        jpeg_quality: int = 80,
    ) -> None:
        self._source = source
        self._placeholder_only = self._is_placeholder_source(source)
        self._target_fps = max(1, int(target_fps))
        self._jpeg_quality = max(30, min(95, int(jpeg_quality)))

        self._cap: cv2.VideoCapture | None = None
        self._capture_thread: threading.Thread | None = None
        self._running = False

        self._frame_lock = threading.Lock()
        self._latest_frame: np.ndarray | None = None
        self._latest_jpeg: bytes | None = None
        self._last_frame_ts = 0.0

        self._detections_lock = threading.Lock()
        self._latest_detections: dict[str, Any] = {
            "voice_prompt": "Path is clear",
            "detections": [],
            "haptic_intensity": 0,
            "ts": time.time(),
        }

        self._last_reconnect_attempt = 0.0
        self._last_read_error_log = 0.0
        self._last_connect_error_log = 0.0

    @property
    def target_fps(self) -> int:
        return self._target_fps

    @property
    def has_live_source(self) -> bool:
        return self._cap is not None and self._cap.isOpened()

    def start(self) -> None:
        if self._running:
            return

        self._running = True
        if self._placeholder_only:
            logger.info("Video source set to demo mode. Using placeholder frames only.")
        else:
            self._connect_camera()
        self._capture_thread = threading.Thread(
            target=self._capture_loop, name="vision-capture", daemon=True
        )
        self._capture_thread.start()
        logger.info("Vision pipeline started at %d FPS target.", self._target_fps)

    def stop(self) -> None:
        self._running = False
        if self._capture_thread and self._capture_thread.is_alive():
            self._capture_thread.join(timeout=2.0)
        self._release_camera()
        logger.info("Vision pipeline stopped.")

    def get_frame(self) -> np.ndarray | None:
        with self._frame_lock:
            if self._latest_frame is None:
                return None
            return self._latest_frame.copy()

    def get_jpeg(self) -> bytes | None:
        with self._frame_lock:
            return self._latest_jpeg

    def get_frame_base64(self) -> str | None:
        with self._frame_lock:
            if self._latest_jpeg is None:
                return None
            return base64.b64encode(self._latest_jpeg).decode("ascii")

    def set_detections(self, detections: dict[str, Any]) -> None:
        with self._detections_lock:
            self._latest_detections = copy.deepcopy(detections)

    def get_latest_detections(self) -> dict[str, Any]:
        with self._detections_lock:
            return copy.deepcopy(self._latest_detections)

    def get_last_frame_timestamp(self) -> float:
        with self._frame_lock:
            return self._last_frame_ts

    def _capture_loop(self) -> None:
        frame_interval = 1.0 / self._target_fps
        encode_params = [cv2.IMWRITE_JPEG_QUALITY, self._jpeg_quality]

        while self._running:
            loop_start = time.perf_counter()
            frame = self._read_frame()

            if frame is not None:
                ok, jpeg = cv2.imencode(".jpg", frame, encode_params)
                if ok:
                    with self._frame_lock:
                        self._latest_frame = frame
                        self._latest_jpeg = jpeg.tobytes()
                        self._last_frame_ts = time.time()

            elapsed = time.perf_counter() - loop_start
            sleep_for = frame_interval - elapsed
            if sleep_for > 0:
                time.sleep(sleep_for)

    def _read_frame(self) -> np.ndarray:
        if self._placeholder_only:
            return self._build_placeholder_frame()

        if self._cap is not None and self._cap.isOpened():
            ok, frame = self._cap.read()
            if ok and frame is not None:
                return frame

            now = time.time()
            if now - self._last_read_error_log >= 2.0:
                logger.warning("Camera frame read failed. Reconnecting...")
                self._last_read_error_log = now
            self._release_camera()

        now = time.time()
        if now - self._last_reconnect_attempt >= 8.0:
            self._last_reconnect_attempt = now
            self._connect_camera()

        return self._build_placeholder_frame()

    def _connect_camera(self) -> None:
        if self._placeholder_only:
            self._cap = None
            return

        source = self._coerce_source(self._source)
        cap = cv2.VideoCapture(source)

        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        cap.set(cv2.CAP_PROP_FPS, float(self._target_fps))

        if cap.isOpened():
            self._cap = cap
            logger.info("Video source connected: %s", self._source)
            return

        cap.release()
        self._cap = None
        now = time.time()
        if now - self._last_connect_error_log >= 30.0:
            logger.warning(
                "Could not open video source '%s'. Using placeholder frames.",
                self._source,
            )
            self._last_connect_error_log = now

    def _release_camera(self) -> None:
        if self._cap is not None:
            self._cap.release()
        self._cap = None

    @staticmethod
    def _coerce_source(source: str) -> str | int:
        try:
            return int(source)
        except ValueError:
            return source

    @staticmethod
    def _is_placeholder_source(source: str) -> bool:
        return str(source).strip().lower() in {"demo", "placeholder", "none", "off"}

    @staticmethod
    def _build_placeholder_frame() -> np.ndarray:
        frame = np.zeros((720, 1280, 3), dtype=np.uint8)
        frame[:, :] = (6, 10, 12)

        accent = (0, 255, 208)
        dim = (0, 140, 120)
        now = time.strftime("%H:%M:%S")

        cv2.putText(
            frame,
            "Echo-Sight Demo Feed",
            (60, 130),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.8,
            accent,
            3,
            cv2.LINE_AA,
        )
        cv2.putText(
            frame,
            "Waiting for ESP32-CAM stream...",
            (60, 210),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.1,
            dim,
            2,
            cv2.LINE_AA,
        )
        cv2.rectangle(frame, (55, 250), (1225, 670), dim, 2)
        cv2.line(frame, (640, 250), (640, 670), dim, 1)
        cv2.line(frame, (55, 460), (1225, 460), dim, 1)
        cv2.putText(
            frame,
            f"LOCAL TIME {now}",
            (60, 705),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            accent,
            2,
            cv2.LINE_AA,
        )
        return frame


def generate_mjpeg(pipeline: VisionPipeline):
    """Yield an MJPEG multipart stream from latest encoded frames."""
    while True:
        jpeg = pipeline.get_jpeg()
        if jpeg is not None:
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
            )
        time.sleep(1.0 / pipeline.target_fps)
