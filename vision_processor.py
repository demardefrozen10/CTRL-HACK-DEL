from __future__ import annotations

import base64
import json
import time
from typing import Any

import cv2
import numpy as np
from dotenv import load_dotenv

load_dotenv()

SYSTEM_INSTRUCTION = """
You are an accessibility spatial-grounding engine.
Return ONLY JSON with keys:
- voice_prompt: max 10 words
- detections: [{"label": str, "box": [ymin, xmin, ymax, xmax]}] with 0-1000 ints
- haptic_intensity: integer 0-255
No markdown and no extra keys.
""".strip()

_model = None
_tick = 0


def _get_model():
    global _model
    if _model is not None:
        return _model

    import os

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None

    import google.generativeai as genai

    genai.configure(api_key=api_key)
    _model = genai.GenerativeModel(
        model_name="gemini-2.0-flash",
        system_instruction=SYSTEM_INSTRUCTION,
        generation_config={"temperature": 0.1, "max_output_tokens": 350},
    )
    return _model


def _simulate() -> dict[str, Any]:
    global _tick
    _tick += 1
    phase = _tick % 8

    if phase in (0, 1):
        return {"voice_prompt": "Path is clear", "detections": [], "haptic_intensity": 0}

    x = 180 + ((_tick * 105) % 600)
    xmin = max(0, x - 90)
    xmax = min(1000, x + 90)
    box = [370, xmin, 980, xmax]
    prompt = "Obstacle at 12 o'clock" if 380 < x < 620 else "Obstacle ahead"
    return {
        "voice_prompt": prompt,
        "detections": [{"label": "obstacle", "box": box}],
        "haptic_intensity": 160,
    }


def _sanitize(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None

    voice = str(payload.get("voice_prompt", "Path is clear")).strip() or "Path is clear"
    words = voice.split()
    if len(words) > 10:
        voice = " ".join(words[:10])

    detections_in = payload.get("detections", [])
    detections: list[dict[str, Any]] = []
    if isinstance(detections_in, list):
        for d in detections_in[:10]:
            if not isinstance(d, dict):
                continue
            label = str(d.get("label", "obstacle"))[:40]
            box = d.get("box")
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
        haptic = int(payload.get("haptic_intensity", 0))
    except (TypeError, ValueError):
        haptic = 0
    haptic = max(0, min(255, haptic))

    return {"voice_prompt": voice, "detections": detections, "haptic_intensity": haptic}


def analyze_frame(frame: np.ndarray) -> dict[str, Any] | None:
    """Analyse one frame and return normalized JSON for voice/haptics/overlay."""
    if frame is None:
        return None

    model = _get_model()
    if model is None:
        return _simulate()

    ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 72])
    if not ok:
        return None
    b64 = base64.b64encode(jpg.tobytes()).decode("ascii")

    try:
        response = model.generate_content(
            [
                {"mime_type": "image/jpeg", "data": base64.b64decode(b64)},
                "Analyze nearby obstacles and output strict JSON only.",
            ]
        )
        text = getattr(response, "text", "") or ""
        cleaned = text.strip()
        if cleaned.startswith("```"):
            lines = cleaned.splitlines()
            lines = [line for line in lines if not line.strip().startswith("```")]
            cleaned = "\n".join(lines).strip()
        payload = json.loads(cleaned)
        parsed = _sanitize(payload)
        if parsed is None:
            return None
        parsed["ts"] = time.time()
        return parsed
    except Exception:
        return _simulate()
