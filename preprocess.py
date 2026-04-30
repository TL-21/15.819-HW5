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
    """Convert numpy scalar → Python type; NaN/inf → None; round floats."""
    if v is None:
        return None
    try:
        v = float(v)
        if math.isnan(v) or math.isinf(v):
            return None
        return round(v, 4)
    except (TypeError, ValueError):
        return v


def safe_div(num, den):
    """Safe division for weighted averages."""
    try:
        den = float(den)
        if den == 0 or math.isnan(den):
            return None
        return float(num) / den
    except (TypeError, ValueError):
        return None


def main():
    # ── Load ──────────────────────────────────────────────────────────────────
    print("Loading CSVs…")
    csvs = sorted(glob.glob(os.path.join(DATA, "uber_*.csv")))
    if not csvs:
        raise FileNotFoundError(f"No uber_*.csv files found in {DATA}")

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

    numeric_cols = [
        "avg_fare",
        "total_fare",
        "avg_driver_pay",
        "avg_miles",
        "avg_trip_time",
    ]
    for c in numeric_cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")

    # ── Build weighted helper columns ─────────────────────────────────────────
    # Important:
    # The input files are already aggregated by date × hour × location_id.
    # Therefore, when aggregating to borough/hour or city/hour, averages must be
    # weighted by rides. A simple mean would incorrectly give small locations
    # the same influence as high-volume locations.

    # Fare total:
    # Prefer true total_fare if available. If it is missing/null, fall back to
    # avg_fare × rides.
    if "total_fare" in df.columns:
        df["fare_total_calc"] = df["total_fare"]
        if "avg_fare" in df.columns:
            fallback_fare = df["avg_fare"] * df["rides"]
            df["fare_total_calc"] = df["fare_total_calc"].fillna(fallback_fare)
    elif "avg_fare" in df.columns:
        df["fare_total_calc"] = df["avg_fare"] * df["rides"]

    if "avg_driver_pay" in df.columns:
        df["driver_pay_total_calc"] = df["avg_driver_pay"] * df["rides"]

    if "avg_miles" in df.columns:
        df["miles_total_calc"] = df["avg_miles"] * df["rides"]

    if "avg_trip_time" in df.columns:
        df["trip_time_total_calc"] = df["avg_trip_time"] * df["rides"]

    # ── Aggregate: date × hour × borough ─────────────────────────────────────
    print("Aggregating…")

    agg_spec = {
        "rides": ("rides", "sum"),
    }

    if "fare_total_calc" in df.columns:
        agg_spec["total_fare"] = ("fare_total_calc", "sum")

    if "driver_pay_total_calc" in df.columns:
        agg_spec["total_driver_pay"] = ("driver_pay_total_calc", "sum")

    if "miles_total_calc" in df.columns:
        agg_spec["total_miles"] = ("miles_total_calc", "sum")

    if "trip_time_total_calc" in df.columns:
        agg_spec["total_trip_time"] = ("trip_time_total_calc", "sum")

    agg = (
        df.groupby(["date", "hour", "borough"], as_index=False)
        .agg(**agg_spec)
    )

    # Ride-weighted averages at date × hour × borough level
    if "total_fare" in agg.columns:
        agg["avg_fare"] = agg.apply(
            lambda r: safe_div(r["total_fare"], r["rides"]), axis=1
        )

    if "total_driver_pay" in agg.columns:
        agg["avg_driver_pay"] = agg.apply(
            lambda r: safe_div(r["total_driver_pay"], r["rides"]), axis=1
        )

    if "total_miles" in agg.columns:
        agg["avg_miles"] = agg.apply(
            lambda r: safe_div(r["total_miles"], r["rides"]), axis=1
        )

    if "total_trip_time" in agg.columns:
        agg["avg_trip_time"] = agg.apply(
            lambda r: safe_div(r["total_trip_time"], r["rides"]), axis=1
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
            total_rides = h["rides"].sum()
            total = int(total_rides)

            # Borough breakdown
            boros = {}
            for b in BOROUGHS:
                row = h[h["borough"] == b]

                if not row.empty:
                    borough_rides = int(row["rides"].iloc[0])

                    boros[b] = {
                        "rides": borough_rides,
                        "avg_fare": safe(row["avg_fare"].iloc[0]) if "avg_fare" in row.columns else None,
                    }
                else:
                    boros[b] = {
                        "rides": 0,
                        "avg_fare": None,
                    }

            entry = {
                "h": hour,
                "rides": total,
                "boroughs": boros,
            }

            # Citywide/hourly ride-weighted averages
            # These are calculated from summed totals, not simple means of borough averages.
            if total_rides > 0:
                if "total_fare" in h.columns:
                    entry["avg_fare"] = safe(h["total_fare"].sum() / total_rides)

                if "total_driver_pay" in h.columns:
                    entry["avg_pay"] = safe(h["total_driver_pay"].sum() / total_rides)

                if "total_miles" in h.columns:
                    entry["avg_miles"] = safe(h["total_miles"].sum() / total_rides)

                if "total_trip_time" in h.columns:
                    entry["avg_trip_time"] = safe(h["total_trip_time"].sum() / total_rides)
            else:
                if "total_fare" in h.columns:
                    entry["avg_fare"] = None

                if "total_driver_pay" in h.columns:
                    entry["avg_pay"] = None

                if "total_miles" in h.columns:
                    entry["avg_miles"] = None

                if "total_trip_time" in h.columns:
                    entry["avg_trip_time"] = None

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