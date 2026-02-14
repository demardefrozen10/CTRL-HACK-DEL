"""Create test user in the database."""
import sys
sys.path.insert(0, '.')

from app.database import SessionLocal, engine, Base
from app.models import User
from app.auth import get_password_hash

# Create tables
Base.metadata.create_all(bind=engine)

db = SessionLocal()

# Check if user exists
existing = db.query(User).filter(User.username == "csHub").first()
if existing:
    print("User csHub already exists, updating password...")
    existing.password = get_password_hash("12345")
else:
    print("Creating user csHub...")
    user = User(username="csHub", password=get_password_hash("12345"))
    db.add(user)

db.commit()
print("Done! User csHub with password 12345 is ready.")
db.close()
