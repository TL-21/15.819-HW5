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
const GREEN  = '#06C167';
const RED    = '#FF4B4B';
const DIM    = '#1e1e1e';
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
  numTargets: {},     // for animateNumber dedup
};
let timer = null;

// ── Map globals ───────────────────────────────────────
let leafMap = null;
const markers = {};   // borough → {inner, outer} Leaflet circles
const prevR   = {};   // last animated radius per borough

// ── Plot layout helper ────────────────────────────────
const plotBg = 'rgba(0,0,0,0)';
function baseLayout(h, extra = {}) {
  return {
    height: h,
    margin: {l:40,r:10,t:4,b:28},
    paper_bgcolor: plotBg, plot_bgcolor: plotBg,
    showlegend: false,
    font: {color:'#555', size:10},
    xaxis: {gridcolor: DIM, zeroline:false, showline:false, ...extra.xaxis},
    yaxis: {gridcolor: DIM, zeroline:false, showline:false, ...extra.yaxis},
  };
}

// ── Boot ──────────────────────────────────────────────
window.addEventListener('load', async () => {
  try {
    progress(10, 'Fetching metadata…');
    const [meta, daily] = await Promise.all([
      fetchJ('data/meta.json'),
      fetchJ('data/daily.json'),
    ]);
    S.dates = meta.dates;
    S.daily = daily;
    S.idx   = 0;
    S.hour  = 8;

    progress(32, 'Initialising demand chart…');
    initDemandChart();
    progress(44, 'Initialising trend chart…');
    initTrendChart();
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
  [S.today, S.yest, S.lw] = await Promise.all([
    loadDate(ds),
    loadDate(offsetDate(ds, -1)),
    loadDate(offsetDate(ds, -7)),
  ]);
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
  updateDemandChart();
  updateBoroBar();
  updateEco();
  updateAlerts();
  updateMap();
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
  const peak   = peakOf(S.today);

  // Rides
  animNum('k-rides', rides, v => Math.round(v).toLocaleString());
  setDelta('k-rides-d', rides, yest?.rides, 'vs yesterday');
  setText('k-rides-s', dtotal > 0 ? (rides/dtotal*100).toFixed(1)+'% of today\'s demand' : '');

  // Fare
  const fare = cur?.avg_fare;
  animNum('k-fare', fare ?? 0, v => fare != null ? '$'+v.toFixed(2) : '—');
  setDelta('k-fare-d', fare, yest?.avg_fare, 'vs yesterday');
  setText('k-fare-s', cur?.avg_miles != null ? cur.avg_miles.toFixed(1)+' mi avg trip' : '');

  // Demand vs peak
  const pct = peak.rides > 0 ? rides/peak.rides*100 : 0;
  animNum('k-peak', pct, v => Math.round(v)+'%');
  setText('k-peak-d', '');
  setText('k-peak-s', S.hour === peak.h ? '★ THIS IS THE PEAK HOUR' : 'Peak at '+String(peak.h).padStart(2,'0')+':00');

  // WoW
  const lwR = lw?.rides;
  if (lwR && lwR > 0) {
    const wp = (rides - lwR) / lwR * 100;
    animNum('k-wow', wp, v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%');
    const el = document.getElementById('k-wow');
    el.style.color = wp >= 0 ? GREEN : RED;
    setText('k-wow-d', '');
  } else {
    setText('k-wow', '—');
  }
  setText('k-wow-s', 'vs same hour last week');
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

// ── Demand curve ──────────────────────────────────────
function initDemandChart() {
  Plotly.newPlot('demand-chart',
    [{type:'scatter',x:[],y:[],name:'Yesterday',mode:'lines',
      line:{color:'#2a2a2a',width:1.5,dash:'dot'}},
     {type:'scatter',x:[],y:[],fill:'tozeroy',name:'Today',
      fillcolor:'rgba(6,193,103,0.07)',line:{color:GREEN,width:1.5}},
     {type:'scatter',x:[],y:[],fill:'tozeroy',fillcolor:'rgba(6,193,103,0.22)',
      line:{color:GREEN,width:2.5},showlegend:false,hoverinfo:'skip'},
     {type:'scatter',x:[],y:[],mode:'markers',showlegend:false,hoverinfo:'skip',
      marker:{color:GREEN,size:10,opacity:.9}},
    ],
    baseLayout(162,{xaxis:{tickvals:[0,3,6,9,12,15,18,21,23],
      ticktext:['00h','03h','06h','09h','12h','15h','18h','21h','23h']}}),
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
     line:{color:'#2a2a2a',width:1.5,dash:'dot'},
     hovertemplate:'%{x}:00 yest — %{y:,}<extra></extra>'},
    {type:'scatter',x:hrs,y:tY,fill:'tozeroy',name:'Today',
     fillcolor:'rgba(6,193,103,0.07)',line:{color:GREEN,width:1.5},
     hovertemplate:'%{x}:00 — %{y:,}<extra></extra>'},
    {type:'scatter',x:hrs.slice(0,h+1),y:tY.slice(0,h+1),fill:'tozeroy',
     fillcolor:'rgba(6,193,103,0.22)',line:{color:GREEN,width:2.5},
     showlegend:false,hoverinfo:'skip'},
    {type:'scatter',x:[h],y:[tY[h]],mode:'markers',showlegend:false,hoverinfo:'skip',
     marker:{color:GREEN,size:10,opacity:.9}},
  ],
  {...baseLayout(162,{xaxis:{tickvals:[0,3,6,9,12,15,18,21,23],
    ticktext:['00h','03h','06h','09h','12h','15h','18h','21h','23h']}}),
    shapes:[{type:'line',x0:h,x1:h,y0:0,y1:1,yref:'paper',
             line:{color:GREEN,width:1.5,dash:'dot'}}]},
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
  const maxV = Math.max(...vals, 1);
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
    meta.textContent = share + ' · ' + vals[i].toLocaleString();
  });
}

// ── Economics ─────────────────────────────────────────
function updateEco() {
  const cur  = hourOf(S.today, S.hour);
  const rides  = cur?.rides ?? 0;
  const fare   = cur?.avg_fare;
  const pay    = cur?.avg_pay;
  const miles  = cur?.avg_miles;
  const margin = (fare && pay && fare > 0) ? (fare - pay) / fare * 100 : null;
  const gross  = (fare && rides) ? rides * fare : null;
  const payouts= (pay  && rides) ? rides * pay  : null;
  const uberRev= (gross != null && payouts != null) ? gross - payouts : null;
  const pace   = rides > 0 ? (rides / 60).toFixed(1) : null;

  const fmt = v => v >= 1e6 ? '$'+(v/1e6).toFixed(2)+'M' : '$'+(v/1e3).toFixed(0)+'k';
  setText('e-gross',   gross   != null ? fmt(gross)   : '—');
  setText('e-uber',    uberRev != null ? fmt(uberRev) : '—');
  setText('e-payouts', payouts != null ? fmt(payouts) : '—');
  setText('e-pace',    pace    != null ? pace+'/min'  : '—');
  setText('e-fare',    fare    != null ? '$'+fare.toFixed(2) : '—');
  setText('e-pay',     pay     != null ? '$'+pay.toFixed(2)  : '—');
  setText('e-miles',   miles   != null ? miles.toFixed(1)+' mi' : '—');
  setText('e-margin',  margin  != null ? margin.toFixed(1)+'%'  : '—');
}

// ── GM Alerts ─────────────────────────────────────────
function updateAlerts() {
  const cur  = hourOf(S.today, S.hour);
  const yest = hourOf(S.yest,  S.hour);
  const lw   = hourOf(S.lw,    S.hour);
  const alerts = [];

  if (cur && yest && yest.rides > 0) {
    const delta = (cur.rides - yest.rides) / yest.rides * 100;
    if (delta > 15)
      alerts.push({cls:'hot', icon:'📈', txt:`Demand +${delta.toFixed(0)}% vs yesterday — consider driver incentives to boost supply.`});
    else if (delta < -15)
      alerts.push({cls:'cold', icon:'📉', txt:`Demand ${delta.toFixed(0)}% vs yesterday — ease surge pricing to stimulate rides.`});
  }
  if (cur && lw && lw.rides > 0) {
    const wp = (cur.rides - lw.rides) / lw.rides * 100;
    if (Math.abs(wp) > 20)
      alerts.push({cls: wp>0?'hot':'warn', icon: wp>0?'🚀':'⚠️',
        txt:`WoW ${wp>0?'+':''}${wp.toFixed(0)}% vs last week — ${wp>0?'strong growth, monitor driver supply':'investigate drop, check for service issues'}.`});
  }
  const peak = peakOf(S.today);
  if (cur && S.hour === peak.h)
    alerts.push({cls:'hot', icon:'⚡', txt:`Peak hour now. Activate driver bonuses to maximise availability.`});

  const margin = cur?.avg_fare && cur?.avg_pay && cur.avg_fare > 0
    ? (cur.avg_fare - cur.avg_pay) / cur.avg_fare * 100 : null;
  if (margin != null && margin < 18)
    alerts.push({cls:'warn', icon:'💸', txt:`Platform margin ${margin.toFixed(1)}% — below 18% target. Review driver pay rate.`});
  if (margin != null && margin > 30)
    alerts.push({cls:'hot', icon:'✅', txt:`Strong margin ${margin.toFixed(1)}% — healthy unit economics this hour.`});

  if (alerts.length === 0)
    alerts.push({cls:'cold', icon:'—', txt:'Demand within normal range. No action required.'});

  const el = document.getElementById('alert-row');
  if (!el) return;
  el.innerHTML = alerts.map(a =>
    `<div class="alert-item ${a.cls}"><span class="alert-icon">${a.icon}</span><span class="alert-txt">${a.txt}</span></div>`
  ).join('');
}

// ── Leaflet map ───────────────────────────────────────
function initMap() {
  leafMap = L.map('map', {
    center:[40.73,-73.97], zoom:10,
    zoomControl:false, attributionControl:true,
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{
    attribution:'© <a href="https://openstreetmap.org">OSM</a> © <a href="https://carto.com">CARTO</a>',
    subdomains:'abcd', maxZoom:19,
  }).addTo(leafMap);

  BOROUGHS.forEach(b => {
    const ll = COORDS[b];
    markers[b] = {
      outer: L.circleMarker(ll,{radius:12,color:GREEN,fillColor:GREEN,
               fillOpacity:.08,weight:1,interactive:false}).addTo(leafMap),
      inner: L.circleMarker(ll,{radius:10,color:GREEN,fillColor:GREEN,
               fillOpacity:.55,weight:2}).addTo(leafMap),
    };
    markers[b].inner.bindTooltip(b,{direction:'top',opacity:.9,
      className:'leaflet-tooltip',permanent:false});
    prevR[b] = 10;
  });
}

function updateMap() {
  const cur = hourOf(S.today, S.hour);
  if (!cur || !leafMap) return;
  const vals  = BOROUGHS.map(b => cur.boroughs?.[b]?.rides ?? 0);
  const maxV  = Math.max(...vals, 1);
  const MIN=6, MAX=55;

  BOROUGHS.forEach((b,i) => {
    const target = MIN + (vals[i]/maxV)*(MAX-MIN);
    animMarker(b, target);

    // Tooltip content
    const share = (vals.reduce((a,v)=>a+v,0) > 0)
      ? (vals[i]/vals.reduce((a,v)=>a+v,0)*100).toFixed(0)+'%'
      : '—';
    markers[b].inner.setTooltipContent(
      `<b>${b}</b><br>${vals[i].toLocaleString()} rides (${share})`
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

// ── Trend chart ───────────────────────────────────────
function initTrendChart() {
  Plotly.newPlot('trend-chart',[
    {type:'scatter',x:[],y:[],name:'Prior week',mode:'lines',
     line:{color:'#333',width:1.2,dash:'dot'},hoverinfo:'skip'},
    {type:'scatter',x:[],y:[],name:'Daily rides',fill:'tozeroy',
     fillcolor:'rgba(6,193,103,0.07)',line:{color:GREEN,width:1.5},
     hovertemplate:'%{x} — %{y:,} rides<extra></extra>'},
    {type:'scatter',x:[],y:[],mode:'markers',showlegend:false,hoverinfo:'skip',
     marker:{color:GREEN,size:8,opacity:.9}},
  ],
  baseLayout(152),
  {responsive:true,displayModeBar:false});
}

function updateTrendCursor() {
  const curDate = S.dates[S.idx];
  const ci = S.daily.findIndex(d => d.date === curDate);
  if (ci < 0) return;

  const WINDOW = 90;
  const slice  = S.daily.slice(Math.max(0, ci - WINDOW + 1), ci + 1);
  const dates  = slice.map(d => d.date);
  const rides  = slice.map(d => d.rides);
  const wow    = slice.map(d => d.rides_wow ?? null);
  const curRides = rides[rides.length - 1] ?? 0;

  // Update section title
  const ttl = document.querySelector('.trend-sec .sec-title');
  if (ttl) ttl.textContent = '90-DAY RIDE TREND · TRAILING · WEEK-OVER-WEEK';

  Plotly.react('trend-chart',[
    {type:'scatter',x:dates,y:wow,name:'Prior week',mode:'lines',
     line:{color:'#333',width:1.2,dash:'dot'},hoverinfo:'skip'},
    {type:'scatter',x:dates,y:rides,name:'Daily rides',fill:'tozeroy',
     fillcolor:'rgba(6,193,103,0.07)',line:{color:GREEN,width:1.5},
     hovertemplate:'%{x} — %{y:,} rides<extra></extra>'},
    {type:'scatter',x:[curDate],y:[curRides],mode:'markers',showlegend:false,hoverinfo:'skip',
     marker:{color:GREEN,size:8,opacity:.9}},
  ],
  baseLayout(152),
  {transition:{duration:200,easing:'cubic-in-out'},responsive:true,displayModeBar:false});
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

  document.getElementById('hour-slider').addEventListener('input', e => {
    S.hour = +e.target.value;
    document.getElementById('hour-display').textContent =
      String(S.hour).padStart(2,'0') + ':00';
    updateAll();
  });

  document.getElementById('btn-prev').addEventListener('click', async () => {
    if (S.idx > 0) { S.idx--; await loadDateRange(); updateAll(); }
  });
  document.getElementById('btn-next').addEventListener('click', async () => {
    if (S.idx < S.dates.length-1) { S.idx++; await loadDateRange(); updateAll(); }
  });
  document.getElementById('date-picker').addEventListener('change', async e => {
    const i = S.dates.indexOf(e.target.value);
    if (i>=0) { S.idx=i; await loadDateRange(); updateAll(); }
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
