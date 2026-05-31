#!/usr/bin/env node
// YourConcertTix sync — pulls events + photos from Airtable, rebuilds index.html,
// and stages /artist-photos/ + index.html for commit.
//
// Environment variables (required):
//   AIRTABLE_PAT   Airtable personal access token with read access to base appEy2dr1ecmzbEpb
//
// Usage:
//   node scripts/sync.mjs            # write into repo root
//   node scripts/sync.mjs --dry-run  # don't write files, just print summary

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
if (!AIRTABLE_PAT) {
  console.error('ERROR: AIRTABLE_PAT env var is required');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

const BASE_ID = 'appEy2dr1ecmzbEpb';
const EVENTS_TABLE = 'tblu9UIlpXChPdvOB';
const BANDS_TABLE = 'tblOsZIDmFHt01rJn';
const VENUES_TABLE = 'tblno252DKqUf55As';

// Event field IDs
const F_SHOW_INFO     = 'fld2ky88mk1cTECxX';
const F_TICKET        = 'fldjR0adsgFVDbzSe';
const F_START_DATE    = 'fld0VBiok50LzeKRZ';
const F_ARTIST_LINK   = 'fldRZ99cnPxHyPL18'; // actual link to BANDS-SHOWS (multipleRecordLinks)
const F_ARTIST_LOOK   = 'fldVCAKyZlT8fYcbO'; // lookup → band Name (singleLineText)
const F_SHOWTIME      = 'fldpARJ5yjNnIhsTN';
const F_CITY          = 'fldQxfhltNZfraKRq'; // lookup → singleLineText
const F_STATE         = 'fldTn8sdmJ4UbPX5x'; // lookup → singleSelect {name,...}
const F_VENUE_LINK    = 'fldWNKIABxBYUyX0A'; // multipleRecordLinks → VENUES (From CP)
const F_VENUE_ADDR    = 'fldv6kMv0wmhrpLql'; // "Venue Location" formula → full address string
const F_PLATFORM      = 'fldczQJUGFvhg2NrC'; // lookup → multipleSelects

// Bands field IDs
const F_NAME     = 'fldLzk7pDCwNsBQob';
const F_WEB_IMG  = 'fldmdmT8dvg45MLyn'; // Poster/Portrait (1:1, e.g. 1254x1254)
const F_BIO      = 'fldZRMHNofVVU5S6J'; // "Copy" — performer bio / show description (longText)
const F_TAGLINE  = 'fldTq2ehkhKtjfRUU'; // "Tagline" — short subtitle, e.g. "A Tribute to John Lennon"
const F_PROMO_VIDEO = 'fldPzPlEyiezhUMrB'; // "Promo Video" — YouTube URL (url field)

// Venues field IDs
const F_VENUE_NAME = 'fldNt6WjlSP0tivQ2'; // primary field "Name" on VENUES (From CP)

const SLUG_FIXES = {
  "Britain's Finest": 'britains-finest',
  'Britain\u2019s Finest': 'britains-finest',
  'THE MOODY BLUES TRIBUTE - GO NOW!': 'the-moody-blues-tribute--go-now',
  'Yachtzilla - The Monsters of Soft Rock': 'yachtzilla--the-monsters-of-soft-rock',
};

function slugify(name) {
  if (!name) return '';
  if (SLUG_FIXES[name]) return SLUG_FIXES[name];
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const photosDir = path.join(repoRoot, 'artist-photos');
const indexPath = path.join(repoRoot, 'index.html');
const eventsDir = path.join(repoRoot, 'events');

// Gradient fallback palette — kept in sync with the client-side card renderer below.
const PALETTE = [
  'linear-gradient(135deg,#e94560,#f5a623)', 'linear-gradient(135deg,#6a11cb,#2575fc)',
  'linear-gradient(135deg,#ff512f,#dd2476)', 'linear-gradient(135deg,#11998e,#38ef7d)',
  'linear-gradient(135deg,#f12711,#f5af19)', 'linear-gradient(135deg,#8e2de2,#4a00e0)',
  'linear-gradient(135deg,#ee0979,#ff6a00)', 'linear-gradient(135deg,#4568dc,#b06ab3)',
  'linear-gradient(135deg,#c94b4b,#4b134f)', 'linear-gradient(135deg,#ff9966,#ff5e62)',
];
function gradFor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function formatLongDate(d) {
  const dt = new Date(d + 'T12:00:00');
  if (isNaN(dt)) return d;
  return `${WEEKDAYS[dt.getDay()]}, ${MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}
// Values that mean "no real ticket" — events matching these are excluded entirely.
// Matched case-insensitively and trimmed, so "N/A", "n/a", "Not Available", etc. all count.
const UNAVAILABLE_TICKETS = new Set([
  'n/a', 'na', 'not available', 'not applicable',
]);
function isUnavailableTicket(ticket) {
  if (!ticket) return true;
  return UNAVAILABLE_TICKETS.has(String(ticket).trim().toLowerCase());
}
function hasValidTicket(ticket) {
  return !isUnavailableTicket(ticket);
}

// ---- Airtable REST helpers ----

async function airtableListAll(tableId, { fields = [], filterByFormula = null, sort = [] } = {}) {
  const records = [];
  let offset = null;
  do {
    const params = new URLSearchParams();
    for (const f of fields) params.append('fields[]', f);
    for (let i = 0; i < sort.length; i++) {
      params.append(`sort[${i}][field]`, sort[i].field);
      params.append(`sort[${i}][direction]`, sort[i].direction || 'asc');
    }
    if (filterByFormula) params.set('filterByFormula', filterByFormula);
    params.set('returnFieldsByFieldId', 'true');
    params.set('pageSize', '100');
    if (offset) params.set('offset', offset);

    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}?${params}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable ${tableId} ${res.status}: ${body.slice(0, 500)}`);
    }
    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

// ---- Value extractors ----

// Lookup fields return arrays. For text lookups, entries are strings.
// For select lookups, entries are {id, name, color} objects.
// For multipleSelects lookups, entries may be arrays of objects.
function firstLookupText(val) {
  if (val == null) return '';
  if (Array.isArray(val)) {
    for (const v of val) {
      if (v == null) continue;
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) {
        const inner = firstLookupText(v);
        if (inner) return inner;
      } else if (typeof v === 'object') {
        if (typeof v.name === 'string') return v.name;
      }
    }
    return '';
  }
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && typeof val.name === 'string') return val.name;
  return String(val);
}

// ---- Pull events ----

async function pullEvents() {
  const today = new Date().toISOString().slice(0, 10);
  const records = await airtableListAll(EVENTS_TABLE, {
    fields: [
      F_SHOW_INFO, F_TICKET, F_START_DATE, F_ARTIST_LINK, F_ARTIST_LOOK,
      F_SHOWTIME, F_CITY, F_STATE, F_VENUE_LINK, F_VENUE_ADDR, F_PLATFORM,
    ],
    // Use field name for filterByFormula — field IDs aren't supported in formulas.
    filterByFormula: `IS_AFTER({Start Date}, DATEADD(TODAY(), -1, 'days'))`,
    sort: [{ field: F_START_DATE, direction: 'asc' }],
  });

  const events = [];
  const skipped = { noTicket: 0, past: 0, noArtistLink: 0, noDate: 0 };

  for (const r of records) {
    const f = r.fields;
    const ticket = f[F_TICKET];
    const startDate = f[F_START_DATE];
    const artistLinks = f[F_ARTIST_LINK];

    if (isUnavailableTicket(ticket)) { skipped.noTicket++; continue; }
    if (!startDate) { skipped.noDate++; continue; }
    if (startDate < today) { skipped.past++; continue; }
    if (!artistLinks || artistLinks.length === 0) { skipped.noArtistLink++; continue; }

    const venueLinks = f[F_VENUE_LINK];
    events.push({
      recordId: r.id,
      artistLinkId: artistLinks[0], // first linked band record id
      venueLinkId: (venueLinks && venueLinks[0]) || null,
      showInfo: f[F_SHOW_INFO] || '',
      ticket,
      date: startDate,
      showtime: f[F_SHOWTIME] || '',
      artistFromLookup: firstLookupText(f[F_ARTIST_LOOK]),
      city: firstLookupText(f[F_CITY]),
      state: firstLookupText(f[F_STATE]),
      address: f[F_VENUE_ADDR] || '',
      platform: firstLookupText(f[F_PLATFORM]),
    });
  }

  return { events, skipped };
}

// ---- Resolve artist names + photo URLs via BANDS-SHOWS ----

async function pullBands(linkIds) {
  const unique = [...new Set(linkIds.filter(Boolean))];
  const chunks = [];
  for (let i = 0; i < unique.length; i += 80) chunks.push(unique.slice(i, i + 80));

  const byId = {};
  for (const chunk of chunks) {
    const formula = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
    const records = await airtableListAll(BANDS_TABLE, {
      fields: [F_NAME, F_WEB_IMG, F_BIO, F_TAGLINE, F_PROMO_VIDEO],
      filterByFormula: formula,
    });
    for (const r of records) {
      const name = r.fields[F_NAME];
      const atts = r.fields[F_WEB_IMG];
      byId[r.id] = {
        name,
        url: atts && atts[0] ? atts[0].url : null,
        bio: (r.fields[F_BIO] || '').trim(),
        tagline: (r.fields[F_TAGLINE] || '').trim(),
        promoVideo: (r.fields[F_PROMO_VIDEO] || '').trim(),
      };
    }
  }
  return byId;
}

// ---- Resolve venue names via VENUES (From CP) ----

async function pullVenues(linkIds) {
  const unique = [...new Set(linkIds.filter(Boolean))];
  if (unique.length === 0) return {};
  const chunks = [];
  for (let i = 0; i < unique.length; i += 80) chunks.push(unique.slice(i, i + 80));

  const byId = {};
  for (const chunk of chunks) {
    const formula = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
    const records = await airtableListAll(VENUES_TABLE, {
      fields: [F_VENUE_NAME],
      filterByFormula: formula,
    });
    for (const r of records) {
      const name = r.fields[F_VENUE_NAME];
      byId[r.id] = (name || '').trim();
    }
  }
  return byId;
}

// ---- Download photos ----

async function downloadPhotos(bandsById) {
  if (!existsSync(photosDir)) mkdirSync(photosDir, { recursive: true });

  const results = { downloaded: 0, unchanged: 0, failed: [], skipped: [] };
  const slugsSeen = new Set();

  for (const [id, band] of Object.entries(bandsById)) {
    if (!band.name) continue;
    const slug = slugify(band.name);
    if (slugsSeen.has(slug)) continue;
    slugsSeen.add(slug);

    if (!band.url) {
      results.skipped.push({ name: band.name, slug, reason: 'no Poster/Portrait attachment' });
      continue;
    }

    const target = path.join(photosDir, `${slug}.jpg`);
    try {
      const res = await fetch(band.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (existsSync(target) && statSync(target).size === buf.length) {
        results.unchanged++;
      } else if (DRY_RUN) {
        results.downloaded++;
      } else {
        writeFileSync(target, buf);
        results.downloaded++;
      }
    } catch (e) {
      results.failed.push({ name: band.name, slug, error: e.message });
    }
  }

  return results;
}

// ---- Build index.html ----

function renderIndexHtml(events) {
  const states = [...new Set(events.map(e => e.state).filter(Boolean))].sort();
  const count = events.length;

  const eventsJs = JSON.stringify(events.map(e => ({
    artist: e.artist,
    ticket: e.ticket,
    date: e.date,
    showtime: e.showtime,
    city: e.city,
    state: e.state,
    venue: e.venue,
    address: e.address,
    platform: e.platform,
    slug: e.slug,
    id: e.id,
  })), null, 2);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>YourConcertTix - Find Live Shows & Get Tickets</title>
<meta name="description" content="Find live concert tickets near you. Tribute shows, classic rock, country and more.">
<meta property="og:title" content="YourConcertTix - Find Live Shows & Get Tickets">
<meta property="og:description" content="Find live concert tickets near you.">
<meta property="og:type" content="website">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:wght@700;800&display=swap" rel="stylesheet">
<style>
:root {
  --primary: #1a1a2e;
  --accent: #e94560;
  --accent2: #f5a623;
  --bg: #0f0f23;
  --card-bg: #16213e;
  --card-border: #1a1a3e;
  --text: #e8e8f0;
  --text-muted: #8888aa;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
a { color: inherit; text-decoration: none; }
.fangenie-banner { background: linear-gradient(90deg, #1a1a3e, #0f0f23); padding: 8px 16px; text-align: center; border-bottom: 1px solid var(--card-border); }
.fangenie-banner a { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center; color: var(--text-muted); font-size: 13px; }
.fangenie-banner .fg-logo { height: 18px; vertical-align: middle; }
.fangenie-banner .fg-tagline { color: var(--text-muted); font-weight: 500; }
header { padding: 24px 20px; text-align: center; border-bottom: 1px solid var(--card-border); }
header h1 { font-family: 'Montserrat', sans-serif; font-size: 28px; letter-spacing: -0.5px; }
header h1 .accent { color: var(--accent); }
header .count { color: var(--text-muted); margin-top: 4px; font-size: 14px; }
.hero { text-align: center; padding: 48px 20px 24px; }
.hero h2 { font-family: 'Montserrat', sans-serif; font-size: 36px; margin-bottom: 8px; }
.hero p { color: var(--text-muted); }
.controls { max-width: 960px; margin: 20px auto; display: flex; flex-wrap: wrap; gap: 12px; padding: 0 20px; }
.controls input, .controls select, .controls button {
  font: inherit; padding: 12px 16px; border-radius: 10px; border: 1px solid var(--card-border);
  background: var(--card-bg); color: var(--text);
}
.controls input { flex: 1 1 260px; }
.controls select { flex: 0 1 200px; }
.controls button { background: var(--accent); color: white; border: 0; cursor: pointer; font-weight: 600; }
.controls button:hover { background: #ff5872; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; padding: 20px; max-width: 1400px; margin: 0 auto; }
.card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 14px; overflow: hidden; display: flex; flex-direction: column; transition: transform 0.15s ease, box-shadow 0.15s ease; }
.card:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
.card-photo-wrap { display: block; position: relative; aspect-ratio: 1/1; overflow: hidden; background: var(--primary); }
.card-photo-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
.card-photo-fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: 'Montserrat', sans-serif; font-weight: 700; color: white; text-align: center; padding: 16px; font-size: 18px; }
.card-body { padding: 16px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
.card-body h3 { font-family: 'Montserrat', sans-serif; font-size: 18px; }
.card-body .meta { color: var(--text-muted); font-size: 14px; }
.card-body .meta strong { color: var(--text); }
.card-body .cta { margin-top: auto; padding-top: 12px; display: flex; gap: 8px; }
.card-body .cta a { flex: 1; text-align: center; padding: 10px; border-radius: 8px; font-weight: 600; }
.card-body .cta a.get { background: var(--accent); color: white; }
.card-body .cta a.get:hover { background: #ff5872; }
.card-body .cta a.details { background: transparent; color: var(--text); border: 1px solid var(--card-border); }
.card-body .cta a.details:hover { border-color: var(--accent); color: var(--accent); }
.empty { text-align: center; color: var(--text-muted); padding: 60px 20px; }
footer { text-align: center; padding: 24px; color: var(--text-muted); font-size: 13px; border-top: 1px solid var(--card-border); margin-top: 40px; }
@media (max-width: 600px) {
  .hero h2 { font-size: 28px; }
  .grid { padding: 12px; gap: 12px; grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="fangenie-banner">
  <a href="https://fangenie.com" target="_blank">
    <span class="powered-by">Powered by</span>
    <img src="https://app.fangenie.com/assets/images/newlogo.png" alt="FanGenie" class="fg-logo">
    <span class="fg-tagline">The Ticketing Platform That Sells Your Tickets For You!</span>
  </a>
</div>
<header>
  <h1>Your<span class="accent">Concert</span>Tix</h1>
  <div class="count">${count} upcoming shows</div>
</header>
<div class="hero">
  <h2>Find Live Shows Near You</h2>
  <p>Tribute bands, classic rock, country &amp; more</p>
</div>
<div class="controls">
  <input id="q" type="search" placeholder="Search artist, venue, or city...">
  <select id="state">
    <option value="">All states</option>
    ${states.map(s => `<option value="${htmlesc(s)}">${htmlesc(s)}</option>`).join('\n    ')}
  </select>
  <button id="clear">Clear</button>
</div>
<div class="grid" id="grid"></div>
<footer>&copy; ${new Date().getFullYear()} YourConcertTix</footer>
<script>
const PHOTO_BASE = '/artist-photos/';
const events = ${eventsJs};

const palette = ['linear-gradient(135deg,#e94560,#f5a623)','linear-gradient(135deg,#6a11cb,#2575fc)','linear-gradient(135deg,#ff512f,#dd2476)','linear-gradient(135deg,#11998e,#38ef7d)','linear-gradient(135deg,#f12711,#f5af19)','linear-gradient(135deg,#8e2de2,#4a00e0)','linear-gradient(135deg,#ee0979,#ff6a00)','linear-gradient(135deg,#4568dc,#b06ab3)','linear-gradient(135deg,#c94b4b,#4b134f)','linear-gradient(135deg,#ff9966,#ff5e62)'];
function grad(s){let h=0;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return palette[h%palette.length];}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
const UNAVAILABLE=new Set(['n/a','na','not available','not applicable']);
function isUnavailable(t){return !t||UNAVAILABLE.has(String(t).trim().toLowerCase());}

function render(){
  const q=document.getElementById('q').value.toLowerCase();
  const st=document.getElementById('state').value;
  const filtered=events.filter(e=>{
    if(isUnavailable(e.ticket))return false;
    if(st&&e.state!==st)return false;
    if(!q)return true;
    return (e.artist+' '+e.city+' '+(e.venue||'')+' '+(e.address||'')+' '+e.state).toLowerCase().includes(q);
  });
  const grid=document.getElementById('grid');
  if(filtered.length===0){grid.innerHTML='<div class="empty">No shows match your filters.</div>';return;}
  grid.innerHTML=filtered.map(e=>{
    const dateStr=new Date(e.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
    const eventUrl='/events/'+esc(e.id)+'/';
    const hasTix=!isUnavailable(e.ticket);
    const cta=(hasTix?'<a class="get" href="'+esc(e.ticket)+'" target="_blank" rel="noopener">Get Tickets</a>':'')
      +'<a class="details" href="'+eventUrl+'">Details</a>';
    return \`<div class="card">
      <a class="card-photo-wrap" href="\${eventUrl}">
        <img src="\${PHOTO_BASE}\${esc(e.slug)}.jpg" alt="\${esc(e.artist)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div class="card-photo-fallback" style="display:none;background:\${grad(e.slug)}">\${esc(e.artist)}</div>
      </a>
      <div class="card-body">
        <h3><a href="\${eventUrl}">\${esc(e.artist)}</a></h3>
        \${e.venue?'<div class="meta"><strong>'+esc(e.venue)+'</strong></div>':''}
        <div class="meta"><strong>\${dateStr}</strong>\${e.showtime?' · '+esc(e.showtime):''}</div>
        <div class="meta">\${esc(e.city)}\${e.state?', '+esc(e.state):''}</div>
        <div class="cta">\${cta}</div>
      </div>
    </div>\`;
  }).join('');
}
document.getElementById('q').addEventListener('input',render);
document.getElementById('state').addEventListener('change',render);
document.getElementById('clear').addEventListener('click',()=>{document.getElementById('q').value='';document.getElementById('state').value='';render();});
render();
</script>
</body>
</html>
`;
}

// ---- Build a single event detail page ----

function renderEventHtml(e) {
  const dateStr = formatLongDate(e.date);
  const hasTix = hasValidTicket(e.ticket);
  const locality = [e.city, e.state].filter(Boolean).join(', ');
  const title = `${e.artist}${e.venue ? ' · ' + e.venue : ''} | YourConcertTix`;
  // Prefer the performer bio for the social description; fall back to event facts.
  const ogDesc = e.tagline
    ? `${e.tagline} — ${[dateStr, e.venue].filter(Boolean).join(', ')}`
    : (e.bio ? e.bio.replace(/\s+/g, ' ').slice(0, 160) : [dateStr, e.venue, locality].filter(Boolean).join(' — '));
  // Description body: the bio is the real prose; Show Info is just a date string, so ignore it.
  const descHtml = e.bio
    ? `<div class="desc clamp">${htmlesc(e.bio).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')}</div>
      <button class="read-more" type="button">Read more&hellip;</button>`
    : '';
  const taglineHtml = e.tagline ? `<p class="tagline">${htmlesc(e.tagline)}</p>` : '';
  const detailRows = [
    `<li><span>Date</span><strong>${htmlesc(dateStr)}</strong></li>`,
    e.showtime ? `<li><span>Time</span><strong>${htmlesc(e.showtime)}</strong></li>` : '',
    e.venue ? `<li><span>Venue</span><strong>${htmlesc(e.venue)}</strong></li>` : '',
    locality ? `<li><span>Location</span><strong>${htmlesc(locality)}</strong></li>` : '',
    e.address ? `<li><span>Address</span><strong>${htmlesc(e.address)}</strong></li>` : '',
  ].filter(Boolean).join('\n        ');
  const cta = hasTix
    ? `<a class="get-tickets" href="${htmlesc(e.ticket)}" target="_blank" rel="noopener">Get Tickets</a>`
    : `<span class="get-tickets disabled">Tickets coming soon</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${htmlesc(title)}</title>
<meta name="description" content="${htmlesc(ogDesc)}">
<meta property="og:title" content="${htmlesc(e.artist)}">
<meta property="og:description" content="${htmlesc(ogDesc)}">
<meta property="og:type" content="website">
<meta property="og:image" content="/artist-photos/${htmlesc(e.slug)}.jpg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:wght@700;800&display=swap" rel="stylesheet">
<style>
:root{--primary:#1a1a2e;--accent:#e94560;--bg:#0f0f23;--card-bg:#16213e;--card-border:#1a1a3e;--text:#e8e8f0;--text-muted:#8888aa;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);line-height:1.5;min-height:100vh;display:flex;flex-direction:column;}
a{color:inherit;text-decoration:none;}
.wrap{flex:1;width:100%;max-width:560px;margin:0 auto;padding:20px;display:flex;flex-direction:column;}
.back{color:var(--text-muted);font-size:14px;padding:8px 0;display:inline-block;}
.back:hover{color:var(--accent);}
.event-card{background:var(--card-bg);border:1px solid var(--card-border);border-radius:16px;overflow:hidden;margin-top:8px;}
.photo{position:relative;aspect-ratio:1/1;background:var(--primary);}
.photo img{width:100%;height:100%;object-fit:cover;display:block;}
.photo-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:'Montserrat',sans-serif;font-weight:700;color:#fff;text-align:center;padding:24px;font-size:26px;}
.content{padding:20px;}
.content h1{font-family:'Montserrat',sans-serif;font-size:26px;line-height:1.2;}
.content .tagline{color:var(--text-muted);font-size:15px;font-style:italic;margin-top:4px;}
.content .venue{color:var(--accent);font-weight:600;margin-top:6px;}
.desc{color:var(--text-muted);font-size:15px;margin-top:14px;}
.desc p+p{margin-top:10px;}
.desc.clamp{max-height:9em;overflow:hidden;position:relative;}
.desc.clamp::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2.6em;background:linear-gradient(transparent,var(--card-bg));}
.desc.clamp.expanded{max-height:none;}
.desc.clamp.expanded::after{display:none;}
.read-more{background:none;border:0;color:var(--accent);font:inherit;font-weight:600;cursor:pointer;padding:6px 0;margin-top:2px;}
.read-more:hover{text-decoration:underline;}
.details{list-style:none;margin:16px 0;border-top:1px solid var(--card-border);}
.details li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--card-border);font-size:14px;}
.details li span{color:var(--text-muted);}
.details li strong{color:var(--text);text-align:right;}
.get-tickets{display:block;background:var(--accent);color:#fff;text-align:center;padding:16px;border-radius:10px;font-weight:700;font-size:18px;font-family:'Montserrat',sans-serif;}
.get-tickets:hover{background:#ff5872;}
.get-tickets.disabled{background:var(--card-border);color:var(--text-muted);cursor:default;}
.promo-video{margin-top:14px;position:relative;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:#000;}
.promo-video iframe{position:absolute;inset:0;width:100%;height:100%;border:0;}
.watch-promo{display:block;margin-top:12px;background:var(--card-border);color:var(--text);text-align:center;padding:14px;border-radius:10px;font-weight:600;font-size:15px;}
.watch-promo:hover{color:var(--accent);}
footer{text-align:center;padding:20px;color:var(--text-muted);font-size:13px;}
footer a:hover{color:var(--accent);}
</style>
</head>
<body>
<main class="wrap">
  <a class="back" href="/">&larr; All shows</a>
  <article class="event-card">
    <div class="photo">
      <img src="/artist-photos/${htmlesc(e.slug)}.jpg" alt="${htmlesc(e.artist)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="photo-fallback" style="display:none;background:${gradFor(e.slug)}">${htmlesc(e.artist)}</div>
    </div>
    <div class="content">
      <h1>${htmlesc(e.artist)}</h1>
      ${taglineHtml}
      ${e.venue ? `<p class="venue">${htmlesc(e.venue)}</p>` : ''}
      ${descHtml}
      <ul class="details">
        ${detailRows}
      </ul>
      ${cta}
      ${promoVideoHtml(e.promoVideo)}
    </div>
  </article>
</main>
<footer><a href="/">YourConcertTix</a> &middot; Powered by <a href="https://fangenie.com" target="_blank" rel="noopener">FanGenie</a></footer>
<script>
(function(){
  var d=document.querySelector('.desc.clamp');
  var b=document.querySelector('.read-more');
  if(!d||!b)return;
  // If the bio already fits within the clamp, drop the link entirely.
  if(d.scrollHeight<=d.clientHeight+4){b.style.display='none';return;}
  b.addEventListener('click',function(){
    var open=d.classList.toggle('expanded');
    b.innerHTML=open?'Read less':'Read more&hellip;';
  });
})();
</script>
</body>
</html>
`;
}

function htmlesc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Extract the 11-char video id from common YouTube URL forms
// (watch?v=, youtu.be/, /embed/, /shorts/, /live/). Returns null if not recognized.
function youtubeId(url) {
  if (!url) return null;
  const m = String(url).match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

// Render the promo video block shown under the Get Tickets button.
// Embeds a responsive YouTube player when the URL is a recognizable YouTube
// link; otherwise falls back to a plain "Watch Promo Video" link button.
function promoVideoHtml(url) {
  if (!url) return '';
  const id = youtubeId(url);
  if (id) {
    return `<div class="promo-video">
        <iframe src="https://www.youtube-nocookie.com/embed/${id}" title="Promo video"
          loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
      </div>`;
  }
  return `<a class="watch-promo" href="${htmlesc(url)}" target="_blank" rel="noopener">&#9654; Watch Promo Video</a>`;
}

// ---- Main ----

async function main() {
  console.log('Pulling events...');
  const { events, skipped } = await pullEvents();
  console.log(`  ${events.length} events kept; skipped ${JSON.stringify(skipped)}`);

  const linkIds = events.map(e => e.artistLinkId).filter(Boolean);
  console.log(`Pulling ${new Set(linkIds).size} unique bands...`);
  const bandsById = await pullBands(linkIds);

  const venueLinkIds = events.map(e => e.venueLinkId).filter(Boolean);
  console.log(`Pulling ${new Set(venueLinkIds).size} unique venues...`);
  const venuesById = await pullVenues(venueLinkIds);

  // Attach canonical artist name + slug to each event. Prefer BANDS-SHOWS Name;
  // fall back to the lookup value if we couldn't resolve.
  for (const e of events) {
    const band = bandsById[e.artistLinkId];
    e.artist = (band && band.name) || e.artistFromLookup || '';
    e.slug = slugify(e.artist);
    e.venue = (e.venueLinkId && venuesById[e.venueLinkId]) || '';
    e.bio = (band && band.bio) || '';
    e.tagline = (band && band.tagline) || '';
    e.promoVideo = (band && band.promoVideo) || '';
  }
  const usableEvents = events.filter(e => e.artist);

  // Give each event a stable, unique URL id (artist slug + date, de-duplicated
  // when the same act plays the same day at more than one venue).
  const idsSeen = new Set();
  for (const e of usableEvents) {
    const base = `${e.slug}-${e.date}`;
    let id = base, n = 2;
    while (idsSeen.has(id)) id = `${base}-${n++}`;
    idsSeen.add(id);
    e.id = id;
  }

  console.log('Downloading photos...');
  const photoResults = await downloadPhotos(bandsById);
  console.log(`  downloaded=${photoResults.downloaded} unchanged=${photoResults.unchanged} failed=${photoResults.failed.length} skipped=${photoResults.skipped.length}`);
  for (const f of photoResults.failed) console.log(`  FAILED ${f.slug}: ${f.error}`);
  for (const s of photoResults.skipped) console.log(`  NO PHOTO ${s.slug} (${s.name})`);

  const html = renderIndexHtml(usableEvents);
  if (DRY_RUN) {
    console.log(`[DRY RUN] would write ${indexPath} (${html.length} bytes)`);
    console.log(`[DRY RUN] would write ${usableEvents.length} event pages under ${eventsDir}/`);
  } else {
    writeFileSync(indexPath, html);
    console.log(`Wrote ${indexPath} (${html.length} bytes)`);
    // Rebuild the events/ tree from scratch so pages for removed shows don't linger.
    rmSync(eventsDir, { recursive: true, force: true });
    for (const e of usableEvents) {
      const dir = path.join(eventsDir, e.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'index.html'), renderEventHtml(e));
    }
    console.log(`Wrote ${usableEvents.length} event pages under ${eventsDir}/`);
  }

  console.log('\nSummary:');
  console.log(`  Events:                      ${usableEvents.length}`);
  console.log(`  Photos downloaded:           ${photoResults.downloaded}`);
  console.log(`  Photos unchanged:            ${photoResults.unchanged}`);
  console.log(`  Photos missing (fallback):   ${photoResults.skipped.length}`);
  if (photoResults.skipped.length) {
    console.log('  Missing slugs (gradient fallback will render):');
    photoResults.skipped.forEach(s => console.log(`    - ${s.slug} (${s.name})`));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
