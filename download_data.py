"""
Download and aggregate NYC TLC High-Volume FHV trip records for Uber.

Usage:
    python download_data.py --years 2023 2024

What it does:
1. Downloads monthly Parquet files from the NYC TLC open data CDN.
2. Filters rows where hvfhs_license_num == "HV0003" (Uber).
3. Aggregates to date × hour × PULocationID with ride counts + fare stats.
4. Saves one CSV per year to data/uber_{year}_agg.csv.
5. Also downloads the TLC zone lookup table to data/taxi_zone_lookup.csv.

The raw Parquet files are discarded after aggregation to save disk space.
Each monthly file is ~300–800 MB; the aggregated CSV is ~1–5 MB.
"""

import argparse
import os
import requests
import tempfile
import pandas as pd
import pyarrow.parquet as pq
import pyarrow.compute as pc
import pyarrow as pa
from tqdm import tqdm

BASE_URL = "https://d37ci6vzurychx.cloudfront.net/trip-data/fhvhv_tripdata_{year}-{month:02d}.parquet"
ZONE_URL = "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv"
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
UBER_LICENSE = "HV0003"


def download_file(url: str, dest: str, desc: str = "") -> bool:
    """Stream-download a file with a progress bar. Returns True on success."""
    try:
        r = requests.get(url, stream=True, timeout=60)
        r.raise_for_status()
    except requests.RequestException as e:
        print(f"  [SKIP] {desc}: {e}")
        return False

    total = int(r.headers.get("content-length", 0))
    with open(dest, "wb") as f, tqdm(
        desc=desc, total=total, unit="B", unit_scale=True, leave=False
    ) as bar:
        for chunk in r.iter_content(chunk_size=1 << 20):
            f.write(chunk)
            bar.update(len(chunk))
    return True


def aggregate_parquet(path: str) -> pd.DataFrame:
    """Read a TLC FHVHV parquet file, filter for Uber, and aggregate."""
    table = pq.read_table(
        path,
        columns=[
            "hvfhs_license_num",
            "pickup_datetime",
            "PULocationID",
            "base_passenger_fare",
            "driver_pay",
            "trip_miles",
            "trip_time",
        ],
    )

    # Filter for Uber
    mask = pc.equal(table["hvfhs_license_num"], UBER_LICENSE)
    table = table.filter(mask)

    if table.num_rows == 0:
        return pd.DataFrame()

    df = table.to_pandas()
    df["pickup_datetime"] = pd.to_datetime(df["pickup_datetime"])
    df["date"] = df["pickup_datetime"].dt.date
    df["hour"] = df["pickup_datetime"].dt.hour

    agg = (
        df.groupby(["date", "hour", "PULocationID"])
        .agg(
            rides=("pickup_datetime", "count"),
            avg_fare=("base_passenger_fare", "mean"),
            total_fare=("base_passenger_fare", "sum"),
            avg_driver_pay=("driver_pay", "mean"),
            avg_miles=("trip_miles", "mean"),
            avg_trip_time=("trip_time", "mean"),
        )
        .reset_index()
        .rename(columns={"PULocationID": "location_id"})
    )
    agg["date"] = pd.to_datetime(agg["date"])
    return agg


def process_year(year: int) -> None:
    out_path = os.path.join(DATA_DIR, f"uber_{year}_agg.csv")
    frames = []

    print(f"\n── Processing {year} ──")
    for month in range(1, 13):
        url = BASE_URL.format(year=year, month=month)
        desc = f"{year}-{month:02d}"

        with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as tmp:
            tmp_path = tmp.name

        try:
            ok = download_file(url, tmp_path, desc=desc)
            if not ok:
                continue
            print(f"  Aggregating {desc}…", end=" ", flush=True)
            agg = aggregate_parquet(tmp_path)
            if not agg.empty:
                frames.append(agg)
                print(f"{len(agg):,} rows")
            else:
                print("0 rows (no Uber data?)")
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    if frames:
        combined = pd.concat(frames, ignore_index=True)
        combined.to_csv(out_path, index=False)
        print(f"\nSaved {len(combined):,} rows → {out_path}")
    else:
        print(f"No data aggregated for {year}.")


def download_zone_lookup() -> None:
    dest = os.path.join(DATA_DIR, "taxi_zone_lookup.csv")
    if os.path.exists(dest):
        print("Zone lookup already exists, skipping.")
        return
    print("Downloading zone lookup…")
    ok = download_file(ZONE_URL, dest, desc="taxi_zone_lookup.csv")
    if ok:
        print(f"Saved → {dest}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Download and aggregate Uber NYC TLC data.")
    parser.add_argument(
        "--years", nargs="+", type=int, default=[2023, 2024],
        help="Years to download (default: 2023 2024)",
    )
    args = parser.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    download_zone_lookup()

    for year in args.years:
        out_path = os.path.join(DATA_DIR, f"uber_{year}_agg.csv")
        if os.path.exists(out_path):
            print(f"\nuber_{year}_agg.csv already exists — skipping. Delete it to re-download.")
            continue
        process_year(year)

    print("\nDone. Run:  streamlit run app.py")


if __name__ == "__main__":
    main()
