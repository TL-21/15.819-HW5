/* ═══════════════════════════════════════════════════════
   Uber NYC Ops Center — Dashboard Logic
   All animation via setInterval + requestAnimationFrame
   ═══════════════════════════════════════════════════════ */

// ── Constants ─────────────────────────────────────────
const BOROUGHS = ['Manhattan','Brooklyn','Queens','Bronx','Staten Island'];
const COORDS = {
  Manhattan:     [40.7831, -73.9712],
  Brooklyn:      [40.6501, -73.9496],
  Queens:        [40.7282, -73.7949],
  Bronx:         [40.8448, -73.8648],
  'Staten Island':[40.5795,-74.1502],
};
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const DAYS   = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
const GREEN       = '#06C167';
const RED         = '#FF4B4B';
const DIM         = '#272c2a';
const EVENT_COLOR = '#FFD700';   // gold — visible on both light (day) and dark (night) map tiles
const SPEEDS = [{l:'½×',ms:2000},{l:'1×',ms:1000},{l:'2×',ms:500},{l:'4×',ms:250},{l:'10×',ms:100}];

// ── State ─────────────────────────────────────────────
const S = {
  dates: [], idx: 0, hour: 8,
  playing: false, speedMs: 1000,
  cache: {},          // dateStr → data
  today: null,        // current date full data
  yest:  null,        // yesterday
  lw:    null,        // last week
  daily: [],          // [{date,rides,rides_wow}…]
  peers:    [],        // last N same-DOW date strings
  peerData: [],        // loaded day data for each peer
  weather: null,      // weather.json  { "YYYY-MM-DD": {cat,icon,hi,lo,precip,snow} }
  events:  null,      // events.json   { "YYYY-MM-DD": {name,loc,borough,lat,lon,icon,note} }
  numTargets: {},     // for animateNumber dedup
};
let timer = null;

// ── Map globals ───────────────────────────────────────
let leafMap       = null;
let nightTile     = null;   // always opacity 1, underneath
let dayTile       = null;   // opacity 0–1, on top
let dayOpacity    = 0;      // current rendered opacity
let tileToken     = 0;      // cancel in-flight animations
let eventMarker   = null;   // {inner,outer} for today's event
const TILE_DAY    = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const TILE_NIGHT  = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_OPTS   = {subdomains:'abcd', maxZoom:19,
  attribution:'© <a href="https://openstreetmap.org">OSM</a> © <a href="https://carto.com">CARTO</a>'};
const markers = {};   // borough → {inner, outer} Leaflet circles
const prevR   = {};   // last animated radius per borough

// ── Solar helpers ─────────────────────────────────────
// Returns {sunrise, sunset} in decimal local hours for NYC.
function getSunTimes(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const start = new Date(d.getFullYear(), 0, 0);
  const doy   = Math.round((d - start) / 86400000);
  const lat   = 40.7128 * Math.PI / 180;
  const decl  = -0.4093 * Math.cos(2 * Math.PI * (doy + 10) / 365);
  const cosHa = -Math.tan(lat) * Math.tan(decl);
  const ha    = Math.acos(Math.max(-1, Math.min(1, cosHa))) * 180 / Math.PI / 15;
  // NYC solar noon ≈ 12.18 local clock (standard time offset)
  return { sunrise: 12.18 - ha, sunset: 12.18 + ha };
}

// Returns 0 (full night) → 1 (full day) for a given hour, with twilight ramp.
function getSunFraction(dateStr, hour) {
  const { sunrise, sunset } = getSunTimes(dateStr);
  // Narrow ramp: one hour centered on sunrise/sunset so it's fully day/night by adjacent hours
  const ds = sunrise - 0.5, de = sunrise + 0.5;
  const ss = sunset  - 0.5, se = sunset  + 0.5;
  if (hour <= ds || hour >= se) return 0;
  if (hour >= de && hour <= ss) return 1;
  const t = hour < de ? (hour - ds) / (de - ds) : 1 - (hour - ss) / (se - ss);
  return t * t * (3 - 2 * t);   // smoothstep
}

// Animate day tile opacity toward target (supersedes previous animations).
function animateDayTile(target) {
  const token = ++tileToken;
  const from  = dayOpacity;
  if (!dayTile || Math.abs(target - from) < 0.008) { dayOpacity = target; return; }
  const dur   = 450;
  const start = performance.now();
  function step(now) {
    if (tileToken !== token) return;
    const p = Math.min((now - start) / dur, 1);
    const e = p * p * (3 - 2 * p);   // smoothstep
    dayOpacity = from + (target - from) * e;
    dayTile.setOpacity(dayOpacity);
    // Adjust marker contrast for readability on light/dark background
    const fillOp = 0.55 + dayOpacity * 0.2;
    Object.values(markers).forEach(m => {
      m.inner.setStyle({fillOpacity: fillOp});
      m.outer.setStyle({fillOpacity: 0.08 + dayOpacity * 0.08});
    });
    if (p < 1) requestAnimationFrame(step);
    else dayOpacity = target;
  }
  requestAnimationFrame(step);
}

// ── Plot layout helper ────────────────────────────────
const plotBg = 'rgba(0,0,0,0)';
function baseLayout(h, extra = {}) {
  return {
    height: h,
    margin: {l:40,r:10,t:4,b:28},
    paper_bgcolor: plotBg, plot_bgcolor: plotBg,
    showlegend: false,
    font: {color:'#717875', size:10},
    xaxis: {gridcolor: DIM, zeroline:false, showline:false, ...extra.xaxis},
    yaxis: {gridcolor: DIM, zeroline:false, showline:false, ...extra.yaxis},
  };
}

// ── Boot ──────────────────────────────────────────────
window.addEventListener('load', async () => {
  try {
    progress(10, 'Fetching metadata…');
    const [meta, daily, weather, events] = await Promise.all([
      fetchJ('data/meta.json'),
      fetchJ('data/daily.json'),
      fetchJ('data/weather.json'),
      fetchJ('data/events.json'),
    ]);
    S.dates   = meta.dates;
    S.daily   = daily;
    S.weather = weather;
    S.events  = events;
    S.idx     = 0;
    S.hour    = 8;

    progress(32, 'Initialising demand chart…');
    initDemandChart();
    progress(44, 'Initialising trend chart…');
    initTrendChart();
    progress(52, 'Initialising peer chart…');
    initPeerChart();
    progress(56, 'Initialising map…');
    initMap();
    progress(62, 'Binding controls…');
    buildSpeedBtns();
    bindControls();

    progress(70, 'Loading first date…');
    await loadDateRange();

    progress(90, 'Rendering…');
    updateAll();

    progress(100, 'Ready');
    setTimeout(() => {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('dash').style.visibility = 'visible';
      if (leafMap) {
        leafMap.invalidateSize();
        leafMap.setView([40.73, -73.97], 10);
      }
    }, 300);
  } catch(err) {
    console.error('Boot failed:', err);
    document.getElementById('ld-msg').textContent = '✗ ' + err.message;
    document.getElementById('ld-fill').style.background = '#FF4B4B';
  }
});

function progress(pct, msg) {
  document.getElementById('ld-fill').style.width = pct + '%';
  document.getElementById('ld-msg').textContent  = msg;
}

// ── Forecast / peer helpers ───────────────────────────
// Returns the last N date strings that share the same day-of-week as `date`,
// going strictly backwards — so it's never forward-looking.
function getSameDowDates(date, n = 4) {
  const targetDow = new Date(date + 'T12:00:00').getDay();
  const di = S.daily.findIndex(x => x.date === date);
  if (di < 0) return [];
  const peers = [];
  for (let i = di - 1; i >= 0 && peers.length < n; i--) {
    if (new Date(S.daily[i].date + 'T12:00:00').getDay() === targetDow)
      peers.push(S.daily[i].date);
  }
  return peers;
}

// Returns avg rides of the last N occurrences of the same weekday before `date`.
function sameWeekdayForecast(date, n = 4) {
  const targetDow = new Date(date + 'T12:00:00').getDay();
  const di = S.daily.findIndex(x => x.date === date);
  if (di < 0) return null;
  const samples = [];
  for (let i = di - 1; i >= 0 && samples.length < n; i--) {
    if (new Date(S.daily[i].date + 'T12:00:00').getDay() === targetDow) {
      samples.push(S.daily[i].rides);
    }
  }
  return samples.length >= 2 ? Math.round(samples.reduce((a,b)=>a+b,0)/samples.length) : null;
}

// ── Data helpers ──────────────────────────────────────
async function fetchJ(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch failed: ' + url);
  return r.json();
}

function offsetDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

async function loadDate(dateStr) {
  if (!S.cache[dateStr]) {
    try   { S.cache[dateStr] = await fetchJ('data/by_date/' + dateStr + '.json'); }
    catch { S.cache[dateStr] = null; }
  }
  return S.cache[dateStr];
}

async function loadDateRange() {
  const ds = S.dates[S.idx];
  S.peers = getSameDowDates(ds);
  const [today, yest, lw, ...peerData] = await Promise.all([
    loadDate(ds),
    loadDate(offsetDate(ds, -1)),
    loadDate(offsetDate(ds, -7)),
    ...S.peers.map(loadDate),
  ]);
  S.today    = today;
  S.yest     = yest;
  S.lw       = lw;
  S.peerData = peerData;
}

function hourOf(dayData, h) {
  return dayData?.hours?.find(x => x.h === h) ?? null;
}
function dayRides(dayData) {
  return dayData?.hours?.reduce((s, h) => s + (h.rides||0), 0) ?? 0;
}
function peakOf(dayData) {
  if (!dayData) return {h:12, rides:0};
  return dayData.hours.reduce((b,x) => x.rides > b.rides ? x : b, dayData.hours[0] ?? {h:0,rides:0});
}

// ── Master update ─────────────────────────────────────
function updateAll() {
  updateHeader();
  updateKPIs();
  updateWeatherBadge();
  updateDemandChart();
  updateBoroBar();
  updatePeerChart();
  updateEco();
  updateAlerts();
  updateMap();
  updateEventMarker();
  updateTrendCursor();
  document.getElementById('hour-slider').value = S.hour;
  document.getElementById('hour-display').textContent =
    String(S.hour).padStart(2,'0') + ':00';
  // sync date picker
  document.getElementById('date-picker').value = S.dates[S.idx];
}

// ── Header ────────────────────────────────────────────
function updateHeader() {
  const ds = S.dates[S.idx];
  const d  = new Date(ds + 'T12:00:00');
  const h  = S.hour;
  const h12 = h % 12 || 12;
  const am  = h < 12 ? 'AM' : 'PM';

  document.getElementById('clk-h').textContent      = String(h12).padStart(2,'0');
  document.getElementById('clk-period').textContent  = am;
  document.getElementById('clk-date').textContent    =
    DAYS[d.getDay()] + '  ·  ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();

  const colon = document.getElementById('clk-colon');
  if (S.playing) colon.classList.add('blink'); else colon.classList.remove('blink');
  document.getElementById('badge-live').style.display  = S.playing ? 'inline-flex' : 'none';
  document.getElementById('badge-pause').style.display = S.playing ? 'none' : 'inline-flex';
}

// ── KPIs ──────────────────────────────────────────────
function updateKPIs() {
  const cur  = hourOf(S.today, S.hour);
  const yest = hourOf(S.yest,  S.hour);
  const lw   = hourOf(S.lw,    S.hour);
  const rides  = cur?.rides ?? 0;
  const dtotal = dayRides(S.today);
  const peak   = peakOf(S.lw ?? S.yest ?? S.today);

  // Rides
  animNum('k-rides', rides, v => Math.round(v).toLocaleString());
  setDelta('k-rides-d', rides, yest?.rides, 'vs yesterday');
  setText('k-rides-s', dtotal > 0 ? (rides/dtotal*100).toFixed(1)+'% of today\'s demand' : '');

  // Fare
  const fare = cur?.avg_fare;
  animNum('k-fare', fare ?? 0, v => fare != null ? '$'+v.toFixed(2) : '—');
  setDelta('k-fare-d', fare, yest?.avg_fare, 'vs yesterday');
  setText('k-fare-s', cur?.avg_miles != null ? cur.avg_miles.toFixed(1)+' mi avg trip' : '');

  // % of peak demand hour: this hour ÷ busiest hour last same-weekday
  const pct = peak.rides > 0 ? rides/peak.rides*100 : 0;
  animNum('k-peak', pct, v => Math.round(v)+'%');
  setText('k-peak-d', '');
  const peakHr = peak.h;
  const peakHr12 = peakHr % 12 || 12;
  const peakAmPm = peakHr < 12 ? 'AM' : 'PM';
  const peakSrc = S.lw ? 'last week' : (S.yest ? 'yesterday' : "today's data");
  setText('k-peak-s', `vs peak hour (${String(peakHr12).padStart(2,'0')}:00 ${peakAmPm}) · ${peakSrc}`);

  // WoW
  const lwR = lw?.rides;
  const wowEl = document.getElementById('k-wow');
  if (lwR && lwR > 0) {
    const wp = (rides - lwR) / lwR * 100;
    animNum('k-wow', wp, v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%');
    wowEl.style.color = wp >= 0 ? GREEN : RED;
    setText('k-wow-d', '');
  } else {
    setText('k-wow', '—');
    if (wowEl) wowEl.style.color = '';
  }
  setText('k-wow-s', 'Compared with the same hour last week');
}

// ── Number animation ──────────────────────────────────
function animNum(id, target, fmt, dur = 320) {
  const el = document.getElementById(id);
  if (!el) return;
  const from = S.numTargets[id] ?? target;
  S.numTargets[id] = target;
  let start = null;
  function step(ts) {
    if (S.numTargets[id] !== target) return; // superseded
    if (!start) start = ts;
    const p = Math.min((ts - start) / dur, 1);
    const e = p < .5 ? 2*p*p : -1+(4-2*p)*p;
    el.textContent = fmt(from + (target-from)*e);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}
function setDelta(id, cur, prev, label) {
  const el = document.getElementById(id);
  if (!el) return;
  if (prev == null || prev === 0) { el.textContent=''; return; }
  const p = (cur - prev) / prev * 100;
  el.textContent = (p>=0?'▲ ':'▼ ') + Math.abs(p).toFixed(1)+'% '+label;
  el.className   = 'kpi-delta ' + (p>=0?'up':'dn');
}

// ── Weather badge ─────────────────────────────────────
function updateWeatherBadge() {
  const el = document.getElementById('weather-badge');
  if (!el || !S.weather) return;
  const w = S.weather[S.dates[S.idx]];
  if (!w) { el.innerHTML = ''; return; }
  const precipStr = w.precip > 0
    ? `<span class="weather-precip">${w.precip}" precip</span>` : '';
  const snowStr = w.snow > 0
    ? `<span class="weather-precip">❄️ ${w.snow}"</span>` : '';
  el.innerHTML =
    `<span class="weather-icon">${w.icon}</span>` +
    `<span class="weather-temp">${w.hi}° / ${w.lo}°F</span>` +
    precipStr + snowStr;
}

// ── Demand curve ──────────────────────────────────────
const BLUE_REF = '#4a7a9b';   // blue-gray for historical reference lines

function initDemandChart() {
  Plotly.newPlot('demand-chart',
    [{type:'scatter',x:[],y:[],name:'Yesterday',mode:'lines',
      line:{color:BLUE_REF,width:1.4,dash:'dot'}},
     {type:'scatter',x:[],y:[],fill:'tozeroy',name:'Today',
      fillcolor:'rgba(6,193,103,0.08)',line:{color:GREEN,width:1.5}},
     {type:'scatter',x:[],y:[],fill:'tozeroy',fillcolor:'rgba(6,193,103,0.25)',
      line:{color:GREEN,width:2.5},showlegend:false,hoverinfo:'skip'},
     {type:'scatter',x:[],y:[],mode:'markers',showlegend:false,hoverinfo:'skip',
      marker:{color:GREEN,size:10,opacity:.9}},
    ],
    {...baseLayout(162,{xaxis:{tickvals:[0,3,6,9,12,15,18,21,23],
      ticktext:['00h','03h','06h','09h','12h','15h','18h','21h','23h']}}),
     showlegend:true, legend:{orientation:'h',x:0,y:1.18,xanchor:'left',
       font:{size:9,color:'#717875'},bgcolor:'rgba(0,0,0,0)',borderwidth:0}},
    {responsive:true,displayModeBar:false}
  );
}

function updateDemandChart() {
  if (!S.today) return;
  const hrs = Array.from({length:24},(_,i)=>i);
  const tY  = hrs.map(h => hourOf(S.today, h)?.rides ?? 0);
  const yY  = hrs.map(h => hourOf(S.yest,  h)?.rides ?? 0);
  const h   = S.hour;

  Plotly.react('demand-chart',[
    {type:'scatter',x:hrs,y:yY,name:'Yesterday',mode:'lines',
     line:{color:BLUE_REF,width:1.4,dash:'dot'},
     hovertemplate:'%{x}:00 yest — %{y:,}<extra></extra>'},
    {type:'scatter',x:hrs,y:tY,fill:'tozeroy',name:'Today',
     fillcolor:'rgba(6,193,103,0.08)',line:{color:GREEN,width:1.5},
     hovertemplate:'%{x}:00 — %{y:,}<extra></extra>'},
    {type:'scatter',x:hrs.slice(0,h+1),y:tY.slice(0,h+1),fill:'tozeroy',
     fillcolor:'rgba(6,193,103,0.25)',line:{color:GREEN,width:2.5},
     showlegend:false,hoverinfo:'skip'},
    {type:'scatter',x:[h],y:[tY[h]],mode:'markers',showlegend:false,hoverinfo:'skip',
     marker:{color:GREEN,size:10,opacity:.9}},
  ],
  {...baseLayout(162,{xaxis:{tickvals:[0,3,6,9,12,15,18,21,23],
    ticktext:['00h','03h','06h','09h','12h','15h','18h','21h','23h']}}),
    showlegend:true, legend:{orientation:'h',x:0,y:1.18,xanchor:'left',
      font:{size:9,color:'#717875'},bgcolor:'rgba(0,0,0,0)',borderwidth:0},
    shapes:[{type:'line',x0:h,x1:h,y0:0,y1:1,yref:'paper',
             line:{color:'rgba(255,255,255,0.25)',width:1,dash:'dot'}}]},
  {transition:{duration:280,easing:'cubic-in-out'},responsive:true,displayModeBar:false}
  );
}

// ── Borough bars ──────────────────────────────────────
// Built once; widths driven by CSS transitions thereafter
let boroBuilt = false;
function buildBoroDOM() {
  const c = document.getElementById('boro-bars');
  c.innerHTML = '';
  BOROUGHS.forEach(b => {
    const id = b.replace(/\s/g,'');
    c.insertAdjacentHTML('beforeend',
      `<div class="b-row">
        <div class="b-name">${b}</div>
        <div class="b-track"><div class="b-fill" id="bf-${id}" style="width:0%"></div></div>
        <div class="b-meta" id="bm-${id}">— · —</div>
      </div>`);
  });
  boroBuilt = true;
}

function updateBoroBar() {
  if (!boroBuilt) buildBoroDOM();
  const cur = hourOf(S.today, S.hour);
  if (!cur) return;
  const vals = BOROUGHS.map(b => cur.boroughs?.[b]?.rides ?? 0);
  const totV = vals.reduce((a,b)=>a+b,0);
  // Sort for leader detection
  const order = vals.map((v,i)=>({v,i})).sort((a,b)=>b.v-a.v);
  BOROUGHS.forEach((b,i) => {
    const id  = b.replace(/\s/g,'');
    const bar = document.getElementById('bf-'+id);
    const meta= document.getElementById('bm-'+id);
    if (!bar) return;
    bar.style.width = (totV > 0 ? vals[i]/totV*100 : 0).toFixed(1)+'%';
    bar.className   = 'b-fill' + (order[0].i===i ? ' leader' : '');
    const share = totV > 0 ? (vals[i]/totV*100).toFixed(0)+'%' : '—';
    const boroFare = cur.boroughs?.[b]?.avg_fare;
    const fareLabel = boroFare != null ? ' · $'+boroFare.toFixed(2) : '';
    meta.textContent = share + ' · ' + vals[i].toLocaleString() + fareLabel;
  });
}

// ── Economics ─────────────────────────────────────────
function updateEco() {
  const cur  = hourOf(S.today, S.hour);
  const rides    = cur?.rides ?? 0;
  const fare     = cur?.avg_fare;
  const pay      = cur?.avg_pay;
  const miles    = cur?.avg_miles;
  const tripTime = cur?.avg_trip_time;  // seconds
  const margin   = (fare && pay && fare > 0) ? (fare - pay) / fare * 100 : null;
  const gross    = (fare && rides) ? rides * fare : null;
  const payouts  = (pay  && rides) ? rides * pay  : null;
  const uberRev  = (gross != null && payouts != null) ? gross - payouts : null;
  const pace     = rides > 0 ? (rides / 60).toFixed(1) : null;
  const rpm      = (fare && miles && miles > 0) ? fare / miles : null;

  const fmt = v => v >= 1e6 ? '$'+(v/1e6).toFixed(2)+'M' : '$'+(v/1e3).toFixed(0)+'k';
  setText('e-gross',    gross    != null ? fmt(gross)          : '—');
  setText('e-uber',     uberRev  != null ? fmt(uberRev)        : '—');
  setText('e-payouts',  payouts  != null ? fmt(payouts)        : '—');
  setText('e-pace',     pace     != null ? pace+'/min'         : '—');
  setText('e-fare',     fare     != null ? '$'+fare.toFixed(2) : '—');
  setText('e-pay',      pay      != null ? '$'+pay.toFixed(2)  : '—');
  setText('e-miles',    miles    != null ? miles.toFixed(1)+' mi' : '—');
  setText('e-triptime', tripTime != null ? Math.round(tripTime/60)+' min' : '—');
  setText('e-margin',   margin   != null ? margin.toFixed(1)+'%' : '—');
  setText('e-rpm',      rpm      != null ? '$'+rpm.toFixed(2)+'/mi' : '—');
}

// ── GM Alerts ─────────────────────────────────────────
function updateAlerts() {
  const cur  = hourOf(S.today, S.hour);
  const yest = hourOf(S.yest,  S.hour);
  const lw   = hourOf(S.lw,    S.hour);
  const alerts = [];

  // Event alert — time-aware: upcoming / active / expired
  const ev = S.events?.[S.dates[S.idx]];
  if (ev) {
    if (S.hour < ev.start_h) {
      alerts.push({cls:'event', icon:'⏰',
        txt:`UPCOMING · ${ev.name} · Starts at ${ev.start_h}:00 · ${ev.note}`});
    } else if (S.hour <= ev.end_h) {
      alerts.push({cls:'event', icon: ev.icon,
        txt:`ACTIVE · ${ev.name} · ${ev.loc} · ${ev.start_h}:00–${ev.end_h}:00. ${ev.note}`});
    }
    // after end_h: event is over, no alert
  }

  if (cur && yest && yest.rides > 0) {
    const delta = (cur.rides - yest.rides) / yest.rides * 100;
    if (delta > 15)
      alerts.push({cls:'hot', icon:'📈', txt:`Demand is up ${delta.toFixed(0)}% vs yesterday — monitor capacity pressure and pickup coverage.`});
    else if (delta < -15)
      alerts.push({cls:'cold', icon:'📉', txt:`Demand is down ${Math.abs(delta).toFixed(0)}% vs yesterday — consider targeted promotions or localized demand stimulation.`});
  }
  if (cur && lw && lw.rides > 0) {
    const wp = (cur.rides - lw.rides) / lw.rides * 100;
    if (Math.abs(wp) > 20)
      alerts.push({cls: wp>0?'hot':'warn', icon: wp>0?'🚀':'⚠️',
        txt:`Same-hour demand is ${wp>0?'up':'down'} ${Math.abs(wp).toFixed(0)}% vs last week — ${wp>0?'review borough-level coverage for sustained growth':'review market balance and check for localized service issues'}.`});
  }
  const peak = peakOf(S.today);
  if (cur && S.hour === peak.h)
    alerts.push({cls:'hot', icon:'⚡', txt:`Peak demand hour in progress. Prioritize driver coverage and minimize wait times.`});

  const margin = cur?.avg_fare && cur?.avg_pay && cur.avg_fare > 0
    ? (cur.avg_fare - cur.avg_pay) / cur.avg_fare * 100 : null;
  if (margin != null && margin < 18)
    alerts.push({cls:'warn', icon:'💸', txt:`Platform margin is ${margin.toFixed(1)}% — below the 18% benchmark. Review fare-pay balance.`});
  if (margin != null && margin > 30)
    alerts.push({cls:'hot', icon:'✅', txt:`Platform margin is ${margin.toFixed(1)}% — healthy unit economics this hour.`});

  // Forecast vs actual: compare today's accumulated rides to the same-weekday forecast
  const todayDate = S.dates[S.idx];
  const forecastRides = sameWeekdayForecast(todayDate);
  const todayRides    = dayRides(S.today);
  if (forecastRides && forecastRides > 0 && todayRides > 0) {
    if (S.hour >= 6) {
      const hoursElapsed   = S.hour + 1;
      const scaledForecast = Math.round(forecastRides * (hoursElapsed / 24));
      const ridesThruHour  = S.today.hours
        .filter(h => h.h <= S.hour)
        .reduce((s, h) => s + (h.rides || 0), 0);
      const fp = (ridesThruHour - scaledForecast) / scaledForecast * 100;
      if (fp > 8) {
        const evLift = ev && ev.demand_effect === 'elevates'
          ? ` Likely driven by ${ev.name}.` : '';
        alerts.push({cls:'hot', icon:'📊',
          txt:`Demand tracking ${fp.toFixed(0)}% ABOVE forecast through ${S.hour}:00 (${ridesThruHour.toLocaleString()} actual vs ${scaledForecast.toLocaleString()} expected).${evLift} Watch for capacity pressure.`});
      } else if (fp < -8) {
        if (ev && ev.demand_effect === 'reduces') {
          alerts.push({cls:'warn', icon:'📊',
            txt:`Demand tracking ${Math.abs(fp).toFixed(0)}% BELOW forecast through ${S.hour}:00 — expected due to ${ev.name} road closures restricting driver routing. Not a demand issue.`});
        } else {
          alerts.push({cls:'warn', icon:'📊',
            txt:`Demand tracking ${Math.abs(fp).toFixed(0)}% BELOW forecast through ${S.hour}:00 (${ridesThruHour.toLocaleString()} actual vs ${scaledForecast.toLocaleString()} expected). Consider targeted promotions or demand stimulation.`});
        }
      }
    }
  }

  // Weather alert — rain and snow both spike demand
  const w = S.weather?.[S.dates[S.idx]];
  if (w) {
    if (w.cat === 'rain' || w.cat === 'storm')
      alerts.push({cls:'hot', icon:w.icon,
        txt:`Rain day (${w.precip}" precipitation, ${w.hi}°F). Expect elevated demand — surge pricing likely. Ensure driver supply in high-density zones.`});
    else if (w.cat === 'snow')
      alerts.push({cls:'warn', icon:w.icon,
        txt:`Snow day (${w.snow}" snowfall, ${w.hi}°F). Demand spikes but driver availability may drop — monitor wait times closely.`});
    else if (w.cat === 'drizzle')
      alerts.push({cls:'hot', icon:w.icon,
        txt:`Drizzle today (${w.precip}" precip). Moderate demand uplift expected vs a dry day.`});
    else if (w.hi >= 90)
      alerts.push({cls:'hot', icon:'🌡️',
        txt:`Heat advisory (${w.hi}°F). Hot weather increases afternoon/evening ride demand, especially from transit-averse riders.`});
    else if (w.hi <= 20)
      alerts.push({cls:'warn', icon:'🥶',
        txt:`Extreme cold (${w.hi}°F high). Demand may spike but driver turnout typically drops in extreme cold.`});
  }

  if (alerts.length === 0)
    alerts.push({cls:'ok', icon:'✅', txt:'All metrics within normal range for this hour.'});

  const el = document.getElementById('alert-row');
  if (!el) return;
  el.innerHTML = alerts.map(a =>
    `<div class="alert-item ${a.cls}"><span class="alert-icon">${a.icon}</span><span class="alert-txt">${a.txt}</span></div>`
  ).join('');
}

// ── Leaflet map ───────────────────────────────────────
function initMap() {
  leafMap    = L.map('map', {center:[40.73,-73.97], zoom:10,
                zoomControl:false, attributionControl:true});
  nightTile  = L.tileLayer(TILE_NIGHT, TILE_OPTS).addTo(leafMap);
  dayTile    = L.tileLayer(TILE_DAY,   TILE_OPTS).addTo(leafMap);
  dayTile.setOpacity(0);   // start at night

  BOROUGHS.forEach(b => {
    const ll = COORDS[b];
    markers[b] = {
      outer: L.circleMarker(ll,{radius:12,color:GREEN,fillColor:GREEN,
               fillOpacity:.08,weight:1,interactive:false}).addTo(leafMap),
      inner: L.circleMarker(ll,{radius:10,color:GREEN,fillColor:GREEN,
               fillOpacity:.55,weight:2}).addTo(leafMap),
    };
    markers[b].inner.bindTooltip('',{direction:'top',opacity:1,
      className:'map-tip',permanent:false});
    prevR[b] = 10;
  });
}

// ── Event marker on map ───────────────────────────────
let evPulseToken = 0;
function updateEventMarker() {
  // Remove stale marker
  if (eventMarker) {
    eventMarker.inner.remove();
    eventMarker.outer.remove();
    eventMarker = null;
  }
  ++evPulseToken;   // cancel any running pulse

  const ev = S.events?.[S.dates[S.idx]];
  if (!ev || !leafMap) return;

  // Only show during the event's active hours
  if (S.hour < ev.start_h || S.hour > ev.end_h) return;

  // Scale radius with the event borough's current ride volume.
  // Find max rides for that borough during the event window → gives relative intensity.
  let peakBoroRides = 1;
  for (let h = ev.start_h; h <= ev.end_h; h++) {
    const r = hourOf(S.today, h)?.boroughs?.[ev.borough]?.rides ?? 0;
    if (r > peakBoroRides) peakBoroRides = r;
  }
  const curBoroRides = hourOf(S.today, S.hour)?.boroughs?.[ev.borough]?.rides ?? 0;
  const frac   = Math.min(curBoroRides / peakBoroRides, 1);
  const R_MIN  = 10, R_MAX = 42;
  const radius = R_MIN + frac * (R_MAX - R_MIN);

  const ll = [ev.lat, ev.lon];
  eventMarker = {
    outer: L.circleMarker(ll, {radius: radius * 1.5, color: EVENT_COLOR,
             fillColor: EVENT_COLOR, fillOpacity: .08, weight: 1.5,
             interactive: false}).addTo(leafMap),
    inner: L.circleMarker(ll, {radius, color: EVENT_COLOR,
             fillColor: EVENT_COLOR, fillOpacity: .65, weight: 2}).addTo(leafMap),
  };
  eventMarker.inner.bindTooltip(
    `<div class="map-tip-title">${ev.icon} ${ev.name}</div>` +
    `<div class="map-tip-row"><span>Location</span><span>${ev.loc}</span></div>` +
    `<div class="map-tip-row"><span>Active hours</span><span>${ev.start_h}:00 – ${ev.end_h}:00</span></div>` +
    `<div class="map-tip-row"><span>Impact</span><span>${ev.note}</span></div>`,
    {direction:'top', opacity:1, className:'map-tip', permanent:false}
  );

  // Pulse outer ring at current radius ±15%
  const tok = ++evPulseToken;
  const t0  = performance.now(), dur = 1400;
  (function pulse(now) {
    if (evPulseToken !== tok || !eventMarker) return;
    const cycle = ((now - t0) % (dur * 2)) / dur;
    const p = cycle <= 1 ? cycle : 2 - cycle;
    const ease = p * p * (3 - 2 * p);
    eventMarker.outer.setRadius(radius * 1.5 + radius * 0.4 * ease);
    requestAnimationFrame(pulse);
  })(performance.now());
}

function updateMap() {
  animateDayTile(getSunFraction(S.dates[S.idx], S.hour));
  const cur = hourOf(S.today, S.hour);
  if (!cur || !leafMap) return;
  const vals  = BOROUGHS.map(b => cur.boroughs?.[b]?.rides ?? 0);
  const maxV  = Math.max(...vals, 1);
  const MIN=6, MAX=55;

  BOROUGHS.forEach((b,i) => {
    const target = MIN + (vals[i]/maxV)*(MAX-MIN);
    animMarker(b, target);

    // Tooltip content
    const total   = vals.reduce((a,v) => a+v, 0);
    const share   = total > 0 ? (vals[i]/total*100).toFixed(0)+'%' : '—';
    const boroFare = cur.boroughs?.[b]?.avg_fare;
    const fareStr  = boroFare != null ? '$'+boroFare.toFixed(2) : '—';
    markers[b].inner.setTooltipContent(
      `<div class="map-tip-title">${b}</div>` +
      `<div class="map-tip-row"><span>Rides this hour</span><span>${vals[i].toLocaleString()}</span></div>` +
      `<div class="map-tip-row"><span>Share of NYC rides</span><span>${share}</span></div>` +
      `<div class="map-tip-row"><span>Average fare per ride</span><span>${fareStr}</span></div>`
    );
  });

  // Update map title
  const ds = S.dates[S.idx];
  const d  = new Date(ds+'T12:00:00');
  document.getElementById('map-title').textContent =
    'NYC LIVE DEMAND MAP · '+MONTHS[d.getMonth()]+' '+d.getDate()+', '+d.getFullYear();
}

function animMarker(b, target) {
  const from = prevR[b] ?? target;
  prevR[b] = target;
  const start = performance.now();
  const dur   = 420;
  function step(now) {
    const p = Math.min((now-start)/dur, 1);
    const e = 1-Math.pow(1-p,3);          // ease-out cubic
    const r = from + (target-from)*e;
    markers[b].inner.setRadius(r);
    markers[b].outer.setRadius(r*1.6);
    if (p<1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Same-weekday peer chart ────────────────────────────
const HOUR_TICK_VALS = [0,3,6,9,12,15,18,21,23];
const HOUR_TICK_TEXT = ['12am','3am','6am','9am','12pm','3pm','6pm','9pm','11pm'];
const AMBER = '#f5a623';
const DOW_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function initPeerChart() {
  Plotly.newPlot('heatmap-chart', [], {
    ...baseLayout(148, {
      xaxis: {tickvals:HOUR_TICK_VALS, ticktext:HOUR_TICK_TEXT},
      yaxis: {},
    }),
    showlegend: true,
    legend: {orientation:'h', x:0, y:1.18, xanchor:'left',
             font:{size:9, color:'#717875'}, bgcolor:'rgba(0,0,0,0)', borderwidth:0},
  }, {responsive:true, displayModeBar:false});
}

function updatePeerChart() {
  const ds      = S.dates[S.idx];
  const dowName = DOW_NAMES[new Date(ds + 'T12:00:00').getDay()];

  function hoursY(dayData) {
    return Array.from({length:24}, (_, h) => hourOf(dayData, h)?.rides ?? null);
  }
  const hrs = Array.from({length:24}, (_, h) => h);

  // Forecast = per-hour average of peer days (only past data, no leakage)
  const forecastY = S.peerData.length
    ? Array.from({length:24}, (_, h) => {
        const vals = S.peerData.map(d => hourOf(d, h)?.rides ?? null).filter(v => v !== null);
        return vals.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length) : null;
      })
    : [];

  const peerTraces = [
    // Forecast = avg of last N same-weekdays (amber dashed)
    {
      type:'scatter', mode:'lines',
      x: hrs, y: forecastY,
      line: {color:AMBER, width:1.8, dash:'dash'},
      name: S.peers.length > 0 ? `Forecast (${S.peers.length}-wk avg)` : 'Forecast',
      hovertemplate: 'Forecast %{x}:00 → %{y:,} rides<extra></extra>',
    },
    // Today — bold green
    {
      type:'scatter', mode:'lines',
      x: hrs, y: hoursY(S.today),
      line: {color:GREEN, width:2.5},
      name: 'Today',
      hovertemplate: 'Today %{x}:00 → %{y:,} rides<extra></extra>',
    },
  ];

  Plotly.react('heatmap-chart', peerTraces, {
    ...baseLayout(148, {
      xaxis: {tickvals:HOUR_TICK_VALS, ticktext:HOUR_TICK_TEXT},
      yaxis: {},
    }),
    showlegend: true,
    legend: {orientation:'h', x:0, y:1.18, xanchor:'left',
             font:{size:9, color:'#717875'}, bgcolor:'rgba(0,0,0,0)', borderwidth:0},
    shapes: [{type:'line', xref:'x', yref:'paper',
              x0:S.hour, x1:S.hour, y0:0, y1:1,
              line:{color:GREEN, width:1.5, dash:'dot'}}],
  }, {responsive:true, displayModeBar:false});

  const n = S.peers.length;
  document.getElementById('peer-title').textContent = n > 0
    ? `LAST ${n} ${dowName.toUpperCase()}S — HOURLY RIDES`
    : `TODAY — HOURLY RIDES  (no prior ${dowName} data yet)`;

  // Readout: today vs peer avg at this hour
  const hrLabel   = S.hour === 0 ? '12am' : S.hour < 12 ? `${S.hour}am`
                  : S.hour === 12 ? '12pm' : `${S.hour-12}pm`;
  const todayNow  = hourOf(S.today, S.hour)?.rides ?? 0;
  const peerNow   = S.peerData.map(d => hourOf(d, S.hour)?.rides ?? 0).filter(r => r > 0);
  const avg       = peerNow.length ? Math.round(peerNow.reduce((a,b)=>a+b,0)/peerNow.length) : null;

  let html = `<strong>${dowName} ${hrLabel}</strong> · Today: <strong>${todayNow.toLocaleString()} rides</strong>`;
  if (avg !== null) {
    const diff = todayNow - avg;
    const pct  = avg > 0 ? ((diff/avg)*100).toFixed(1) : '0.0';
    const cls  = diff >= 0 ? 'hm-rank-hi' : 'hm-rank-lo';
    const sign = diff >= 0 ? '+' : '';
    const dowAbbr = dowName.slice(0, 3);
    html += ` · ${peerNow.length}-${dowAbbr} avg: ${avg.toLocaleString()} · <span class="${cls}">${sign}${pct}% vs recent baseline</span>`;
  }
  document.getElementById('heatmap-readout').innerHTML = html;
}

// ── Trend chart ───────────────────────────────────────
const trendLegendLayout = {
  showlegend: true,
  legend: {
    orientation: 'h', x: 0, y: 1.08, xanchor: 'left',
    font: {color:'#717875', size:9},
    bgcolor: 'rgba(0,0,0,0)', borderwidth: 0,
  },
};

function initTrendChart() {
  Plotly.newPlot('trend-chart', [
    {type:'scatter', x:[], y:[], name:'Daily rides', fill:'tozeroy',
     fillcolor:'rgba(6,193,103,0.10)', line:{color:GREEN, width:1.5},
     hovertemplate:'%{x} — %{y:,} rides<extra></extra>'},
    {type:'scatter', x:[], y:[], name:'7-day rolling avg', mode:'lines',
     line:{color:BLUE_REF, width:1.5, dash:'dot'},
     hovertemplate:'%{x} 7-day avg — %{y:,}<extra></extra>'},
    {type:'scatter', x:[], y:[], mode:'markers', showlegend:false, hoverinfo:'skip',
     marker:{color:GREEN, size:8, opacity:.9}},
  ],
  {...baseLayout(162), ...trendLegendLayout},
  {responsive:true, displayModeBar:false});
}

function updateTrendCursor() {
  const curDate = S.dates[S.idx];
  const ci = S.daily.findIndex(d => d.date === curDate);
  if (ci < 0) return;

  const WINDOW = 90;
  const slice  = S.daily.slice(Math.max(0, ci - WINDOW + 1), ci + 1);
  const dates  = slice.map(d => d.date);
  const rides  = slice.map(d => d.rides);
  const curRides = rides[rides.length - 1] ?? 0;

  // 7-day rolling average — smooths day-of-week noise to reveal the macro trend
  const rolling = rides.map((_, i) => {
    const win = rides.slice(Math.max(0, i - 6), i + 1).filter(v => v != null);
    return win.length ? Math.round(win.reduce((a,b)=>a+b,0)/win.length) : null;
  });

  const ttl = document.querySelector('.trend-sec .sec-title');
  if (ttl) ttl.textContent = '90-DAY MOMENTUM · DAILY RIDES + 7-DAY ROLLING AVG';

  // Weather shading: blue tint for rain/storm, lighter for snow
  const weatherShapes = [];
  if (S.weather) {
    dates.forEach(d => {
      const w = S.weather[d];
      if (!w) return;
      if (w.cat === 'rain' || w.cat === 'storm')
        weatherShapes.push({type:'rect', xref:'x', yref:'paper',
          x0:d, x1:d, y0:0, y1:1, fillcolor:'rgba(100,160,255,0.10)', line:{width:0}});
      else if (w.cat === 'snow')
        weatherShapes.push({type:'rect', xref:'x', yref:'paper',
          x0:d, x1:d, y0:0, y1:1, fillcolor:'rgba(200,220,255,0.14)', line:{width:0}});
    });
  }

  Plotly.react('trend-chart', [
    {type:'scatter', x:dates, y:rides, name:'Daily rides', fill:'tozeroy',
     fillcolor:'rgba(6,193,103,0.10)', line:{color:GREEN, width:1.5},
     hovertemplate:'%{x} — %{y:,} rides<extra></extra>'},
    {type:'scatter', x:dates, y:rolling, name:'7-day rolling avg', mode:'lines',
     line:{color:BLUE_REF, width:1.5, dash:'dot'},
     hovertemplate:'%{x} 7-day avg — %{y:,}<extra></extra>'},
    {type:'scatter', x:[curDate], y:[curRides], mode:'markers', showlegend:false, hoverinfo:'skip',
     marker:{color:GREEN, size:8, opacity:.9}},
  ],
  {...baseLayout(162), ...trendLegendLayout, shapes: weatherShapes},
  {transition:{duration:200, easing:'cubic-in-out'}, responsive:true, displayModeBar:false});
}

// ── Playback controls ─────────────────────────────────
function buildSpeedBtns() {
  const c = document.getElementById('speed-btns');
  SPEEDS.forEach((sp,i) => {
    const b = document.createElement('button');
    b.className = 'spd-btn' + (sp.ms===S.speedMs?' on':'');
    b.textContent = sp.l;
    b.addEventListener('click',()=>{
      S.speedMs = sp.ms;
      c.querySelectorAll('.spd-btn').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      if (S.playing) { clearInterval(timer); timer=setInterval(tick,S.speedMs); }
    });
    c.appendChild(b);
  });
}

function bindControls() {
  document.getElementById('play-btn').addEventListener('click', togglePlay);

  // Space bar = play/pause
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      togglePlay();
    }
  });

  document.getElementById('hour-slider').addEventListener('input', e => {
    S.hour = +e.target.value;
    document.getElementById('hour-display').textContent =
      String(S.hour).padStart(2,'0') + ':00';
    updateAll();
  });

  // Cap date picker to the actual data range so future dates can't be selected
  const dp = document.getElementById('date-picker');
  dp.min = S.dates[0];
  dp.max = S.dates[S.dates.length - 1];

  document.getElementById('btn-prev').addEventListener('click', async () => {
    if (S.idx > 0) { S.idx--; await loadDateRange(); updateAll(); }
  });
  document.getElementById('btn-next').addEventListener('click', async () => {
    if (S.idx < S.dates.length-1) { S.idx++; await loadDateRange(); updateAll(); }
  });
  dp.addEventListener('change', async e => {
    // Clamp to data range in case the browser calendar allows out-of-range navigation
    let val = e.target.value;
    if (val < S.dates[0])               val = S.dates[0];
    if (val > S.dates[S.dates.length-1]) val = S.dates[S.dates.length-1];
    dp.value = val;
    const i = S.dates.indexOf(val);
    if (i >= 0) { S.idx = i; await loadDateRange(); updateAll(); }
  });
}

function togglePlay() {
  S.playing = !S.playing;
  const btn = document.getElementById('play-btn');
  if (S.playing) {
    btn.textContent = '⏸  PAUSE';
    btn.classList.add('playing');
    timer = setInterval(tick, S.speedMs);
  } else {
    btn.textContent = '▶  PLAY';
    btn.classList.remove('playing');
    clearInterval(timer);
  }
  updateHeader();
}

async function tick() {
  S.hour = (S.hour+1) % 24;
  if (S.hour === 0) {
    if (S.idx >= S.dates.length-1) { togglePlay(); return; }
    S.idx++;
    await loadDateRange();
  }
  updateAll();
}
