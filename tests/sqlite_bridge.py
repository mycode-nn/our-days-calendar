import json, sqlite3, sys

request = json.load(sys.stdin)
db = sqlite3.connect(request["database"])
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys = ON")
if request["mode"] == "migration":
    db.executescript(request["sql"].replace("--> statement-breakpoint", ""))
    result = {"ok": True}
else:
    cur = db.execute(request["sql"], request.get("params", []))
    if request["mode"] == "first":
        row = cur.fetchone()
        result = dict(row) if row else None
    elif request["mode"] == "all":
        result = {"results": [dict(row) for row in cur.fetchall()]}
    else:
        result = {"meta": {"changes": max(cur.rowcount, 0)}}
    db.commit()
print(json.dumps(result, ensure_ascii=False))
