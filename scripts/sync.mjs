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

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
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

    if (!ticket || ticket === 'NOT APPLICABLE') { skipped.noTicket++; continue; }
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
      fields: [F_NAME, F_WEB_IMG],
      filterByFormula: formula,
    });
    for (const r of records) {
      const name = r.fields[F_NAME];
      const atts = r.fields[F_WEB_IMG];
      byId[r.id] = {
        name,
        url: atts && atts[0] ? atts[0].url : null,
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
.card-photo-wrap { position: relative; aspect-ratio: 1/1; overflow: hidden; background: var(--primary); }
.card-photo-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
.card-photo-fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: 'Montserrat', sans-serif; font-weight: 700; color: white; text-align: center; padding: 16px; font-size: 18px; }
.card-body { padding: 16px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
.card-body h3 { font-family: 'Montserrat', sans-serif; font-size: 18px; }
.card-body .meta { color: var(--text-muted); font-size: 14px; }
.card-body .meta strong { color: var(--text); }
.card-body .cta { margin-top: auto; padding-top: 12px; }
.card-body .cta a { display: block; background: var(--accent); color: white; text-align: center; padding: 10px; border-radius: 8px; font-weight: 600; }
.card-body .cta a:hover { background: #ff5872; }
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

function render(){
  const q=document.getElementById('q').value.toLowerCase();
  const st=document.getElementById('state').value;
  const filtered=events.filter(e=>{
    if(st&&e.state!==st)return false;
    if(!q)return true;
    return (e.artist+' '+e.city+' '+(e.venue||'')+' '+(e.address||'')+' '+e.state).toLowerCase().includes(q);
  });
  const grid=document.getElementById('grid');
  if(filtered.length===0){grid.innerHTML='<div class="empty">No shows match your filters.</div>';return;}
  grid.innerHTML=filtered.map(e=>{
    const dateStr=new Date(e.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
    return \`<div class="card">
      <div class="card-photo-wrap">
        <img src="\${PHOTO_BASE}\${esc(e.slug)}.jpg" alt="\${esc(e.artist)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div class="card-photo-fallback" style="display:none;background:\${grad(e.slug)}">\${esc(e.artist)}</div>
      </div>
      <div class="card-body">
        <h3>\${esc(e.artist)}</h3>
        \${e.venue?'<div class="meta"><strong>'+esc(e.venue)+'</strong></div>':''}
        <div class="meta"><strong>\${dateStr}</strong>\${e.showtime?' · '+esc(e.showtime):''}</div>
        <div class="meta">\${esc(e.city)}\${e.state?', '+esc(e.state):''}</div>
        <div class="cta"><a href="\${esc(e.ticket)}" target="_blank" rel="noopener">Get Tickets</a></div>
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

function htmlesc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  }
  const usableEvents = events.filter(e => e.artist);

  console.log('Downloading photos...');
  const photoResults = await downloadPhotos(bandsById);
  console.log(`  downloaded=${photoResults.downloaded} unchanged=${photoResults.unchanged} failed=${photoResults.failed.length} skipped=${photoResults.skipped.length}`);
  for (const f of photoResults.failed) console.log(`  FAILED ${f.slug}: ${f.error}`);
  for (const s of photoResults.skipped) console.log(`  NO PHOTO ${s.slug} (${s.name})`);

  const html = renderIndexHtml(usableEvents);
  if (DRY_RUN) {
    console.log(`[DRY RUN] would write ${indexPath} (${html.length} bytes)`);
  } else {
    writeFileSync(indexPath, html);
    console.log(`Wrote ${indexPath} (${html.length} bytes)`);
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
