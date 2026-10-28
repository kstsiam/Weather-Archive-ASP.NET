(() => {
const GREVENA = [40.084, 21.427];
const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const iso = d => d.toISOString().slice(0,10);
const fmt = (v, d=1) => v == null || isNaN(v) ? '—' : v.toLocaleString('el-GR',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtDate = s => { if(!s) return ''; const p=s.split('-'); return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:p.length===2?`${p[1]}/${p[0]}`:s; };

const DAILY = ['temperature_2m_max','temperature_2m_min','temperature_2m_mean','precipitation_sum','rain_sum','snowfall_sum',
  'precipitation_hours','wind_speed_10m_max','wind_gusts_10m_max','wind_direction_10m_dominant','shortwave_radiation_sum','et0_fao_evapotranspiration','sunshine_duration'];

let point = null, data = null, ctrl = null, charts = {};

/* ---------- Χάρτης ---------- */
const map = L.map('map', {zoomControl:true}).setView(GREVENA, 10);
const base = {
  'Τοπογραφικός (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {maxZoom:17, attribution:'© OpenStreetMap, SRTM · © OpenTopoMap (CC-BY-SA)'}),
  'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'© OpenStreetMap contributors'}),
  'Δορυφορικός (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'Tiles © Esri'})
};
base['Τοπογραφικός (OpenTopoMap)'].addTo(map);
L.control.layers(base, null, {position:'topright'}).addTo(map);
L.control.scale({imperial:false}).addTo(map);
let marker = null;
map.on('click', e => setPoint(e.latlng.lat, e.latlng.lng, true));

function setPoint(lat, lon, load){
  lat = +(+lat).toFixed(4); lon = +(+lon).toFixed(4);
  point = {lat, lon};
  $('lat').value = lat; $('lon').value = lon;
  $('coords').textContent = `${lat.toFixed(4)}° Β, ${lon.toFixed(4)}° Α`;
  const style = {radius:8, color:css('--panel'), weight:2, fillColor:css('--tmax'), fillOpacity:1};
  if(marker) marker.setLatLng([lat,lon]).setStyle(style); else marker = L.circleMarker([lat,lon], style).addTo(map);
  if(load) loadData();
}

/* ---------- Ημερομηνίες ---------- */
const maxEnd = new Date();
$('end').max = $('start').max = iso(maxEnd);
function preset(days){
  $('end').value = iso(maxEnd);
  $('start').value = iso(new Date(maxEnd - (days-1)*864e5));
  document.querySelectorAll('#presets button').forEach(b => b.classList.toggle('on', +b.dataset.d === days));
}
$('presets').addEventListener('click', e => { const b=e.target.closest('button'); if(!b) return; preset(+b.dataset.d); if(point) loadData(); });
['start','end'].forEach(id => $(id).addEventListener('change', () => document.querySelectorAll('#presets button').forEach(b=>b.classList.remove('on'))));
$('go').addEventListener('click', () => {
  const lat = parseFloat($('lat').value), lon = parseFloat($('lon').value);
  if(isNaN(lat)||isNaN(lon)) return status('Δώσε έγκυρες συντεταγμένες.', true);
  setPoint(lat, lon, false); map.panTo([lat,lon]); loadData();
});
$('model').addEventListener('change', () => point && loadData());
$('agg').addEventListener('change', () => data && render());

function status(msg, err){ const s=$('status'); s.textContent = msg; s.classList.toggle('err', !!err); }

/* ---------- Λήψη ---------- */
async function loadData(){
  if(!point) return;
  const start = $('start').value, end = $('end').value;
  if(!start || !end || start > end) return status('Το διάστημα ημερομηνιών δεν είναι έγκυρο.', true);
  if(ctrl) ctrl.abort();
  ctrl = new AbortController();
  const u = new URL('/api/archive', location.origin);
  u.search = new URLSearchParams({latitude:point.lat, longitude:point.lon, start_date:start, end_date:end,
    daily:DAILY.join(','), timezone:'Europe/Athens'});
  const m = $('model').value; if(m !== 'best_match') u.searchParams.set('models', m);
  status('Φόρτωση δεδομένων…'); $('go').disabled = true;
  try{
    const r = await fetch(u, {signal:ctrl.signal});
    const j = await r.json();
    if(!r.ok || j.error) throw new Error(j.reason || `HTTP ${r.status}`);
    // κόψε τις τελευταίες κενές ημέρες
    let n = j.daily.time.length;
    while(n > 0 && j.daily.temperature_2m_max[n-1] == null) n--;
    const d = {}; for(const k in j.daily) d[k] = j.daily[k].slice(0, n);
    data = {daily:d, elevation:j.elevation, lat:j.latitude, lon:j.longitude, model:m, start, end};
    $('meta').textContent = `υψόμετρο κελιού ${fmt(j.elevation,0)} m · κέντρο κελιού ${j.latitude.toFixed(3)}, ${j.longitude.toFixed(3)}`;
    status(`${n.toLocaleString('el-GR')} ημέρες, ${fmtDate(d.time[0])} – ${fmtDate(d.time[n-1])}`);
    $('csv').disabled = false;
    render();
  }catch(e){
    if(e.name === 'AbortError') return;
    status(`Δεν φορτώθηκαν δεδομένα: ${e.message}. Έλεγξε τη σύνδεση ή δοκίμασε μικρότερο διάστημα.`, true);
  }finally{ $('go').disabled = false; }
}

/* ---------- Ομαδοποίηση ---------- */
function aggregate(d, mode){
  if(mode === 'day') return {labels:d.time, s:d};
  const keyLen = mode === 'month' ? 7 : 4;
  const groups = new Map();
  d.time.forEach((t,i) => { const k=t.slice(0,keyLen); if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(i); });
  const mean = (arr, idx) => { const v=idx.map(i=>arr[i]).filter(x=>x!=null); return v.length? v.reduce((a,b)=>a+b,0)/v.length : null; };
  const sum  = (arr, idx) => { const v=idx.map(i=>arr[i]).filter(x=>x!=null); return v.length? v.reduce((a,b)=>a+b,0) : null; };
  const max  = (arr, idx) => { const v=idx.map(i=>arr[i]).filter(x=>x!=null); return v.length? Math.max(...v) : null; };
  const rule = {temperature_2m_max:mean, temperature_2m_min:mean, temperature_2m_mean:mean, precipitation_sum:sum, rain_sum:sum,
    snowfall_sum:sum, precipitation_hours:sum, wind_speed_10m_max:mean, wind_gusts_10m_max:max, shortwave_radiation_sum:sum,
    et0_fao_evapotranspiration:sum, sunshine_duration:sum};
  const s = {}; for(const k in rule) s[k] = [];
  for(const idx of groups.values()) for(const k in rule) s[k].push(d[k] ? rule[k](d[k], idx) : null);
  return {labels:[...groups.keys()], s};
}

/* ---------- Απεικόνιση ---------- */
function render(){
  if(!data) return;
  const d = data.daily, n = d.time.length;
  let mode = $('agg').value;
  if(mode === 'auto') mode = n > 3700 ? 'year' : n > 400 ? 'month' : 'day';
  const {labels, s} = aggregate(d, mode);
  const lab = labels.map(fmtDate);
  const per = {day:'ημερήσια', month:'μηνιαία', year:'ετήσια'}[mode];

  // Δείκτες (πάντα από τις ημερήσιες τιμές)
  const vals = k => d[k].filter(v => v!=null);
  const argOf = (k, fn) => { let bi=-1; d[k].forEach((v,i)=>{ if(v!=null && (bi<0 || fn(v, d[k][bi]))) bi=i; }); return bi; };
  const iMax = argOf('temperature_2m_max', (a,b)=>a>b), iMin = argOf('temperature_2m_min', (a,b)=>a<b);
  const iRain = argOf('precipitation_sum', (a,b)=>a>b), iGust = argOf('wind_gusts_10m_max', (a,b)=>a>b);
  const tmean = vals('temperature_2m_mean'); const avgT = tmean.reduce((a,b)=>a+b,0)/tmean.length;
  const years = n / 365.25;
  const totP = vals('precipitation_sum').reduce((a,b)=>a+b,0);
  const totS = vals('snowfall_sum').reduce((a,b)=>a+b,0);
  const wet = vals('precipitation_sum').filter(v=>v>=1).length;
  const frost = vals('temperature_2m_min').filter(v=>v<0).length;
  const hot = vals('temperature_2m_max').filter(v=>v>=30).length;
  const perY = years >= 1.5;
  const tile = (k,v,sub) => `<div class="tile"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${sub||'&nbsp;'}</span></div>`;
  $('tiles').innerHTML =
    tile('Μέση θερμοκρασία', `${fmt(avgT)} °C`, `περίοδος ${fmt(years,1)} ετών`) +
    tile('Μέγιστη', `${fmt(d.temperature_2m_max[iMax])} °C`, fmtDate(d.time[iMax])) +
    tile('Ελάχιστη', `${fmt(d.temperature_2m_min[iMin])} °C`, fmtDate(d.time[iMin])) +
    tile(perY ? 'Υετός / έτος' : 'Συνολικός υετός', `${fmt(perY ? totP/years : totP, 0)} mm`, `μέγ. ημέρας ${fmt(d.precipitation_sum[iRain])} mm`) +
    tile(perY ? 'Χιόνι / έτος' : 'Χιονόπτωση', `${fmt(perY ? totS/years : totS, 0)} cm`, 'φρέσκο χιόνι') +
    tile(perY ? 'Ημέρες βροχής / έτος' : 'Ημέρες βροχής', fmt(perY ? wet/years : wet, 0), 'υετός ≥ 1 mm') +
    tile(perY ? 'Ημέρες παγετού / έτος' : 'Ημέρες παγετού', fmt(perY ? frost/years : frost, 0), `ελάχ. < 0 °C · ≥30 °C: ${fmt(perY?hot/years:hot,0)}`) +
    tile('Μέγ. ριπή ανέμου', `${fmt(d.wind_gusts_10m_max[iGust],0)} km/h`, fmtDate(d.time[iGust]));

  $('u-t').textContent = `°C · ${per}`;
  $('u-p').textContent = `mm · χιόνι cm · ${per === 'ημερήσια' ? 'ανά ημέρα' : 'αθροίσματα ' + (mode==='month'?'μήνα':'έτους')}`;

  const C = {fg:css('--fg'), muted:css('--muted'), line:css('--line'), panel:css('--panel')};
  Chart.defaults.color = C.muted; Chart.defaults.borderColor = C.line;
  Chart.defaults.font.family = css('--display'); Chart.defaults.font.size = 12;
  const pts = labels.length > 120 ? 0 : 2;
  const line = (label, arr, color, extra={}) => ({type:'line', label, data:arr, borderColor:color, backgroundColor:color, borderWidth:1.6, pointRadius:pts, pointHoverRadius:4, tension:.25, spanGaps:true, ...extra});
  const bar  = (label, arr, color, extra={}) => ({type:'bar', label, data:arr, backgroundColor:color, borderWidth:0, ...extra});
  const alpha = (hex, a) => hex + Math.round(a*255).toString(16).padStart(2,'0');
  const opts = (yTitle, y2) => ({
    responsive:true, maintainAspectRatio:false, animation:false, interaction:{mode:'index', intersect:false},
    plugins:{legend:{position:'bottom', labels:{boxWidth:10, boxHeight:10, usePointStyle:true, padding:14}},
      tooltip:{backgroundColor:C.panel, titleColor:C.fg, bodyColor:C.fg, borderColor:C.line, borderWidth:1,
        callbacks:{label:c => `${c.dataset.label}: ${c.parsed.y==null?'—':c.parsed.y.toLocaleString('el-GR',{maximumFractionDigits:1})}`}}},
    scales:{x:{grid:{display:false}, ticks:{maxTicksLimit:10, maxRotation:0, autoSkip:true}},
      y:{title:{display:true, text:yTitle}, grid:{color:C.line}},
      ...(y2 ? {y2:{position:'right', title:{display:true, text:y2}, grid:{display:false}}} : {})}
  });
  const draw = (id, datasets, o) => { charts[id]?.destroy(); charts[id] = new Chart($(id), {data:{labels:lab, datasets}, options:o}); };

  const tmax=css('--tmax'), tmin=css('--tmin');
  draw('c-temp', [
    line(mode==='day'?'Μέγιστη':'Μ.ό. μέγιστων', s.temperature_2m_max, tmax, {fill:'+2', backgroundColor:alpha(css('--tmean'),.12)}),
    line('Μέση', s.temperature_2m_mean, css('--tmean'), {borderDash:[4,3]}),
    line(mode==='day'?'Ελάχιστη':'Μ.ό. ελάχιστων', s.temperature_2m_min, tmin)
  ], opts('°C'));
  draw('c-prec', [
    bar('Βροχή', s.rain_sum, css('--rain'), {stack:'p'}),
    bar('Χιόνι (cm)', s.snowfall_sum, alpha(css('--snow'),.85), {yAxisID:'y2'})
  ], (()=>{ const o = opts('mm','cm χιονιού'); o.scales.x.stacked = true; return o; })());
  draw('c-wind', [
    line(mode==='day'?'Μέγ. ταχύτητα':'Μ.ό. μέγ. ταχύτητας', s.wind_speed_10m_max, css('--wind')),
    line('Μέγ. ριπή', s.wind_gusts_10m_max, css('--gust'), {borderDash:[4,3]})
  ], opts('km/h'));
  draw('c-rad', [
    bar('Ηλιακή ακτινοβολία', s.shortwave_radiation_sum, alpha(css('--rad'),.75)),
    line('ET₀ (FAO-56)', s.et0_fao_evapotranspiration, css('--et0'), {yAxisID:'y2', borderWidth:2})
  ], opts('MJ/m²','mm'));
}

/* ---------- CSV ---------- */
$('csv').addEventListener('click', () => {
  if(!data) return;
  const d = data.daily, keys = Object.keys(d);
  const rows = [keys.join(',')].concat(d.time.map((_,i) => keys.map(k => d[k][i] ?? '').join(',')));
  const head = `# lat=${data.lat},lon=${data.lon},elevation=${data.elevation},model=${data.model},source=Open-Meteo archive API\n`;
  const blob = new Blob([head + rows.join('\n')], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kairos_${data.lat.toFixed(3)}_${data.lon.toFixed(3)}_${data.start}_${data.end}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { render(); point && setPoint(point.lat, point.lon, false); });

/* ---------- Εκκίνηση: πόλη των Γρεβενών ---------- */
preset(365);

/* ---------- Αυτόματη ενημέρωση έως σήμερα ---------- */
let autoTimer = null;
function setAuto(on){
  clearInterval(autoTimer);
  if(on) autoTimer = setInterval(() => {
    if(!point || document.hidden) return;
    const today = iso(new Date());
    if($('end').value && $('end').value < today && $('end').dataset.auto === '1'){ $('end').value = today; }
    loadData();
  }, 30*60*1000);
}
$('auto').addEventListener('change', () => { setAuto($('auto').checked); if($('auto').checked){ $('end').value = iso(new Date()); $('end').dataset.auto = '1'; if(point) loadData(); } });
$('end').addEventListener('change', () => { $('end').dataset.auto = '0'; });
$('end').dataset.auto = '1';
setAuto(true);
setPoint(GREVENA[0], GREVENA[1], true);
})();
