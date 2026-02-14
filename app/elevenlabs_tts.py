import asyncio
import httpx

from app.config import ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID

_http: httpx.AsyncClient | None = None


def _get_http() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=10.0)
    return _http


async def speak(text: str) -> None:
    """Send text to ElevenLabs TTS and play the returned audio."""
    if not text:
        return
    if not ELEVENLABS_API_KEY:
        print(f"[tts] simulated: {text}")
        return

    url = (
        f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"
        f"?output_format=pcm_16000"
    )
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
    }
    payload = {
        "text": text,
        "model_id": "eleven_flash_v2_5",
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75,
        },
    }

    try:
        client = _get_http()
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code == 200:
            audio_bytes = resp.content
            # Play audio in a non-blocking subprocess (aplay on Linux, afplay on macOS)
            import platform

            cmd = "aplay -f S16_LE -r 16000 -c 1" if platform.system() == "Linux" else "afplay"
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.communicate(input=audio_bytes)
        else:
            print(f"[tts] ElevenLabs error {resp.status_code}: {resp.text[:200]}")
    except Exception as exc:
        print(f"[tts] Error: {exc}")
