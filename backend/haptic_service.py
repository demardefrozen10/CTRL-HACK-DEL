from __future__ import annotations

import logging
import threading

import serial

from config import SERIAL_BAUD, SERIAL_PORT

logger = logging.getLogger("echo-sight.haptic")


class HapticService:
    """Writes a single 0-255 PWM intensity byte to ESP32 over serial."""

    def __init__(self) -> None:
        self._serial: serial.Serial | None = None
        self._connected = False
        self._lock = threading.Lock()
        self._last_intensity = 0

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def last_intensity(self) -> int:
        return self._last_intensity

    def connect(self) -> None:
        if not SERIAL_PORT:
            logger.warning("SERIAL_PORT is empty. Haptics disabled.")
            self._connected = False
            return

        try:
            self._serial = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=0.2)
            self._connected = True
            logger.info("Haptic serial connected: %s @ %d", SERIAL_PORT, SERIAL_BAUD)
        except serial.SerialException as exc:
            self._serial = None
            self._connected = False
            logger.warning("Serial connection failed: %s. Running in simulated mode.", exc)

    def send_intensity(self, intensity: int) -> None:
        value = max(0, min(255, int(intensity)))
        self._last_intensity = value

        if not self._connected or self._serial is None:
            logger.debug("Haptic simulated value: %d", value)
            return

        with self._lock:
            try:
                self._serial.write(bytes([value]))
                self._serial.flush()
            except serial.SerialException as exc:
                logger.error("Serial write failed: %s", exc)
                self._connected = False

    def disconnect(self) -> None:
        with self._lock:
            if self._serial is not None and self._serial.is_open:
                self._serial.close()
        self._serial = None
        self._connected = False
        logger.info("Haptic serial disconnected.")
