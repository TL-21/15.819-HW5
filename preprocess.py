"""
One-time preprocessing script.
Run:  python preprocess.py

Reads:  data/uber_*.csv  +  data/taxi_zone_lookup.csv
Writes: static/data/meta.json
        static/data/daily.json
        static/data/by_date/<YYYY-MM-DD>.json   (one per day)
"""

import os, json, glob, math
import pandas as pd
from tqdm import tqdm

BASE    = os.path.dirname(__file__)
DATA    = os.path.join(BASE, "data")
OUT     = os.path.join(BASE, "static", "data")
BY_DATE = os.path.join(OUT, "by_date")
os.makedirs(BY_DATE, exist_ok=True)

BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]


def safe(v):
    """Convert numpy scalar → Python type; NaN → None."""
    if v is None:
        return None
    try:
        if math.isnan(float(v)):
            return None
        return round(float(v), 4)
    except (TypeError, ValueError):
        return v


def main():
    # ── Load ──────────────────────────────────────────────────────────────────
    print("Loading CSVs…")
    csvs = sorted(glob.glob(os.path.join(DATA, "uber_*.csv")))
    df = pd.concat([pd.read_csv(f, low_memory=False) for f in csvs], ignore_index=True)

    zones = pd.read_csv(os.path.join(DATA, "taxi_zone_lookup.csv"))
    zones.columns = zones.columns.str.lower()
    zones = zones.rename(columns={"locationid": "location_id"})

    # ── Clean ─────────────────────────────────────────────────────────────────
    df = df.merge(zones[["location_id", "borough"]], on="location_id", how="left")
    df["borough"] = df["borough"].fillna("Unknown")
    df["date"]  = pd.to_datetime(df["date"]).dt.date.astype(str)
    df["hour"]  = pd.to_numeric(df["hour"],  errors="coerce").fillna(0).astype(int)
    df["rides"] = pd.to_numeric(df["rides"], errors="coerce").fillna(0)
    for c in ["avg_fare", "avg_driver_pay", "avg_miles"]:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")

    # ── Aggregate: date × hour × borough ─────────────────────────────────────
    print("Aggregating…")
    fare_cols = [c for c in ["avg_fare", "avg_driver_pay", "avg_miles"] if c in df.columns]
    agg = (
        df.groupby(["date", "hour", "borough"])
        .agg(rides=("rides", "sum"), **{c: (c, "mean") for c in fare_cols})
        .reset_index()
    )

    # ── Daily totals ──────────────────────────────────────────────────────────
    daily_df = (
        agg.groupby("date")["rides"].sum()
        .reset_index(name="rides")
        .sort_values("date")
    )
    daily_df["rides_wow"] = daily_df["rides"].shift(7)
    daily_df["wow_pct"]   = (daily_df["rides"] - daily_df["rides_wow"]) / daily_df["rides_wow"]

    daily_out = [
        {
            "date":      r["date"],
            "rides":     int(r["rides"]),
            "rides_wow": int(r["rides_wow"]) if pd.notna(r["rides_wow"]) else None,
            "wow_pct":   safe(r["wow_pct"]),
        }
        for _, r in daily_df.iterrows()
    ]
    with open(os.path.join(OUT, "daily.json"), "w") as f:
        json.dump(daily_out, f, separators=(",", ":"))
    print(f"  daily.json  ({len(daily_out)} days)")

    # ── Per-date files ────────────────────────────────────────────────────────
    dates = sorted(agg["date"].unique())
    print(f"Writing {len(dates)} date files…")

    for date in tqdm(dates):
        day = agg[agg["date"] == date]
        hours_data = []

        for hour in range(24):
            h = day[day["hour"] == hour]
            total = int(h["rides"].sum())

            # Borough breakdown
            boros = {}
            for b in BOROUGHS:
                row = h[h["borough"] == b]
                if not row.empty:
                    boros[b] = {
                        "rides":    int(row["rides"].iloc[0]),
                        "avg_fare": safe(row["avg_fare"].iloc[0]) if "avg_fare" in row.columns else None,
                    }
                else:
                    boros[b] = {"rides": 0, "avg_fare": None}

            entry = {"h": hour, "rides": total, "boroughs": boros}
            if "avg_fare"        in h.columns: entry["avg_fare"] = safe(h["avg_fare"].mean())
            if "avg_driver_pay"  in h.columns: entry["avg_pay"]  = safe(h["avg_driver_pay"].mean())
            if "avg_miles"       in h.columns: entry["avg_miles"]= safe(h["avg_miles"].mean())
            hours_data.append(entry)

        path = os.path.join(BY_DATE, f"{date}.json")
        with open(path, "w") as f:
            json.dump({"date": date, "hours": hours_data}, f, separators=(",", ":"))

    # ── Meta ──────────────────────────────────────────────────────────────────
    meta = {
        "dates":      dates,
        "boroughs":   BOROUGHS,
        "date_range": {"start": dates[0], "end": dates[-1]},
    }
    with open(os.path.join(OUT, "meta.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))

    print(f"\nDone — {len(dates)} dates, {len(daily_out)} daily rows.")
    print("Run:  python serve.py")


if __name__ == "__main__":
    main()
