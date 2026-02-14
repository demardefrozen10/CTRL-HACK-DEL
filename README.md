# 🔊 Echo-Sight — Accessibility Wearable

> **CTRL+HACK+DEL 2.0 Hackathon Project**
> A real-time AI-powered wearable that helps visually impaired users navigate the world using spatial audio, haptic feedback, and computer vision.

## Architecture

```
ESP32-CAM (30 FPS) ──► FastAPI Backend
                           ├── Thread A: MJPEG Stream → /video_feed
                           ├── Thread B: 1 FPS → Gemini 2.0 Flash (scene understanding)
                           ├── ElevenLabs TTS → Audio feedback (~75ms)
                           ├── PySerial → ESP32 Haptic Motor (PWM 0-255)
                           └── WebSocket → React Dashboard (neon overlays)
```

## Quick Start

### 1. Clone & Branch
```bash
git clone https://github.com/demardefrozen10/CTRL-HACK-DEL.git
cd CTRL-HACK-DEL
git checkout -b dev
```

### 2. Install Dependencies
```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Environment Variables
Create a `.env` file in `backend/`:
```
GEMINI_API_KEY=your_gemini_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key
SERIAL_PORT=/dev/ttyUSB0
ESP32_CAM_URL=http://192.168.1.100:81/stream
CAPTURE_FPS=30
INFERENCE_INTERVAL_MS=1000
ALLOW_SIMULATED_INFERENCE=true
```

For no-hardware demos, set `ESP32_CAM_URL=demo`.

### 4. Run
```bash
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### 5. Open Dashboard
Navigate to `http://localhost:8000/dashboard`

## Hardware
- **ESP32-CAM** — 30 FPS video feed
- **HC-SR04** — Ultrasonic distance sensor
- **Vibration Motor** — Haptic feedback via PWM
- **Arduino/ESP32** — Motor controller

## API Endpoints
| Endpoint | Method | Description |
|---|---|---|
| `/video_feed` | GET | MJPEG stream (Sighted Ally View) |
| `/dashboard` | GET | Neon-on-black accessibility dashboard |
| `/ws` | WS | Real-time detections broadcast |
| `/health` | GET | Health check |

## Team
**Big 3** — CTRL+HACK+DEL 2.0
