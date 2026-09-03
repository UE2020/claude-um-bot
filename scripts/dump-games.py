"""Stream game records out of mafia.db as JSON lines: {"id": ..., "content": ...}.

Used by scripts/build-dataset.mjs, which has no SQLite driver of its own.
    python scripts/dump-games.py mafia.db [limit] [offset]
"""
import json
import sqlite3
import sys

db_path = sys.argv[1] if len(sys.argv) > 1 else "mafia.db"
limit = int(sys.argv[2]) if len(sys.argv) > 2 else -1
offset = int(sys.argv[3]) if len(sys.argv) > 3 else 0

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
query = "select id, content from games order by id limit ? offset ?"
for game_id, content in db.execute(query, (limit, offset)):
    sys.stdout.write(json.dumps({"id": game_id, "content": content}, ensure_ascii=False))
    sys.stdout.write("\n")
