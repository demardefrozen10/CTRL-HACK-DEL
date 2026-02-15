from __future__ import annotations

import asyncio
import logging
from contextlib import suppress

from app.config import ELEVENLABS_API_KEY
from app.services.tts import synthesize_async as shared_synthesize_async

logger = logging.getLogger("echo-sight.tts")


class TTSService:
    """Async queue worker for low-latency ElevenLabs Flash v2.5 synthesis."""

    def __init__(self) -> None:
        self._running = False
        self._worker_task: asyncio.Task | None = None
        self._queue: asyncio.Queue[str] = asyncio.Queue(maxsize=8)
        self._last_prompt = ""
        self._latest_audio: bytes | None = None
        self._audio_lock = asyncio.Lock()

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._worker_task = asyncio.create_task(self._worker(), name="tts-worker")
        logger.info("TTS service started.")
        if not ELEVENLABS_API_KEY:
            logger.info("TTS running in simulation mode (ELEVENLABS_API_KEY missing).")

    async def stop(self) -> None:
        self._running = False

        if self._worker_task is not None:
            self._worker_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._worker_task
            self._worker_task = None

        logger.info("TTS service stopped.")

    async def speak(self, text: str) -> None:
        await self.enqueue(text)

    async def enqueue(self, text: str) -> None:
        clean_text = (text or "").strip()
        if not clean_text:
            return
        if clean_text == self._last_prompt:
            return

        self._last_prompt = clean_text

        if self._queue.full():
            try:
                _ = self._queue.get_nowait()
                self._queue.task_done()
            except asyncio.QueueEmpty:
                pass

        await self._queue.put(clean_text)

    async def get_latest_audio(self) -> bytes | None:
        async with self._audio_lock:
            return self._latest_audio

    async def _worker(self) -> None:
        while True:
            text = await self._queue.get()
            try:
                await self._synthesize_once(text)
            except Exception as exc:
                logger.error("TTS worker error: %s", exc)
            finally:
                self._queue.task_done()

    async def _synthesize_once(self, text: str) -> None:
        if not ELEVENLABS_API_KEY:
            logger.debug("TTS simulated: %s", text)
            return
        audio = await shared_synthesize_async(text=text)
        if not audio:
            logger.warning("ElevenLabs synthesis failed or returned empty audio.")
            return

        async with self._audio_lock:
            self._latest_audio = audio

        logger.info("TTS generated for prompt: %s", text)
