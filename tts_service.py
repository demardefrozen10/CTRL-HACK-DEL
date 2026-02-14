import os
import io
import time
from dotenv import load_dotenv

load_dotenv()

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")

_client = None


def _get_client():
    global _client
    if _client is None:
        try:
            from elevenlabs.client import ElevenLabs
            _client = ElevenLabs(api_key=ELEVENLABS_API_KEY)
        except ImportError:
            print("[TTS] elevenlabs package not installed")
            _client = None
    return _client


def synthesize(text: str, voice: str = "Rachel") -> bytes | None:
    """
    Send text to ElevenLabs Flash v2.5 for sub-100ms TTS.
    Returns raw audio bytes (mp3) or None on failure.
    """
    client = _get_client()
    if client is None or not text:
        return None

    try:
        audio_iter = client.text_to_speech.convert(
            text=text,
            voice_id=voice,
            model_id="eleven_flash_v2_5",
            output_format="mp3_22050_32",
        )
        # Collect streamed bytes
        buf = io.BytesIO()
        for chunk in audio_iter:
            buf.write(chunk)
        return buf.getvalue()
    except Exception as e:
        print(f"[TTS] synthesis error: {e}")
        return None
