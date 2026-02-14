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


# API Keys
GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "").strip()
ELEVENLABS_API_KEY: str = os.getenv("ELEVENLABS_API_KEY", "").strip()

# Serial/Haptic settings
SERIAL_PORT: str = os.getenv("SERIAL_PORT", "/dev/ttyUSB0")
SERIAL_BAUD: int = _as_int("SERIAL_BAUD", 115200)

# Camera settings
ESP32_CAM_URL: str = os.getenv("ESP32_CAM_URL", "http://127.0.0.1:9999/stream")
CAMERA_SOURCE: int = _as_int("CAMERA_SOURCE", 0)

# TTS settings
ELEVENLABS_VOICE_ID: str = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
