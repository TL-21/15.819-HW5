# Uber NYC Operations Center — Assignment 5

## Quick Start

```bash
# 1. Clone the repo
git clone <repo-url>
cd HW5

# 2. Create and activate conda environment
conda create -n uber_nyc python=3.11 -y
conda activate uber_nyc
pip install pandas pyarrow tqdm requests

# 3. Download raw TLC trip data (~400 MB, one time)
python download_data.py

# 4. Preprocess into dashboard-ready JSON (~30 sec, one time)
python preprocess.py

# 5. Launch the dashboard
python serve.py
# → automatically opens http://localhost:8050 in your browser
```

> **JS libraries are bundled** — `static/libs/` already contains Plotly.js and Leaflet.js. Steps 3–4 are the only data setup required after cloning.

---

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

## Complete KPI & Metric Reference

Every number visible on the dashboard is documented below with its exact calculation and the business reason it matters to a NYC GM.

---

### Header

#### Simulated Clock
- **Display**: `HH:MM AM/PM · DAY · MON DD, YYYY`
- **Calculation**: derived from `S.dates[S.idx]` (the current date in the dataset) and `S.hour` (0–23, the current playback hour). Not the real wall clock.
- **Business rationale**: Creates a first-person perspective — the GM sees the dashboard "as of" a specific moment, not as a historical summary. This makes temporal patterns visceral (watching demand drop off at 3 AM vs. explode at 5 PM).

#### LIVE / PAUSED Badge
- **LIVE** (red, pulsing): playback is running — hours are advancing automatically
- **PAUSED** (gray): playback is stopped — the GM is exploring a specific moment

---

### KPI Row — 4 Headline Cards

#### Card 1: RIDES THIS HOUR

| Field | Detail |
|-------|--------|
| **Main value** | `sum of rides across all boroughs for (current_date, current_hour)` |
| **Source** | `by_date/YYYY-MM-DD.json → hours[h].rides` |
| **▲/▼ vs yesterday** | `(today_rides − yesterday_rides) / yesterday_rides × 100%` where yesterday = same clock hour, date − 1 |
| **% of today's demand** | `today_hour_rides / sum(today_all_hours_rides) × 100%` |

**Business rationale**: The single most watched number for a GM. Volume is the top-line health signal. The delta vs. yesterday tells whether today is running hot or cold at this specific hour — a −20% reading at 6 PM on a Friday is an immediate red flag worth investigating (weather? service outage? competitor promotion?). The "% of today's demand" contextualizes it: 5% at 3 AM is normal; 5% at 6 PM is a crisis.

---

#### Card 2: AVG RIDER FARE

| Field | Detail |
|-------|--------|
| **Main value** | `avg_base_passenger_fare` for (current_date, current_hour), averaged across all boroughs weighted by ride count |
| **Source** | `by_date/YYYY-MM-DD.json → hours[h].avg_fare` |
| **▲/▼ vs yesterday** | `(today_fare − yesterday_fare) / yesterday_fare × 100%` |
| **X.X mi avg trip** | `avg_trip_miles` for this hour — see Per-Ride Economics |

**Note**: `base_passenger_fare` is the rider-facing price before tips, tolls, Black Car Fund surcharge, and the NYC Congestion Surcharge. It is not the total amount charged to the rider's card, but it is the controllable pricing signal.

**Business rationale**: Fare level determines both rider demand elasticity and gross revenue per trip. A fare rising alongside rising rides = healthy surge pricing working. A fare rising while rides fall = potential over-pricing or supply shortage causing rides to be declined. A fare falling while rides grow = pricing may be too low, leaving revenue on the table. The avg miles sub-line is essential context: a $30 fare on a 2-mile trip vs. a $30 fare on a 10-mile trip tell very different stories.

---

#### Card 3: VS FORECAST PEAK

| Field | Detail |
|-------|--------|
| **Main value** | `current_hour_rides / last_week_same_day_peak_rides × 100%` |
| **Forecast source** | `peakOf(S.lw)` — finds the single highest-ride hour in last week's same calendar day |
| **Fallback** | If last-week data unavailable (first 7 days of dataset), falls back to yesterday's peak, then today's own data |
| **Sub-text** | `Forecast peak at HH:00 · last week` — shows the predicted peak hour and its basis |

**Design decision**: We deliberately use last week's same day rather than today's actual peak, because a real GM cannot see the future. Last week's pattern is the best available predictor of today's intraday shape. For example, if last Friday peaked at 6 PM with 35,000 rides, and it's currently 2 PM Friday with 18,000 rides, the card reads "51% of forecast peak — peak expected at 18:00."

**Business rationale**: Driver shift scheduling is the primary use case. Knowing that peak is 4 hours away at 6 PM lets the GM send driver incentive notifications at 4:30 PM to ensure supply is available before the spike. Seeing that current demand is already at 90% of last week's peak at 2 PM suggests today may be unusually strong — worth activating standby drivers early.

---

#### Card 4: VS SAME HOUR LAST WEEK

| Field | Detail |
|-------|--------|
| **Main value** | `(current_hour_rides − last_week_same_hour_rides) / last_week_same_hour_rides × 100%` |
| **Source** | `S.lw` (last week's date file, same hour index) |
| **Color** | Green if ≥ 0%, red if < 0% |
| **Sub-text** | "vs same hour last week" (static label) |

**Business rationale**: Day-over-day comparisons are noisy because Mondays look different from Fridays. Week-over-week at the same hour controls for day-of-week seasonality, making it the cleanest signal of true growth or decline. A GM seeing −10% WoW for three consecutive Fridays at 9 PM has a structural problem, not a weather blip. This metric is the dashboard's most important leading indicator of sustained trend changes.

---

### Left Panel

#### 24-HR Demand Pulse

| Element | Detail |
|---------|--------|
| **Green filled area (bright)** | Rides per hour for hours 0 → current_hour of today |
| **Green filled area (dim)** | Rides per hour for hours current_hour+1 → 23 of today (full day already in data) |
| **Dotted gray line** | Yesterday's hourly ride profile across all 24 hours |
| **Vertical dashed line** | Current hour marker |
| **Green dot** | Exact position of current hour on today's curve |
| **Source** | `S.today.hours[*].rides` and `S.yest.hours[*].rides` |

**Business rationale**: The intraday shape matters as much as the total. A GM needs to see whether today's curve is tracking above or below yesterday's at every hour — not just the current snapshot. A morning that tracks 15% above yesterday through hours 6–10 suggests a strong day ahead; a sudden dip at hour 14 vs. yesterday's hour 14 is an early warning requiring investigation. The split bright/dim fill makes the elapsed vs. upcoming hours visually distinct.

---

#### Borough Breakdown · This Hour

| Element | Calculation |
|---------|------------|
| **Bar width** | `borough_rides / total_all_borough_rides × 100%` (share of total, matches label) |
| **% label** | Same as bar width — avoids the confusing mismatch of bar-proportional-to-max vs. label-proportional-to-total |
| **Ride count** | Absolute rides for that borough in the current hour |
| **Leader (bright green)** | Borough with highest absolute rides this hour |
| **Others (dim green)** | All other boroughs |
| **Source** | `hours[h].boroughs[borough].rides` |

**Business rationale**: Geographic demand concentration is the key input to driver deployment decisions. If Manhattan is at 38% of rides but only 25% of available drivers are positioned there, the GM should redirect. If Brooklyn's share suddenly spikes from 25% to 40%, an event (concert at Barclays, for example) is likely driving localized demand — warranting a geo-targeted driver incentive push in that borough. The animated bars make these shifts immediately visible during playback.

---

#### Revenue Ops · This Hour

All four metrics are **hourly totals** — the cumulative economic impact of every ride completed in this one hour across all five boroughs.

| Metric | Formula | Source fields |
|--------|---------|---------------|
| **Gross Bookings** | `rides × avg_fare` | `hours[h].rides`, `hours[h].avg_fare` |
| **Uber Net Revenue** | `rides × (avg_fare − avg_pay)` | All three fields above |
| **Driver Payouts** | `rides × avg_pay` | `hours[h].rides`, `hours[h].avg_pay` |
| **Rides / Min** | `rides ÷ 60` | `hours[h].rides` |

**Gross Bookings business rationale**: The top-line number. A $200k Gross Bookings hour means the platform processed $200k in rider payments. This is the number Uber's finance team tracks as "GMV" (Gross Merchandise Value) — it drives everything from payment processing volume to regulatory fee calculations.

**Uber Net Revenue business rationale**: The $33k "kept" after paying drivers is Uber's actual contribution margin from operations this hour, before corporate overhead. It funds technology, marketing, and investor returns. Tracking this in real time catches margin erosion from unusual driver pay patterns or abnormally cheap rides.

**Driver Payouts business rationale**: This is Uber's largest single cost. A GM who watches this trend relative to Gross Bookings can spot payout-ratio drift early. If Driver Payouts rise from 80% to 87% of Gross Bookings over a month, the GM needs to investigate: are drivers getting better at selecting high-pay trips? Is the algorithm over-incentivizing? Is a competitor war causing Uber to overpay to retain drivers?

**Rides / Min business rationale**: An operational tempo metric. At 148 rides/min, customer support volume, payment processing, and safety monitoring systems must sustain that throughput. Sudden drops in rides/min during a normally busy period are an early signal of an app outage or data pipeline issue.

---

#### Per-Ride Economics · This Hour

These are **per-trip averages** — what a single average ride looks like economically this hour.

| Metric | Formula | Source field | Target range |
|--------|---------|-------------|--------------|
| **Rider Fare** | `avg_base_passenger_fare` (weighted avg) | `hours[h].avg_fare` | Market-dependent |
| **Driver Pay** | `avg_driver_pay` (weighted avg) | `hours[h].avg_pay` | ≥ $18–22 in NYC |
| **Avg Miles** | `avg_trip_miles` (weighted avg) | `hours[h].avg_miles` | Context only |
| **Platform Margin** | `(avg_fare − avg_pay) / avg_fare × 100` | Derived | 20–28% |

**Rider Fare business rationale**: The pricing signal. Uber's fare is set by an algorithm balancing demand, supply, distance, and surge multipliers. The GM monitors this to ensure fares aren't drifting too high (killing demand) or too low (not compensating for driver supply costs). Cross-referencing with avg miles is essential: a $25 fare on a 2-mile trip is very different from a $25 fare on a 10-mile trip — the former implies surge pricing; the latter is near-baseline rates.

**Driver Pay business rationale**: NYC has among the highest guaranteed driver pay floors of any Uber market. Low driver pay → driver churn → supply shortage → customers waiting longer → demand erosion. Watching avg_pay relative to avg_fare tells the GM whether the platform is balancing driver and rider interests.

**Avg Miles business rationale**: Trip length is a driver of both fare and time-per-trip. Longer trips mean fewer trips per driver-hour but higher fare per trip. A shift toward shorter trips (common during surge periods when riders take nearby rides) compresses per-ride revenue but may increase ride frequency. The GM uses this to understand the trip-mix composition.

**Platform Margin business rationale**: Uber's take rate — the percentage of the rider fare the platform keeps. The TLC data implies a rate typically between 15–25% in NYC. Below 18% suggests the platform is under margin pressure (possibly from driver guarantees or promotions). Above 28% may attract regulatory attention or driver dissatisfaction. This is the key metric Uber's NYC GM would be held accountable for in quarterly reviews.

---

#### GM Alerts · This Hour

The alert engine fires rule-based signals every simulated hour. Each alert includes a recommended action so the GM knows exactly what to do, not just what is happening.

| Rule | Threshold | Alert Color | Display Text | Business Rationale |
|------|-----------|-------------|-------------|-------------------|
| Demand vs yesterday | today_rides > 1.15 × yesterday_rides | 🟢 Hot | "Demand +X% vs yesterday — consider driver incentives to boost supply" | Unusually high demand risks wait times growing → bad rider experience → churn. Proactive driver activation prevents this. |
| Demand vs yesterday | today_rides < 0.85 × yesterday_rides | 🔵 Cold | "Demand −X% vs yesterday — ease surge pricing to stimulate rides" | Low demand may be self-inflicted by high fares. Reducing surge can recover volume without abandoning the market. |
| Week-over-week | \|WoW change\| > 20% | 🟢/🟡 | "WoW +/−X% — strong growth / investigate drop" | >20% WoW swings are structural, not random. Growth: ensure infrastructure scales. Decline: investigate root cause before it compounds. |
| Peak hour detection | current hour = forecast peak hour (from last week) | 🟢 Hot | "Peak hour now. Activate driver bonuses to maximise availability" | The GM gets a real-time reminder when the historically busiest hour arrives — the moment maximum driver availability is most critical. |
| Platform margin low | margin < 18% | 🟡 Warning | "Platform margin X% — below 18% target. Review driver pay rate" | Sub-18% margin in NYC means Uber is likely not covering corporate overhead from this market. The GM should review whether a driver promo is running that shouldn't be, or if algorithm costs are elevated. |
| Platform margin high | margin > 30% | 🟢 Hot | "Strong margin X% — healthy unit economics this hour" | Margins above 30% are a signal that the hour is highly efficient. A GM might use this context to justify incremental marketing spend or a limited-time rider promotion that converts demand elasticity into volume. |
| No anomalies | all rules pass | ⚫ Neutral | "Demand within normal range. No action required" | Absence of alerts is itself informative — it confirms the platform is operating in its normal operating envelope. |

---

### Right Panel

#### NYC Live Demand Map

| Element | Calculation |
|---------|------------|
| **Inner circle radius** | `MIN_R + (borough_rides / max_borough_rides) × (MAX_R − MIN_R)` where MIN_R=6px, MAX_R=55px |
| **Outer glow radius** | `inner_radius × 1.6` |
| **Animation** | Ease-out cubic interpolation via `requestAnimationFrame` over 420ms — radius changes smoothly, never jumps |
| **Tooltip** | `borough_name · absolute_rides · share_of_total_%` |
| **Source** | `hours[h].boroughs[borough].rides` |

**Business rationale**: The map provides immediate spatial intuition that bar charts cannot. During playback, watching Manhattan's bubble grow from tiny at 3 AM to dominant at 6 PM, while Brooklyn's bubble tracks a distinctly different shape (later evening peak), reveals the borough-specific demand rhythm. A GM deploying drivers watches for bubbles to swell in specific areas 30–60 minutes ahead of where they currently are, so they can pre-position supply.

---

#### 90-Day Trailing Ride Trend

| Element | Calculation |
|---------|------------|
| **Window** | 90 calendar days ending on the current simulated date |
| **Green filled area** | `daily.json → rides` for each day in the window |
| **Dotted gray line** | `daily.json → rides_wow` = rides from 7 days prior (computed in `preprocess.py` as a 7-day lag) |
| **Green dot** | Today's total daily rides (as of current playback position) |
| **Window movement** | On every date change (including during playback), the 90-day window shifts forward — old dates drop off the left, new dates appear on the right |

**Business rationale**: The 90-day window is the GM's strategic view, contrasting with the intraday tactical view above. The two lines (current week vs. prior week) reveal whether growth is accelerating, plateauing, or reversing. A GM presenting to leadership would use this chart to show that "the WoW green line has been consistently above the gray line since October — we've sustained positive growth for 12 consecutive weeks." Conversely, a period where green repeatedly dips below gray is the earliest warning of a demand problem before it shows up in monthly reports.

The rolling window creates a compelling animated effect during 10× playback: the viewer watches the chart's time axis scroll forward through all of 2023 and into 2024, with seasonal patterns (summer surge, Thanksgiving dip, January recovery) visually apparent.

---

## Week-over-Week Implementation

Per the assignment suggestion, WoW comparisons are implemented in four places:

| Location | Calculation | Scope |
|----------|------------|-------|
| KPI Card 4 | `(hour_rides_today − hour_rides_last_week) / hour_rides_last_week × 100` | Hourly, same clock hour |
| KPI Card 1 delta | `(hour_rides_today − hour_rides_yesterday) / hour_rides_yesterday × 100` | Day-over-day (1-day lag) |
| Demand Pulse chart | Overlay of yesterday's full 24-hour profile | Visual shape comparison |
| 90-Day Trend chart | `rides_wow` column = 7-day lagged daily rides from `preprocess.py` | Daily rolling comparison |

---

## Geographic Visualization

The assignment explicitly recommends geographic visualization using location data. We implement this via:
- **Borough-level animated bubbles** on a live Leaflet map using CartoDB Dark Matter tiles (no API key required)
- Borough coordinates are hardcoded geographic centroids for Manhattan, Brooklyn, Queens, Bronx, and Staten Island
- Bubble size encodes demand magnitude and updates every simulated hour during playback

A zone-level choropleth (263 individual TLC zones) was considered but rejected because borough-level aggregation is the natural granularity of GM decision-making — driver incentives are deployed by borough, not by individual zone, and zone-level data would create visual noise without proportional insight.

---

## Running the Dashboard

```bash
# Step 1: create conda environment (one time)
conda create -n uber_nyc python=3.11
conda activate uber_nyc
pip install pandas pyarrow tqdm requests

# Step 2: download raw data (one time, ~400 MB)
python download_data.py

# Step 3: preprocess into browser-ready JSON (one time, ~30 seconds)
python preprocess.py

# Step 4: start dashboard (every session)
python serve.py
# → opens http://localhost:8050 in your default browser
```

> JS libraries (Plotly.js, Leaflet.js) are already bundled in `static/libs/` — no separate download step needed.

### Controls
| Control | Action |
|---------|--------|
| **▶ PLAY / ⏸ PAUSE** | Start or stop time playback |
| **½× 1× 2× 4× 10×** | Set playback speed (hours per second) |
| **Hour slider** | Jump to any hour within the current day |
| **◀ ▶** | Navigate one day backward or forward |
| **Date picker** | Jump directly to any date in 2023–2024 |

---

## File Structure

```
HW5/
├── README.md                    ← this file
├── download_data.py             ← fetches TLC Parquet, produces aggregated CSVs
├── preprocess.py                ← converts CSVs → 731 date JSON files
├── serve.py                     ← Python static file server on port 8050
├── data/
│   ├── uber_2023_agg.csv        ← raw aggregated Uber rides, 2023 (gitignored)
│   ├── uber_2024_agg.csv        ← raw aggregated Uber rides, 2024 (gitignored)
│   └── taxi_zone_lookup.csv     ← LocationID → Borough/Zone name
└── static/
    ├── index.html               ← dashboard HTML structure
    ├── style.css                ← dark theme, animations, layout
    ├── app.js                   ← all dashboard logic, playback engine, chart updates
    ├── libs/
    │   ├── plotly.min.js        ← Plotly.js (bundled in repo, no download needed)
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
- **Platform Margin is an approximation**: `(avg_fare − avg_pay) / avg_fare` approximates Uber's take rate but omits fixed costs, insurance, and regulatory fees that are also deducted from gross bookings before Uber books revenue.

---

*Data source: NYC Taxi & Limousine Commission — High Volume For-Hire Vehicle Trip Records, Uber (HV0003), January 2023 – December 2024.*
