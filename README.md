# Uber NYC Operations Center — Assignment 5

## Overview

This dashboard simulates the real-time operations view that Uber's NYC General Manager would use to monitor ride performance, revenue health, geographic demand, and driver economics. It replays two years of actual TLC trip data (Jan 2023 – Dec 2024) as an animated time-series, advancing hour by hour with configurable playback speed.

---

## Assignment Choices & Rationale

### Data Choice: Contemporary TLC data (2023–2024) vs. 2014–2015

We chose the contemporary dataset because:
- It includes **pricing data** (`base_passenger_fare`, `driver_pay`) — critical for any revenue or economics view
- Two full calendar years (731 days) give strong seasonal signal: both winter slowdowns and summer/holiday peaks are visible
- The 2014–2015 data lacks fare information and covers only 9 months

The Uber subset is identified by `hvfhs_license_num = HV0003` in the High Volume For-Hire Vehicle Trip Records.

### Dashboard Elements (5 distinct elements, satisfying the 3–5 recommendation)

| # | Element | GM Decision it Supports |
|---|---------|------------------------|
| 1 | **24-HR Demand Pulse** — today vs. yesterday line chart | Intraday supply planning, spot anomalies early |
| 2 | **Borough Breakdown** — animated horizontal bars | Geographic marketing allocation, driver positioning |
| 3 | **NYC Live Demand Map** — animated bubble map | Visual hotspot identification, surge zone targeting |
| 4 | **Revenue Ops + Per-Ride Economics** — two KPI grids | Revenue pacing, take-rate monitoring, driver pay health |
| 5 | **90-Day Trailing Trend** — rolling WoW comparison | Strategic trend identification, seasonality, growth tracking |

The **GM Alerts** panel and top **KPI row** are supporting elements that tie the five elements together into actionable signals.

### Why not Tableau/Streamlit?

We evaluated Streamlit but encountered fundamental limitations: full-page Python reruns on every slider move produced jerky animation and broken HTML rendering. Tableau does not natively support animated time playback. We built a pure HTML/CSS/JavaScript frontend because:
- `setInterval` + `requestAnimationFrame` enables **frame-rate-smooth** animation
- Pre-computed JSON files mean **zero server computation** during playback — latency is <1ms per frame
- The result is a completely self-contained static site that any browser can run

---

## System Architecture

```
Raw Parquet files (NYC TLC, ~400 MB/year)
        │
        ▼
download_data.py        ← filters HV0003, aggregates to date×hour×location
        │
        ▼
data/uber_2023_agg.csv  (198 MB)
data/uber_2024_agg.csv  (200 MB)
data/taxi_zone_lookup.csv
        │
        ▼
preprocess.py           ← joins zone→borough, computes hourly stats, writes JSON
        │
        ▼
static/data/
  ├── meta.json         ← list of 731 dates, borough names, date range
  ├── daily.json        ← 731 rows: {date, rides, rides_wow, wow_pct}
  └── by_date/
        └── YYYY-MM-DD.json  (× 731)   ← one file per calendar day
        │
        ▼
serve.py                ← Python http.server on localhost:8050
        │
        ▼
Browser: index.html + style.css + app.js
         Leaflet.js (map)  +  Plotly.js (charts)  — served from static/libs/
```

### Why pre-compute 731 JSON files?

Loading all data at once would require the browser to parse ~14 MB of JSON on startup. Instead, each date file is ~8–12 KB. The browser fetches today + yesterday + last-week in parallel (`Promise.all`) — three small requests totaling ~30 KB. Date navigation is instant; playback never blocks.

### Playback Engine

```
setInterval(tick, speedMs)          ← advances S.hour by 1 each tick
  └── if hour wraps past 23:        ← advance date index, fetch next date JSON
      await loadDateRange()
  └── updateAll()
        ├── updateHeader()          ← clock face, date, live/paused badge
        ├── updateKPIs()            ← 4 headline cards with animated number tween
        ├── updateDemandChart()     ← Plotly.react() with 280ms transition
        ├── updateBoroBar()         ← CSS width transition (GPU-accelerated)
        ├── updateEco()             ← revenue ops + per-ride grids
        ├── updateAlerts()          ← rule-based GM signal engine
        ├── updateMap()             ← requestAnimationFrame ease-out marker resize
        └── updateTrendCursor()     ← Plotly.react() rolling 90-day window
```

Speed options: ½× (2 s/hr) → 1× (1 s/hr) → 2× (500 ms/hr) → 4× (250 ms/hr) → 10× (100 ms/hr). At 10×, a full year plays back in ~24 seconds.

---

## Data Pipeline Details

### `download_data.py`
Downloads monthly Parquet files from NYC TLC CDN for 2023 and 2024. For each month:
- Filters rows where `hvfhs_license_num == "HV0003"` (Uber)
- Aggregates by `pickup_date × hour × PULocationID`
- Computes: `total_rides`, `avg_base_passenger_fare`, `avg_driver_pay`, `avg_trip_miles`
- Writes `data/uber_2023_agg.csv` and `data/uber_2024_agg.csv`

### `preprocess.py`
Joins aggregated CSVs with `taxi_zone_lookup.csv` (LocationID → Borough). For each of the 731 calendar dates:
- Groups by `hour × borough`
- Computes hourly borough-level rides, avg fare, avg driver pay, avg miles
- Writes `static/data/by_date/YYYY-MM-DD.json`

Also writes:
- `meta.json`: sorted list of all 731 dates + borough list
- `daily.json`: total daily rides + 7-day lag (rides_wow) for the trend chart

---

## Dashboard Elements — Detailed Documentation

### Header: Live Clock & Date Navigation

The clock displays the **simulated date and time** of the data being shown, not the real wall clock. This creates the "as if you are the GM on that day" experience. The colon blinks when playback is running (LIVE badge) and is static when paused.

- **◀ / ▶ buttons**: jump one calendar day backward or forward
- **Date picker**: jump directly to any date in the 2023–2024 range
- **Hour slider**: scrub to any hour without using playback

### KPI Row (4 Headline Cards)

#### 1. RIDES THIS HOUR
Total ride count for the current borough-aggregated hour.
- **▲/▼ vs yesterday**: percentage change vs the same clock hour the day before. If +15%, demand is unusually high — the GM should check driver availability.
- **% of today's demand**: contextualizes whether this is a peak or quiet hour within the day.

#### 2. AVG RIDER FARE
Mean `base_passenger_fare` across all rides in this hour.
- **▲/▼ vs yesterday**: fare drift. A rising fare with rising demand suggests supply tightness; rising fare with falling demand may indicate quality/regulatory issues.
- **X.X mi avg trip**: average trip miles for context — longer trips naturally cost more.

#### 3. DEMAND VS PEAK
Current hour rides as a % of today's single busiest hour.
- 100% = this IS the peak hour (a star annotation appears)
- Tells the GM how far from peak they are — useful for scheduling driver shift ends

#### 4. VS SAME HOUR LAST WEEK
Week-over-week % change for this specific clock hour (not daily total).
- Colored green (growth) or red (decline)
- The most important leading indicator of sustained trend changes. A GM seeing −10% WoW for three consecutive Fridays at 9 PM should investigate.

### Left Panel

#### 24-HR Demand Pulse
A filled area chart showing **all 24 hours of today's ride counts** (bright green fill) overlaid with **yesterday's same-day profile** (dotted gray line).

- The bright-filled region to the left of the vertical cursor = hours already elapsed
- The dimmer region to the right = hours yet to come (historical actuals, since this is replay)
- **GM use**: spot if today is tracking above/below yesterday's shape. A midday slump vs. yesterday's midday peak is immediately visible.

#### Borough Breakdown · This Hour
Horizontal bars for Manhattan, Brooklyn, Queens, Bronx, Staten Island.
- **Bar width** = share of total rides this hour (matches the % label)
- **Bright green** = the leading borough; **dim green** = others
- **Right label**: `share% · absolute count`
- **GM use**: if Brooklyn suddenly spikes as a share, it may signal an event (concert, sports) worth deploying targeted driver incentives in that zone.

#### Revenue Ops · This Hour
Hourly totals computed as `rides × per-ride average`:

| Metric | Formula | GM Relevance |
|--------|---------|-------------|
| **Gross Bookings** | `rides × avg_fare` | Total platform transaction volume; top-line health |
| **Uber Net Revenue** | `rides × (avg_fare − avg_pay)` | What Uber actually keeps; operational profitability |
| **Driver Payouts** | `rides × avg_pay` | Total labor cost for this hour; driver earnings health |
| **Rides / Min** | `rides ÷ 60` | Operational pace; useful for real-time capacity planning |

#### Per-Ride Economics · This Hour

| Metric | Source Field | GM Relevance |
|--------|-------------|-------------|
| **Rider Fare** | `avg_base_passenger_fare` | Pricing level; compare to city averages and competitors |
| **Driver Pay** | `avg_driver_pay` | Driver satisfaction proxy; low pay → driver churn |
| **Avg Miles** | `avg_trip_miles` | Trip length profile; longer trips = more expensive rides |
| **Platform Margin** | `(fare − pay) / fare × 100` | Take rate; target range ~20–28% for sustainable ops |

#### GM Alerts · This Hour
Rule-based signal engine that fires contextual, actionable alerts:

| Condition | Alert Type | Recommended Action |
|-----------|-----------|-------------------|
| Rides >15% above yesterday | Hot (green) | Activate driver bonuses to boost supply |
| Rides >15% below yesterday | Cold | Consider fare discounts to stimulate demand |
| WoW change >20% | Hot or Warning | Investigate cause; sustained change may require strategic response |
| This is the peak hour | Hot | Ensure maximum driver availability; peak is now |
| Platform margin <18% | Warning | Driver pay may be unsustainably high; review rate structure |
| Platform margin >30% | Hot | Strong unit economics; opportunity to invest in growth |
| No anomalies detected | Neutral | Normal operating conditions |

Alerts update on every hour tick during playback.

### Right Panel

#### NYC Live Demand Map
A Leaflet.js map using CartoDB Dark Matter tiles (free, no API key required). Each of the 5 NYC boroughs is represented by two concentric circles:
- **Inner circle**: radius proportional to ride count (min 6px → max 55px). Animates via ease-out cubic interpolation using `requestAnimationFrame` — no jarring jumps.
- **Outer glow ring**: 1.6× inner radius, low-opacity fill, creates a "pulse" effect
- **Tooltip on hover**: borough name, absolute ride count, share of total
- **Map title**: updates to show the current date being displayed

The visual difference between a 2 AM Manhattan bubble (small) and an 8 PM Manhattan bubble (large) is immediately striking during playback — demand patterns become intuitively clear.

#### 90-Day Trailing Trend · Week-Over-Week
A rolling window chart that **scrolls forward as playback advances**. For each current date, it shows the 90 calendar days ending on that date:
- **Green filled area**: daily total ride counts
- **Dotted gray line**: same-day-prior-week rides (lagged 7 days)
- **Green dot**: today's position in the trend
- **GM use**: distinguishes short-term noise from structural trend. If the green line has been consistently above the gray line for 4+ weeks, demand is genuinely growing. If it dips below, the GM should investigate.

The window moves forward during 10× playback, making seasonal patterns (summer ramp-up, holiday dip, January recovery) visually striking.

---

## Week-over-Week Implementation

Per the assignment suggestion, WoW comparisons are implemented in three places:

1. **KPI Card 4**: `(current_hour_rides − same_hour_last_week_rides) / same_hour_last_week_rides × 100`
2. **Daily trend chart**: `rides_wow` column in `daily.json` is computed as `rides.shift(7)` equivalent in `preprocess.py`
3. **KPI Card 1 delta**: `▲/▼ vs yesterday` (1-day lag, a complement to the 7-day WoW)

---

## Geographic Visualization

The assignment explicitly recommends geographic visualization using location data. We implement this via:
- **Borough-level animated bubbles** on a live Leaflet map
- Borough coordinates are hardcoded centroids (Manhattan, Brooklyn, Queens, Bronx, Staten Island)
- Bubble size encodes demand magnitude; this changes every simulated hour during playback

A zone-level choropleth (263 individual TLC zones) was considered but rejected because borough-level aggregation is the natural granularity of GM decision-making — a GM deploys driver incentives by borough, not by individual zone.

---

## Running the Dashboard

```bash
# Step 1: create conda environment (one time)
conda create -n uber_nyc python=3.11
conda activate uber_nyc
pip install pandas pyarrow tqdm requests plotly

# Step 2: download raw data (one time, ~400 MB)
python download_data.py

# Step 3: preprocess into browser-ready JSON (one time, ~30 seconds)
python preprocess.py

# Step 4: download JS libraries from installed packages (one time)
python download_libs.py

# Step 5: start dashboard (every session)
python serve.py
# → opens http://localhost:8050 in your default browser
```

### Keyboard shortcuts / controls
| Control | Action |
|---------|--------|
| **▶ PLAY / ⏸ PAUSE** | Start or stop time playback |
| **½× 1× 2× 4× 10×** | Set playback speed (hours per second) |
| **Hour slider** | Jump to any hour within the current day |
| **◀ ▶** | Navigate one day backward or forward |
| **Date picker** | Jump directly to any date |

---

## File Structure

```
HW5/
├── README.md                    ← this file
├── download_data.py             ← fetches TLC Parquet, produces aggregated CSVs
├── preprocess.py                ← converts CSVs → 731 date JSON files
├── download_libs.py             ← copies Plotly.js from Python pkg, downloads Leaflet
├── serve.py                     ← Python static file server on port 8050
├── data/
│   ├── uber_2023_agg.csv        ← raw aggregated Uber rides, 2023
│   ├── uber_2024_agg.csv        ← raw aggregated Uber rides, 2024
│   └── taxi_zone_lookup.csv     ← LocationID → Borough/Zone name
└── static/
    ├── index.html               ← dashboard HTML structure
    ├── style.css                ← dark theme, animations, layout
    ├── app.js                   ← all dashboard logic, playback engine, chart updates
    ├── libs/
    │   ├── plotly.min.js        ← Plotly.js (copied from Python plotly package)
    │   ├── leaflet.js           ← Leaflet.js map library
    │   └── leaflet.css          ← Leaflet styles
    └── data/
        ├── meta.json            ← date list, borough names
        ├── daily.json           ← daily totals + WoW lags (731 rows)
        └── by_date/
            ├── 2023-01-01.json
            ├── 2023-01-02.json
            └── ... (731 files)
```

---

## Data Limitations & Honest Caveats

- **No real-time data**: This is a historical replay, not a live feed. A production GM dashboard would ingest from Uber's internal data warehouse with ~5 min latency.
- **Borough-level only**: We aggregate to 5 boroughs. Zone-level (263 zones) detail exists in the raw data but was not visualized.
- **No competitor data**: The assignment suggests including taxi data as a competitor proxy. Yellow/green cab TLC data is available in the same portal; we did not include it to keep scope manageable.
- **No weather/events overlay**: The assignment mentions weather and events as enrichment sources. These would strengthen the GM Alerts logic (e.g., "demand spike correlates with heavy rain").
- **Driver supply is unobserved**: `avg_driver_pay` and `avg_trip_miles` are proxies for supply conditions, but active driver count is not in the public TLC data.
- **Fare = base passenger fare**: This is the pre-tip, pre-fee amount. Total rider cost including tolls, Black Car Fund, and tips is higher.

---

*Data source: NYC Taxi & Limousine Commission — High Volume For-Hire Vehicle Trip Records, Uber (HV0003), January 2023 – December 2024.*
