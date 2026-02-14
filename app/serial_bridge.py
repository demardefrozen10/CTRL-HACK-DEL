import serial
import threading
from typing import Optional

from app.config import SERIAL_PORT, SERIAL_BAUD

_ser: Optional[serial.Serial] = None
_lock = threading.Lock()


def open_port() -> None:
    global _ser
    try:
        _ser = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=1)
        print(f"[serial_bridge] Opened {SERIAL_PORT} @ {SERIAL_BAUD}")
    except Exception as exc:
        print(f"[serial_bridge] Could not open serial port: {exc}")
        _ser = None


def write_haptic(intensity: int) -> None:
    """Write a single byte (0-255) to the ESP32 for motor PWM."""
    intensity = max(0, min(255, int(intensity)))
    with _lock:
        if _ser and _ser.is_open:
            try:
                _ser.write(bytes([intensity]))
            except Exception as exc:
                print(f"[serial_bridge] Write error: {exc}")


def close_port() -> None:
    global _ser
    with _lock:
        if _ser and _ser.is_open:
            _ser.close()
            print("[serial_bridge] Port closed.")
