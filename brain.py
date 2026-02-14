import cv2
import serial
import time
import google.generativeai as genai
from elevenlabs.client import ElevenLabs
from elevenlabs import play
import PIL.Image
import secrets

# ==========================================
# ⚙️ CONFIGURATION (ENTER YOUR KEYS HERE)
# ==========================================
GOOGLE_API_KEY = secrets.GOOGLE_KEY
ELEVENLABS_API_KEY = secrets.ELEVEN_KEY

# We set this to your specific hardware
ARDUINO_PORT = 'COM10' 
CAMERA_INDEX = 1        # Logitech Camera
BAUD_RATE = 9600

# ==========================================
# 🚀 INITIALIZATION
# ==========================================
print("------------------------------------------------")
print("   ECHO-SIGHT: BLIND ASSISTANT (LAPTOP MODE)   ")
print("------------------------------------------------")

# 1. Setup Gemini
print("🧠 Connecting to Gemini...", end=" ")
try:
    genai.configure(api_key=GOOGLE_API_KEY)
    model = genai.GenerativeModel('gemini-pro-vision')
    print("SUCCESS")
except Exception as e:
    print(f"FAILED: {e}")

# 2. Setup ElevenLabs
print("🗣️ Connecting to ElevenLabs...", end=" ")
try:
    # Setup ElevenLabs Client
    client = ElevenLabs(api_key=ELEVENLABS_API_KEY)
    print("SUCCESS")
except Exception as e:
    print(f"FAILED: {e}")

# 3. Setup Camera
print(f"📷 Connecting to Camera {CAMERA_INDEX}...", end=" ")
camera = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW)
if not camera.isOpened():
    print("FAILED! (Trying Index 0...)")
    camera = cv2.VideoCapture(0, cv2.CAP_DSHOW) # Fallback to laptop cam

if camera.isOpened():
    print("SUCCESS")
else:
    print("CRITICAL FAILURE: No Camera Found.")
    exit()

# 4. Setup Arduino
print(f"🔌 Connecting to Arduino on {ARDUINO_PORT}...", end=" ")
try:
    arduino = serial.Serial(ARDUINO_PORT, BAUD_RATE, timeout=1)
    time.sleep(2) # Allow Arduino to reset
    print("SUCCESS")
except Exception as e:
    print(f"\n❌ ERROR: Could not find Arduino on {ARDUINO_PORT}.")
    print("   Check Device Manager. Is it still COM10?")
    arduino = None

# ==========================================
# 🔁 MAIN LOOP
# ==========================================
def speak(text):
    print(f"🗣️ AI Says: {text}")
    try:
        audio = client.generate(
            text=text,
            voice="Bella",
            model="eleven_monolingual_v1"
        )
        play(audio)
    except Exception as e:
        print(f"Audio Error: {e}")

print("\n✅ SYSTEM READY. Point the sensor at an object!")
print("   (Press 'Ctrl+C' in terminal to stop)")

last_trigger_time = 0

while True:
    try:
        # Check if Arduino sent data
        if arduino and arduino.in_waiting > 0:
            line = arduino.readline().decode('utf-8').strip()
            
            try:
                distance = int(line)
                
                # TRIGGER CONDITION: Object is closer than 50cm
                # We also add a 5-second cooldown so it doesn't spam
                if 0 < distance < 50 and (time.time() - last_trigger_time > 5):
                    print(f"\n⚠️ OBSTACLE DETECTED! ({distance} cm)")
                    last_trigger_time = time.time()

                    # 1. Capture Image
                    ret, frame = camera.read()
                    if ret:
                        # Save specifically for Gemini
                        image_path = "vision_input.jpg"
                        cv2.imwrite(image_path, frame)
                        print("📸 Image Captured.")

                        # 2. Analyze with Gemini
                        print("🧠 Analyzing...")
                        img = PIL.Image.open(image_path)
                        prompt = "You are a guide for a blind person. Briefly describe this obstacle and warn them where to walk. Keep it under 15 words."
                        
                        response = model.generate_content([prompt, img])
                        text_response = response.text
                        
                        # 3. Speak
                        speak(text_response)
                        
                        # Clear buffer to avoid backlog
                        arduino.reset_input_buffer()
                    else:
                        print("❌ Failed to grab frame from camera.")

            except ValueError:
                # Sometimes Arduino sends garbage data like "12cr2", ignore it
                pass

        # Optional: Show what the camera sees (Press 'q' to quit)
        ret, frame = camera.read()
        if ret:
            cv2.imshow('Echo-Sight Vision', frame)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
                
    except KeyboardInterrupt:
        print("\n🛑 Stopping...")
        break

# Cleanup
camera.release()
cv2.destroyAllWindows()
if arduino:
    arduino.close()