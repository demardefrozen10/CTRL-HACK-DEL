"""Configuration settings loaded from environment variables."""
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


def _as_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _as_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# API Keys
GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "").strip()
ELEVENLABS_API_KEY: str = os.getenv("ELEVENLABS_API_KEY", "").strip()

# Serial/Haptic settings
SERIAL_PORT: str = os.getenv("SERIAL_PORT", "/dev/ttyUSB0")
SERIAL_BAUD: int = _as_int("SERIAL_BAUD", 115200)

# Camera settings
ESP32_CAM_URL: str = os.getenv("ESP32_CAM_URL", "http://127.0.0.1:9999/stream")
CAMERA_SOURCE: int = _as_int("CAMERA_SOURCE", 0)
FRONTEND_APP_URL: str = os.getenv("FRONTEND_APP_URL", "http://127.0.0.1:5173").strip().rstrip("/")

# TTS settings
ELEVENLABS_VOICE_ID: str = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
ELEVENLABS_TTS_URL: str = os.getenv(
    "ELEVENLABS_TTS_URL", "https://api.elevenlabs.io/v1/text-to-speech"
).rstrip("/")
ELEVENLABS_MODEL: str = os.getenv("ELEVENLABS_MODEL", "eleven_flash_v2_5").strip()
ELEVENLABS_STS_MODEL: str = os.getenv("ELEVENLABS_STS_MODEL", "eleven_multilingual_sts_v2").strip()
ELEVENLABS_OUTPUT_FORMAT: str = os.getenv("ELEVENLABS_OUTPUT_FORMAT", "mp3_22050_32").strip()
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY: str = os.getenv(
    "ELEVENLABS_OPTIMIZE_STREAMING_LATENCY",
    "4",
).strip()
ELEVENLABS_DEFAULT_USE_SPEAKER_BOOST: bool = _as_bool(
    "ELEVENLABS_DEFAULT_USE_SPEAKER_BOOST",
    True,
)
ELEVENLABS_TEXT_NORMALIZATION: str = os.getenv(
    "ELEVENLABS_TEXT_NORMALIZATION",
    "auto",
).strip()
ELEVENLABS_DEFAULT_LANGUAGE_CODE: str = os.getenv(
    "ELEVENLABS_DEFAULT_LANGUAGE_CODE",
    "",
).strip()
ELEVENLABS_DEFAULT_SEED: int = _as_int("ELEVENLABS_DEFAULT_SEED", -1)
ELEVENLABS_DEFAULT_STABILITY: float = _as_float("ELEVENLABS_DEFAULT_STABILITY", 0.5)
ELEVENLABS_DEFAULT_CLARITY: float = _as_float("ELEVENLABS_DEFAULT_CLARITY", 0.75)
ELEVENLABS_DEFAULT_STYLE_EXAGGERATION: float = _as_float(
    "ELEVENLABS_DEFAULT_STYLE_EXAGGERATION",
    0.0,
)
ELEVENLABS_DEFAULT_PLAYBACK_SPEED: float = _as_float("ELEVENLABS_DEFAULT_PLAYBACK_SPEED", 1.0)
