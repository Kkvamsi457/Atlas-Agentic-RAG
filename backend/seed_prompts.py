"""Seed initial prompt documents into MongoDB without overwriting admin edits."""
import json
from datetime import datetime, timezone
from pathlib import Path
from app.auth import prompts

def seed_prompts():
    seed_file = Path(__file__).resolve().parent / "prompts_seed.json"
    with seed_file.open("r", encoding="utf-8") as f:
        items = json.load(f)
    now = datetime.now(timezone.utc)
    for item in items:
        document = {**item, "is_active": True, "created_at": now, "updated_at": now}
        prompts.update_one({"code": item["code"]}, {"$setOnInsert": document}, upsert=True)
    print(f"Prompt seeding complete. Checked {len(items)} prompt definitions; existing prompts were preserved.")

if __name__ == "__main__":
    seed_prompts()
