from __future__ import annotations

import asyncio
import base64
import json
import time
import traceback
from typing import Any

import cv2
import google.generativeai as genai

from app.config import GEMINI_API_KEY
from app.elevenlabs_tts import speak
from app.frame_buffer import frame_buffer
from app.serial_bridge import write_haptic
from app.ws_manager import manager

SYSTEM_INSTRUCTION = """You are an accessibility spatial-grounding engine.

Return ONLY JSON:
{
  "voice_prompt": "max 10 words",
  "detections": [{"label": "string", "box": [ymin, xmin, ymax, xmax]}],
  "haptic_intensity": 0
}

Rules:
- box values must be integers on a 0-1000 scale
- haptic_intensity must be 0-255 integer
- no markdown or additional keys"""

_model = None
_tick = 0


def _get_model():
    global _model
    if _model is not None:
        return _model
    if not GEMINI_API_KEY:
        return None

    genai.configure(api_key=GEMINI_API_KEY)
    _model = genai.GenerativeModel(
        model_name="gemini-2.0-flash",
        system_instruction=SYSTEM_INSTRUCTION,
        generation_config={"temperature": 0.1, "max_output_tokens": 350},
    )
    return _model


def _sanitize(data: Any) -> dict[str, Any] | None:
    if not isinstance(data, dict):
        return None

    voice = str(data.get("voice_prompt", "Path is clear")).strip() or "Path is clear"
    words = voice.split()
    if len(words) > 10:
        voice = " ".join(words[:10])

    detections: list[dict[str, Any]] = []
    raw_detections = data.get("detections", [])
    if isinstance(raw_detections, list):
        for det in raw_detections[:12]:
            if not isinstance(det, dict):
                continue
            label = str(det.get("label", "obstacle"))[:40]
            box = det.get("box")
            if not isinstance(box, (list, tuple)) or len(box) != 4:
                continue
            try:
                ymin, xmin, ymax, xmax = [int(float(v)) for v in box]
            except (TypeError, ValueError):
                continue
            ymin = max(0, min(1000, ymin))
            xmin = max(0, min(1000, xmin))
            ymax = max(0, min(1000, ymax))
            xmax = max(0, min(1000, xmax))
            if ymax <= ymin or xmax <= xmin:
                continue
            detections.append({"label": label, "box": [ymin, xmin, ymax, xmax]})

    try:
        haptic = int(data.get("haptic_intensity", 0))
    except (TypeError, ValueError):
        haptic = 0
    haptic = max(0, min(255, haptic))

    return {"voice_prompt": voice, "detections": detections, "haptic_intensity": haptic}


def _simulate() -> dict[str, Any]:
    global _tick
    _tick += 1
    phase = _tick % 8

    if phase in (0, 1):
        return {"voice_prompt": "Path is clear", "detections": [], "haptic_intensity": 0}

    x = 170 + ((_tick * 110) % 620)
    xmin = max(0, x - 85)
    xmax = min(1000, x + 85)
    return {
        "voice_prompt": "Obstacle at 12 o'clock",
        "detections": [{"label": "obstacle", "box": [360, xmin, 980, xmax]}],
        "haptic_intensity": 165,
    }


async def _analyse_frame_once() -> None:
    """Grab latest frame, query Gemini (or simulate), dispatch results."""
    raw = frame_buffer.get()
    if raw is None:
        return

    model = _get_model()
    if model is None:
        data = _simulate()
    else:
        ok, jpg = cv2.imencode(".jpg", raw, [cv2.IMWRITE_JPEG_QUALITY, 72])
        if not ok:
            return
        image_bytes = base64.b64decode(base64.b64encode(jpg.tobytes()))

        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(
            None,
            lambda: model.generate_content(
                [
                    {"mime_type": "image/jpeg", "data": image_bytes},
                    "Analyze nearby obstacles and return JSON only.",
                ]
            ),
        )

        text = (getattr(response, "text", "") or "").strip()
        if text.startswith("```"):
            lines = [line for line in text.splitlines() if not line.strip().startswith("```")]
            text = "\n".join(lines).strip()
        data = _sanitize(json.loads(text)) or _simulate()

    voice_prompt = data.get("voice_prompt", "")
    detections = data.get("detections", [])
    haptic = int(data.get("haptic_intensity", 0))

    write_haptic(haptic)
    await manager.broadcast(
        {
            "voice_prompt": voice_prompt,
            "detections": detections,
            "haptic_intensity": haptic,
            "ts": time.time(),
        }
    )

    if voice_prompt:
        asyncio.create_task(speak(voice_prompt))


async def inference_loop() -> None:
    """Run forever, analysing one frame per second."""
    print("[gemini] Inference loop started.")
    while True:
        try:
            await _analyse_frame_once()
        except json.JSONDecodeError as exc:
            print(f"[gemini] JSON parse error: {exc}")
        except Exception:
            traceback.print_exc()
        await asyncio.sleep(1.0)
