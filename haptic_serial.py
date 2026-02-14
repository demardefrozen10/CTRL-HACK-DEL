import os
import threading
from dotenv import load_dotenv

load_dotenv()

SERIAL_PORT = os.getenv("SERIAL_PORT", "/dev/ttyUSB0")
SERIAL_BAUD = int(os.getenv("SERIAL_BAUD", "115200"))

_ser = None
_lock = threading.Lock()


def _get_serial():
    global _ser
    if _ser is None:
        try:
            import serial  # from pyserial
            _ser = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=1)
            print(f"[HAPTIC] Connected to {SERIAL_PORT} @ {SERIAL_BAUD}")
        except Exception as e:
            print(f"[HAPTIC] Serial connection failed: {e}")
            _ser = None
    return _ser


def send_intensity(value: int):
    """Send haptic intensity (0-255) to ESP32 as a single byte."""
    value = max(0, min(255, int(value)))
    with _lock:
        s = _get_serial()
        if s and s.is_open:
            try:
                s.write(bytes([value]))
            except Exception as e:
                print(f"[HAPTIC] Write error: {e}")


def close():
    global _ser
    with _lock:
        if _ser and _ser.is_open:
            _ser.close()
            _ser = None
