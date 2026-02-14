"""Serial communication for haptic feedback."""
from __future__ import annotations

import threading
from typing import Optional

from ..config import SERIAL_PORT, SERIAL_BAUD

_ser = None
_lock = threading.Lock()
_connection_warned = False


def _get_serial():
    global _ser, _connection_warned
    if _ser is None:
        try:
            import serial
            _ser = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=1)
            print(f"[Haptic] Connected to {SERIAL_PORT} @ {SERIAL_BAUD}")
            _connection_warned = False
        except Exception as e:
            if not _connection_warned:
                print(f"[Haptic] Serial not available: {e}")
                _connection_warned = True
            _ser = None
    return _ser


def send_intensity(value: int) -> bool:
    """Send haptic intensity (0-255) to ESP32 as a single byte."""
    value = max(0, min(255, int(value)))
    with _lock:
        s = _get_serial()
        if s and s.is_open:
            try:
                s.write(bytes([value]))
                return True
            except Exception as e:
                print(f"[Haptic] Write error: {e}")
                return False
    return False


def close() -> None:
    """Close the serial connection."""
    global _ser
    with _lock:
        if _ser and _ser.is_open:
            _ser.close()
            _ser = None
            print("[Haptic] Serial connection closed")


def is_connected() -> bool:
    """Check if serial connection is active."""
    with _lock:
        return _ser is not None and _ser.is_open
