from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import Any

import google.generativeai as genai

from config import (
    ALLOW_SIMULATED_INFERENCE,
    GEMINI_API_KEY,
    GEMINI_SYSTEM_INSTRUCTION,
    INFERENCE_INTERVAL_MS,
)

logger = logging.getLogger("echo-sight.gemini")


class GeminiService:
    """Low-speed (1 FPS) scene understanding loop using Gemini 2.0 Flash."""

    def __init__(self) -> None:
        self._model: Any = None
        self._pipeline = None
        self._running = False
        self._tick = 0
        self.on_result = None  # async callable(result_dict)

    @property
    def enabled(self) -> bool:
        return self._model is not None

    def configure(self) -> None:
        if not GEMINI_API_KEY:
            logger.warning(
                "GEMINI_API_KEY is not set. Gemini calls disabled; simulation=%s",
                ALLOW_SIMULATED_INFERENCE,
            )
            return

        genai.configure(api_key=GEMINI_API_KEY)
        self._model = genai.GenerativeModel(
            model_name="gemini-2.0-flash",
            system_instruction=GEMINI_SYSTEM_INSTRUCTION,
            generation_config={"temperature": 0.1, "max_output_tokens": 400},
        )
        logger.info("Gemini 2.0 Flash configured.")

    def set_pipeline(self, pipeline) -> None:
        self._pipeline = pipeline

    async def start_inference_loop(self) -> None:
        self._running = True
        interval_sec = max(0.2, INFERENCE_INTERVAL_MS / 1000.0)
        logger.info("Inference loop running every %.2fs.", interval_sec)

        while self._running:
            loop_start = time.perf_counter()
            try:
                result = await self._infer_once()
                if result:
                    if self._pipeline:
                        self._pipeline.set_detections(result)
                    if self.on_result:
                        await self.on_result(result)
            except Exception as exc:
                logger.exception("Inference loop error: %s", exc)

            elapsed = time.perf_counter() - loop_start
            sleep_for = interval_sec - elapsed
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)

    async def _infer_once(self) -> dict[str, Any] | None:
        if self._pipeline is None:
            return None

        frame_b64 = self._pipeline.get_frame_base64()
        if not frame_b64:
            return None

        if self._model is None:
            if not ALLOW_SIMULATED_INFERENCE:
                return None
            return self._simulated_result()

        raw_response = await asyncio.to_thread(self._call_gemini, frame_b64)
        if not raw_response:
            return None

        parsed = self._parse_response(raw_response)
        if parsed is None:
            return None

        parsed["ts"] = time.time()
        return parsed

    def _call_gemini(self, frame_b64: str) -> str | None:
        try:
            assert self._model is not None
            image_bytes = base64.b64decode(frame_b64)
            response = self._model.generate_content(
                [
                    {"mime_type": "image/jpeg", "data": image_bytes},
                    "Analyze nearby obstacles and output JSON only.",
                ]
            )
            text = getattr(response, "text", None)
            return text.strip() if text else None
        except Exception as exc:
            logger.error("Gemini API error: %s", exc)
            return None

    def _parse_response(self, text: str) -> dict[str, Any] | None:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            lines = cleaned.splitlines()
            lines = [line for line in lines if not line.strip().startswith("```")]
            cleaned = "\n".join(lines).strip()

        try:
            payload = json.loads(cleaned)
        except json.JSONDecodeError:
            logger.warning("Gemini returned non-JSON payload: %s", cleaned[:200])
            return None

        return self._sanitize_payload(payload)

    def _sanitize_payload(self, payload: Any) -> dict[str, Any] | None:
        if not isinstance(payload, dict):
            return None

        voice_prompt = str(payload.get("voice_prompt", "Path is clear")).strip()
        if not voice_prompt:
            voice_prompt = "Path is clear"
        words = voice_prompt.split()
        if len(words) > 10:
            voice_prompt = " ".join(words[:10])

        detections_raw = payload.get("detections", [])
        detections: list[dict[str, Any]] = []
        if isinstance(detections_raw, list):
            for item in detections_raw[:12]:
                normalized = self._normalize_detection(item)
                if normalized is not None:
                    detections.append(normalized)

        haptic_intensity = self._normalize_haptic(payload.get("haptic_intensity"), detections)

        return {
            "voice_prompt": voice_prompt,
            "detections": detections,
            "haptic_intensity": haptic_intensity,
        }

    def _normalize_detection(self, item: Any) -> dict[str, Any] | None:
        if isinstance(item, dict):
            label = str(item.get("label", "obstacle")).strip() or "obstacle"
            box = item.get("box")
        elif isinstance(item, (list, tuple)):
            label = "obstacle"
            box = item
        else:
            return None

        normalized_box = self._normalize_box(box)
        if normalized_box is None:
            return None

        return {"label": label[:40], "box": normalized_box}

    @staticmethod
    def _normalize_box(box: Any) -> list[int] | None:
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            return None

        try:
            ymin, xmin, ymax, xmax = [int(float(v)) for v in box]
        except (TypeError, ValueError):
            return None

        ymin = max(0, min(1000, ymin))
        xmin = max(0, min(1000, xmin))
        ymax = max(0, min(1000, ymax))
        xmax = max(0, min(1000, xmax))

        if ymax <= ymin or xmax <= xmin:
            return None

        return [ymin, xmin, ymax, xmax]

    def _normalize_haptic(self, value: Any, detections: list[dict[str, Any]]) -> int:
        try:
            numeric = int(value)
        except (TypeError, ValueError):
            numeric = self._estimate_haptic_from_detections(detections)

        return max(0, min(255, numeric))

    @staticmethod
    def _estimate_haptic_from_detections(detections: list[dict[str, Any]]) -> int:
        if not detections:
            return 0

        strongest_score = 0.0
        for det in detections:
            ymin, xmin, ymax, xmax = det["box"]
            area = max(1, (ymax - ymin) * (xmax - xmin))
            size_score = min(1.0, area / 250_000.0)
            ground_score = min(1.0, ymax / 1000.0)
            score = min(1.0, (0.65 * size_score) + (0.35 * ground_score))
            strongest_score = max(strongest_score, score)

        return int(strongest_score * 255)

    def _simulated_result(self) -> dict[str, Any]:
        self._tick += 1
        phase = self._tick % 9

        if phase in (0, 1, 2):
            return {
                "voice_prompt": "Path is clear",
                "detections": [],
                "haptic_intensity": 0,
                "ts": time.time(),
            }

        center_x = 180 + ((self._tick * 95) % 640)
        xmin = max(0, center_x - 90)
        xmax = min(1000, center_x + 90)
        box = [370, xmin, 980, xmax]
        clock = self._clock_direction(center_x)
        voice = f"Obstacle at {clock} o'clock"
        detections = [{"label": "obstacle", "box": box}]
        intensity = self._estimate_haptic_from_detections(detections)

        return {
            "voice_prompt": voice,
            "detections": detections,
            "haptic_intensity": intensity,
            "ts": time.time(),
        }

    @staticmethod
    def _clock_direction(center_x: int) -> int:
        if center_x < 250:
            return 10
        if center_x < 400:
            return 11
        if center_x < 600:
            return 12
        if center_x < 760:
            return 1
        return 2

    def stop(self) -> None:
        self._running = False
