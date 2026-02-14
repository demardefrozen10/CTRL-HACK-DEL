"""Vision processing service using Google Gemini."""
from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Any, Optional

import cv2
import numpy as np

from ..config import GEMINI_API_KEY
from .frame_buffer import frame_buffer
from .websocket import ws_manager
from .haptic import send_intensity
from .tts import speak

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
_no_key_warned = False
_prev_gray: Optional[np.ndarray] = None


def _get_model():
    global _model, _no_key_warned
    if _model is not None:
        return _model
    if not GEMINI_API_KEY:
        if not _no_key_warned:
            print("[Vision] No Gemini API key, using simulation mode")
            _no_key_warned = True
        return None

    try:
        import google.generativeai as genai
        genai.configure(api_key=GEMINI_API_KEY)
        _model = genai.GenerativeModel(
            model_name="gemini-2.0-flash",
            system_instruction=SYSTEM_INSTRUCTION,
            generation_config={"temperature": 0.1, "max_output_tokens": 350},
        )
        return _model
    except Exception as e:
        print(f"[Vision] Failed to initialize Gemini: {e}")
        return None


def _sanitize(data: Any) -> Optional[dict[str, Any]]:
    """Sanitize and validate the response from Gemini."""
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


def _clock_from_x(normalized_center_x: float) -> str:
    if normalized_center_x < 0.2:
        return "10 o'clock"
    if normalized_center_x < 0.4:
        return "11 o'clock"
    if normalized_center_x < 0.6:
        return "12 o'clock"
    if normalized_center_x < 0.8:
        return "1 o'clock"
    return "2 o'clock"


def _fallback_motion_inference(frame: np.ndarray) -> dict[str, Any]:
    """Infer obstacle location/intensity from frame motion when Gemini is unavailable."""
    global _prev_gray, _tick

    _tick += 1
    height, width = frame.shape[:2]
    if height == 0 or width == 0:
        return {"voice_prompt": "Path is clear", "detections": [], "haptic_intensity": 0}

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (9, 9), 0)

    if _prev_gray is None or _prev_gray.shape != gray.shape:
        _prev_gray = gray
        return {"voice_prompt": "Scanning surroundings", "detections": [], "haptic_intensity": 0}

    delta = cv2.absdiff(gray, _prev_gray)
    _prev_gray = gray

    _, thresh = cv2.threshold(delta, 22, 255, cv2.THRESH_BINARY)
    thresh = cv2.dilate(thresh, None, iterations=2)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    frame_area = float(width * height)
    min_area = max(1200.0, frame_area * 0.003)
    largest = None
    largest_area = 0.0
    for contour in contours:
        area = cv2.contourArea(contour)
        if area > min_area and area > largest_area:
            largest = contour
            largest_area = area

    if largest is None:
        return {"voice_prompt": "Path is clear", "detections": [], "haptic_intensity": 0}

    x, y, w, h = cv2.boundingRect(largest)
    ymin = int((y / height) * 1000)
    xmin = int((x / width) * 1000)
    ymax = int(((y + h) / height) * 1000)
    xmax = int(((x + w) / width) * 1000)
    ymin = max(0, min(1000, ymin))
    xmin = max(0, min(1000, xmin))
    ymax = max(0, min(1000, ymax))
    xmax = max(0, min(1000, xmax))

    center_x_norm = (x + (w / 2.0)) / width
    clock = _clock_from_x(center_x_norm)

    area_ratio = (w * h) / frame_area
    bottom_ratio = (y + h) / height
    proximity = max(0.0, min(1.0, (0.42 * min(1.0, area_ratio * 8.0)) + (0.58 * bottom_ratio)))
    haptic_intensity = max(35, min(255, int(35 + proximity * 220)))

    return {
        "voice_prompt": f"Obstacle at {clock}",
        "detections": [{"label": "obstacle", "box": [ymin, xmin, ymax, xmax]}],
        "haptic_intensity": haptic_intensity,
    }


def analyze_frame_sync(frame: np.ndarray) -> Optional[dict[str, Any]]:
    """Synchronously analyze a single frame."""
    if frame is None:
        return None

    model = _get_model()
    if model is None:
        fallback = _fallback_motion_inference(frame)
        fallback["ts"] = time.time()
        return fallback

    ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 72])
    if not ok:
        return None
    
    b64 = base64.b64encode(jpg.tobytes()).decode("ascii")
    image_bytes = base64.b64decode(b64)

    try:
        response = model.generate_content(
            [
                {"mime_type": "image/jpeg", "data": image_bytes},
                "Analyze nearby obstacles and return JSON only.",
            ]
        )
        text = (getattr(response, "text", "") or "").strip()
        if text.startswith("```"):
            lines = [line for line in text.splitlines() if not line.strip().startswith("```")]
            text = "\n".join(lines).strip()
        
        data = _sanitize(json.loads(text))
        if data:
            data["ts"] = time.time()
            return data
        fallback = _fallback_motion_inference(frame)
        fallback["ts"] = time.time()
        return fallback
    except Exception as e:
        print(f"[Vision] Analysis error: {e}")
        fallback = _fallback_motion_inference(frame)
        fallback["ts"] = time.time()
        return fallback


async def analyze_frame_async(frame: Optional[np.ndarray] = None) -> Optional[dict[str, Any]]:
    """Asynchronously analyze a frame (uses frame_buffer if no frame provided)."""
    if frame is None:
        frame = frame_buffer.get()
    if frame is None:
        return None

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, analyze_frame_sync, frame)


async def inference_loop() -> None:
    """Continuously analyze frames and dispatch results."""
    print("[Vision] Inference loop started")
    while True:
        try:
            result = await analyze_frame_async()
            if result:
                voice_prompt = result.get("voice_prompt", "")
                haptic = int(result.get("haptic_intensity", 0))
                await set_latest_analysis(result)
                
                # Send haptic feedback
                await asyncio.to_thread(send_intensity, haptic)
                
                # Broadcast to WebSocket clients
                await ws_manager.broadcast({
                    "voice_prompt": voice_prompt,
                    "detections": result.get("detections", []),
                    "haptic_intensity": haptic,
                    "ts": result.get("ts", time.time()),
                })
                
                # Trigger TTS if needed
                if voice_prompt:
                    asyncio.create_task(speak(voice_prompt))
                    
        except Exception as e:
            print(f"[Vision] Inference error: {e}")
        
        await asyncio.sleep(1.0)


# Store latest analysis result
_latest_analysis: Optional[dict[str, Any]] = None
_analysis_lock = asyncio.Lock()


async def get_latest_analysis() -> dict[str, Any]:
    """Get the most recent analysis result."""
    async with _analysis_lock:
        return _latest_analysis or {}


async def set_latest_analysis(data: dict[str, Any]) -> None:
    """Update the latest analysis result."""
    global _latest_analysis
    async with _analysis_lock:
        _latest_analysis = data
