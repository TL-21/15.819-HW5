"""
Generate dow_heatmap.json from existing static/data/by_date/*.json files.
Run:  python generate_heatmap.py

Writes: static/data/dow_heatmap.json
"""
import os, json, glob
from datetime import datetime

BASE     = os.path.dirname(__file__)
BY_DATE  = os.path.join(BASE, "static", "data", "by_date")
OUT_FILE = os.path.join(BASE, "static", "data", "dow_heatmap.json")

# day 0 = Monday (Python weekday()), we want 0 = Sunday for display
# We'll store as Sun=0 … Sat=6
DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

sums   = [[0]*24 for _ in range(7)]   # sums[dow][hour]
counts = [[0]*24 for _ in range(7)]   # number of dates contributing

files = sorted(glob.glob(os.path.join(BY_DATE, "*.json")))
print(f"Processing {len(files)} date files…")

for path in files:
    date_str = os.path.basename(path).replace(".json", "")
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        continue
    dow = dt.weekday()          # Mon=0 … Sun=6
    dow_idx = (dow + 1) % 7     # shift so Sun=0 … Sat=6

    with open(path) as f:
        day = json.load(f)

    for entry in day.get("hours", []):
        h = entry["h"]
        r = entry.get("rides", 0)
        sums[dow_idx][h]   += r
        counts[dow_idx][h] += 1

avg_rides = [
    [round(sums[d][h] / counts[d][h]) if counts[d][h] else 0
     for h in range(24)]
    for d in range(7)
]

out = {
    "days":      DOW_LABELS,
    "hours":     list(range(24)),
    "avg_rides": avg_rides,
}

with open(OUT_FILE, "w") as f:
    json.dump(out, f, separators=(",", ":"))

print(f"Written: {OUT_FILE}")
