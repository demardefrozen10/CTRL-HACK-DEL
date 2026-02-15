from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()


def _as_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "").strip()

SERIAL_PORT = os.getenv("SERIAL_PORT", "/dev/ttyUSB0").strip()
SERIAL_BAUD = _as_int("SERIAL_BAUD", 115200)

ESP32_CAM_URL = os.getenv("ESP32_CAM_URL", "demo").strip()
CAPTURE_FPS = max(1, _as_int("CAPTURE_FPS", 30))
INFERENCE_INTERVAL_MS = max(200, _as_int("INFERENCE_INTERVAL_MS", 1000))
FRONTEND_APP_URL = os.getenv("FRONTEND_APP_URL", "http://127.0.0.1:5173").strip().rstrip("/")

ELEVENLABS_TTS_URL = os.getenv(
    "ELEVENLABS_TTS_URL", "https://api.elevenlabs.io/v1/text-to-speech"
).rstrip("/")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM").strip()
ELEVENLABS_MODEL = os.getenv("ELEVENLABS_MODEL", "eleven_flash_v2_5").strip()
ELEVENLABS_STS_MODEL = os.getenv("ELEVENLABS_STS_MODEL", "eleven_multilingual_sts_v2").strip()
ELEVENLABS_OUTPUT_FORMAT = os.getenv("ELEVENLABS_OUTPUT_FORMAT", "mp3_22050_32").strip()
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY = os.getenv(
    "ELEVENLABS_OPTIMIZE_STREAMING_LATENCY", "4"
).strip()

ALLOW_SIMULATED_INFERENCE = os.getenv("ALLOW_SIMULATED_INFERENCE", "true").lower() in {
    "1",
    "true",
    "yes",
    "on",
}

_origins = os.getenv("CORS_ORIGINS", "*").strip()
CORS_ORIGINS = (
    ["*"]
    if _origins == "*"
    else [origin.strip() for origin in _origins.split(",") if origin.strip()]
)

GEMINI_SYSTEM_INSTRUCTION = """
You are the Echo-Sight spatial grounding engine for a visually impaired user.

Return ONLY a strict JSON object in this shape:
{
  "voice_prompt": "string",
  "detections": [
    {"label": "string", "box": [ymin, xmin, ymax, xmax]}
  ],
  "haptic_intensity": 0
}

Rules:
1) voice_prompt must be 10 words or fewer, concise, and directional.
2) Every box is normalized to integers on a 0-1000 scale.
3) haptic_intensity must be an integer from 0-255.
4) If no obstacle is relevant: voice_prompt="Path is clear", detections=[], haptic_intensity=0.
5) Output raw JSON only. No markdown, no prose, no extra keys.
""".strip()
