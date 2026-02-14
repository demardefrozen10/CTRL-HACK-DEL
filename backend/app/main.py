import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import engine, Base
from .routers import auth
from .routers.vision import router as vision_router
from .routers.tts import router as tts_router
from .routers.haptic import router as haptic_router
from .routers.stream import router as stream_router
from .routers.voice_studio import router as voice_studio_router
from .services import frame_buffer, close_haptic
from .services.vision import inference_loop

# Create database tables
Base.metadata.create_all(bind=engine)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    # Startup: start camera and inference loop
    frame_buffer.start()
    inference_task = asyncio.create_task(inference_loop())
    print("VibeGlasses services started")
    
    yield
    
    # Shutdown: clean up resources
    inference_task.cancel()
    try:
        await inference_task
    except asyncio.CancelledError:
        pass
    frame_buffer.stop()
    close_haptic()
    print("VibeGlasses services stopped")


app = FastAPI(
    title="VibeGlasses API",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS middleware for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(auth.router)
app.include_router(vision_router)
app.include_router(tts_router)
app.include_router(haptic_router)
app.include_router(stream_router)
app.include_router(voice_studio_router)


@app.get("/")
def root():
    return {"message": "VibeGlasses API is running"}


@app.get("/health")
def health_check():
    return {"status": "healthy"}
