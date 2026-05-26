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

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
if (!AIRTABLE_PAT) {
  console.error('ERROR: AIRTABLE_PAT env var is required');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

const BASE_ID      = 'appEy2dr1ecmzbEpb';
const EVENTS_TABLE = 'tblu9UIlpXChPdvOB';
const BANDS_TABLE  = 'tblOsZIDmFHt01rJn';
const VENUES_TABLE = 'tblno252DKqUf55As';

// Event field IDs
const F_SHOW_INFO  = 'fld2ky88mk1cTECxX';
const F_TICKET     = 'fldjR0adsgFVDbzSe';
const F_START_DATE = 'fld0VBiok50LzeKRZ';
const F_ARTIST_LINK= 'fldRZ99cnPxHyPL18'; // multipleRecordLinks → BANDS-SHOWS
const F_ARTIST_LOOK= 'fldVCAKyZlT8fYcbO'; // lookup → band Name
const F_SHOWTIME   = 'fldpARJ5yjNnIhsTN';
const F_CITY       = 'fldQxfhltNZfraKRq'; // lookup → text
const F_STATE      = 'fldTn8sdmJ4UbPX5x'; // lookup → singleSelect {name}
const F_VENUE_LINK = 'fldWNKIABxBYUyX0A'; // multipleRecordLinks → VENUES (From CP)
const F_VENUE_ADDR = 'fldv6kMv0wmhrpLql'; // formula → full address string
const F_PLATFORM   = 'fldczQJUGFvhg2NrC'; // lookup → multipleSelects {name}

// Bands field IDs
const F_BAND_NAME  = 'fldLzk7pDCwNsBQob';
const F_BAND_IMG   = 'fldp0jJuQ0uXf5wQl'; // New Web: 865x340

// Venues field IDs
const F_VENUE_NAME = 'fldNt6WjlSP0tivQ2'; // primary "Name"

const SLUG_FIXES = {
  "Britain's Finest": 'britains-finest',
  "Britain’s Finest": 'britains-finest',
  'THE MOODY BLUES TRIBUTE - GO NOW!': 'the-moody-blues-tribute--go-now',
  'Yachtzilla - The Monsters of Soft Rock': 'yachtzilla--the-monsters-of-soft-rock',
};

function slugify(name) {
  if (!name) return '';
  if (SLUG_FIXES[name]) return SLUG_FIXES[name];
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const repoRoot  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

// Lookup fields return arrays. Text lookups → ["string", ...]; select lookups → [{name, ...}, ...].
function firstLookupString(val) {
  if (val == null) return '';
  if (Array.isArray(val)) {
    for (const v of val) {
      if (v == null) continue;
      if (typeof v === 'string') { const t = v.trim(); if (t) return t; }
      if (Array.isArray(v)) { const inner = firstLookupString(v); if (inner) return inner; }
      else if (typeof v === 'object' && typeof v.name === 'string') return v.name.trim();
    }
  } else if (typeof val === 'string') return val.trim();
  else if (val && typeof val === 'object' && typeof val.name === 'string') return val.name.trim();
  return '';
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
  const skipped = { badTicket: 0, past: 0, noArtistLink: 0, noDate: 0 };

  for (const r of records) {
    const f = r.fields;
    const ticket = f[F_TICKET];
    const startDate = f[F_START_DATE];
    const artistLinks = f[F_ARTIST_LINK];

    if (!ticket) { skipped.badTicket++; continue; }
    const tt = String(ticket).trim().toUpperCase();
    if (tt === 'NOT APPLICABLE' || tt === 'N/A' || tt === 'NONE') { skipped.badTicket++; continue; }
    if (!startDate) { skipped.noDate++; continue; }
    if (String(startDate) < today) { skipped.past++; continue; }
    if (!artistLinks || artistLinks.length === 0) { skipped.noArtistLink++; continue; }

    const venueLinks = f[F_VENUE_LINK];
    events.push({
      recordId: r.id,
      artistLinkId: artistLinks[0],
      venueLinkId: (venueLinks && venueLinks[0]) || null,
      showInfo: f[F_SHOW_INFO] || '',
      ticket,
      date: startDate,
      showtime: f[F_SHOWTIME] || '',
      artistFromLookup: firstLookupString(f[F_ARTIST_LOOK]),
      city: firstLookupString(f[F_CITY]),
      state: firstLookupString(f[F_STATE]),
      address: f[F_VENUE_ADDR] || '',
      platform: firstLookupString(f[F_PLATFORM]),
    });
  }

  return { events, skipped };
}

// ---- Resolve artist names + photo URLs ----

async function pullBands(linkIds) {
  const unique = [...new Set(linkIds.filter(Boolean))];
  if (unique.length === 0) return {};
  const chunks = [];
  for (let i = 0; i < unique.length; i += 80) chunks.push(unique.slice(i, i + 80));

  const byId = {};
  for (const chunk of chunks) {
    const formula = `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`;
    const records = await airtableListAll(BANDS_TABLE, {
      fields: [F_BAND_NAME, F_BAND_IMG],
      filterByFormula: formula,
    });
    for (const r of records) {
      const name = r.fields[F_BAND_NAME];
      const atts = r.fields[F_BAND_IMG];
      byId[r.id] = { name, url: atts && atts[0] ? atts[0].url : null };
    }
  }
  return byId;
}

// ---- Resolve venue names ----

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
      byId[r.id] = (r.fields[F_VENUE_NAME] || '').trim();
    }
  }
  return byId;
}

// ---- Download photos ----

async function downloadPhotos(bandsById) {
  if (!existsSync(photosDir)) mkdirSync(photosDir, { recursive: true });

  const results = { downloaded: 0, unchanged: 0, failed: [], skipped: [] };
  const slugsSeen = new Set();

  for (const band of Object.values(bandsById)) {
    if (!band.name) continue;
    const slug = slugify(band.name);
    if (slugsSeen.has(slug)) continue;
    slugsSeen.add(slug);

    if (!band.url) {
      results.skipped.push({ name: band.name, slug, reason: 'no 865x340 attachment' });
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

// ---- HTML helpers ----

function htmlesc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  }[c]));
}

// ---- Build index.html ----

function renderIndexHtml(events) {
  const states = [...new Set(events.map(e => e.state).filter(Boolean))].sort();
  const compact = events.map(e => ({
    a:  e.artist,
    t:  e.ticket,
    d:  e.date,
    si: e.showInfo,
    st: e.showtime,
    c:  e.city,
    s:  e.state,
    vn: e.venue,
    l:  e.address,
    p:  e.platform,
    sl: e.slug,
  }));
  const eventsJs = JSON.stringify(compact, null, 0).replace(/},\{/g, '},\n{');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>YourConcertTix - Find Live Shows &amp; Get Tickets</title>
<meta name="description" content="Find live concerts, tribute shows, and entertainment events near you. Get tickets to the best live music experiences.">
<meta property="og:title" content="YourConcertTix - Find Live Shows & Get Tickets">
<meta property="og:description" content="Find live concerts, tribute shows, and entertainment events near you.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://yourconcerttix.com">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Montserrat:wght@600;700;800;900&display=swap" rel="stylesheet">
<style>
:root{--primary:#1a1a2e;--accent:#e94560;--accent2:#f5a623;--bg:#0f0f23;--card-bg:#16213e;--card-border:#1a1a3e;--text:#e8e8f0;--text-muted:#8888aa}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.6}
a{color:inherit;text-decoration:none}
.fangenie-banner{background:linear-gradient(135deg,#0a0a1a 0%,#1a1a3e 100%);border-bottom:1px solid rgba(233,69,96,0.3);padding:10px 20px;text-align:center}
.fangenie-banner a{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center}
.powered-by{font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px}
.fg-logo{height:28px;vertical-align:middle}
.fg-tagline{font-size:13px;color:var(--accent2);font-weight:500}
header{background:linear-gradient(135deg,var(--primary) 0%,#0f0f23 100%);padding:20px 40px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--card-border);flex-wrap:wrap;gap:10px}
.logo{font-family:'Montserrat',sans-serif;font-size:28px;font-weight:800;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.event-count{background:rgba(233,69,96,0.15);color:var(--accent);padding:6px 16px;border-radius:20px;font-size:14px;font-weight:600}
.hero{text-align:center;padding:50px 20px 30px;background:radial-gradient(ellipse at center,rgba(233,69,96,0.08) 0%,transparent 70%)}
.hero h1{font-family:'Montserrat',sans-serif;font-size:clamp(28px,5vw,48px);font-weight:900;margin-bottom:10px;background:linear-gradient(135deg,#fff,#ccc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero p{color:var(--text-muted);font-size:18px;max-width:600px;margin:0 auto}
.controls{max-width:1200px;margin:0 auto 30px;padding:0 20px;display:flex;gap:12px;flex-wrap:wrap;justify-content:center}
.controls input,.controls select{background:var(--card-bg);border:1px solid var(--card-border);color:var(--text);padding:12px 18px;border-radius:10px;font-size:15px;font-family:'Inter',sans-serif;outline:none;transition:border-color 0.3s}
.controls input:focus,.controls select:focus{border-color:var(--accent)}
.controls input{flex:1;min-width:220px;max-width:400px}
.controls select{min-width:160px}
.btn-clear{background:rgba(233,69,96,0.15);color:var(--accent);border:1px solid rgba(233,69,96,0.3);padding:12px 24px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;transition:all 0.3s}
.btn-clear:hover{background:var(--accent);color:#fff}
.grid{max-width:1200px;margin:0 auto;padding:0 20px 40px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px}
.card{background:var(--card-bg);border:1px solid var(--card-border);border-radius:16px;overflow:hidden;transition:transform 0.3s,box-shadow 0.3s;display:flex;flex-direction:column}
.card:hover{transform:translateY(-4px);box-shadow:0 12px 40px rgba(233,69,96,0.15)}
.card-photo-wrap{aspect-ratio:16/9;overflow:hidden;position:relative;background:var(--primary)}
.card-photo-wrap img{width:100%;height:100%;object-fit:cover}
.card-photo-fallback{display:none;width:100%;height:100%;position:absolute;top:0;left:0;align-items:center;justify-content:center;font-family:'Montserrat',sans-serif;font-weight:700;font-size:20px;color:rgba(255,255,255,0.95);text-shadow:0 2px 8px rgba(0,0,0,0.5);text-align:center;padding:20px}
.card-body{padding:18px;flex:1}
.card-artist{font-family:'Montserrat',sans-serif;font-size:18px;font-weight:700;margin-bottom:8px;line-height:1.3}
.card-venue{font-family:'Inter',sans-serif;font-size:14px;font-weight:600;color:var(--accent2);margin-bottom:8px}
.card-detail{font-size:13px;color:var(--text-muted);margin-bottom:4px;display:flex;align-items:flex-start;gap:6px}
.card-detail .icon{flex-shrink:0;width:16px;text-align:center}
.card-btn{display:block;margin:14px 18px 18px;padding:12px;text-align:center;background:linear-gradient(135deg,var(--accent),#c23152);color:#fff;border-radius:10px;font-weight:600;font-size:14px;transition:opacity 0.3s;letter-spacing:0.5px}
.card-btn:hover{opacity:0.85}
.no-results{text-align:center;padding:60px 20px;color:var(--text-muted);font-size:18px;grid-column:1/-1}
footer{text-align:center;padding:30px;border-top:1px solid var(--card-border);color:var(--text-muted);font-size:13px}
@media(max-width:640px){header{padding:15px 20px}.logo{font-size:22px}.hero{padding:30px 15px 20px}.hero h1{font-size:26px}.grid{grid-template-columns:1fr;padding:0 15px 30px}}
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
<div class="logo">YourConcertTix</div>
<div class="event-count" id="eventCount">${events.length} Upcoming Events</div>
</header>
<section class="hero">
<h1>Find Live Shows Near You</h1>
<p>Discover the best tribute bands and live entertainment events. Get your tickets today!</p>
</section>
<div class="controls">
<input type="text" id="search" placeholder="Search artists, venues, cities..." autocomplete="off">
<select id="stateFilter">
<option value="">All States</option>
${states.map(s => `<option value="${htmlesc(s)}">${htmlesc(s)}</option>`).join('\n')}
</select>
<button class="btn-clear" id="clearBtn">Clear Filters</button>
</div>
<div class="grid" id="grid"></div>
<footer>&copy; ${new Date().getFullYear()} YourConcertTix. All rights reserved.</footer>
<script>
const PHOTO_BASE='/artist-photos/';
const events=${eventsJs};
const GRADIENTS=['linear-gradient(135deg,#667eea,#764ba2)','linear-gradient(135deg,#f093fb,#f5576c)','linear-gradient(135deg,#4facfe,#00f2fe)','linear-gradient(135deg,#43e97b,#38f9d7)','linear-gradient(135deg,#fa709a,#fee140)','linear-gradient(135deg,#30cfd0,#330867)','linear-gradient(135deg,#a8edea,#fed6e3)','linear-gradient(135deg,#ff9a9e,#fecfef)','linear-gradient(135deg,#fbc2eb,#a6c1ee)','linear-gradient(135deg,#84fab0,#8fd3f4)'];
function hashCode(str){let h=0;for(let i=0;i<str.length;i++){h=((h<<5)-h)+str.charCodeAt(i);h|=0}return Math.abs(h)}
function gradientFor(artist){return GRADIENTS[hashCode(artist)%GRADIENTS.length]}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function fmtDate(si){return si||''}
function card(e){
  const grad=gradientFor(e.a);
  const locLine=[e.c,e.s].filter(Boolean).join(', ');
  const plat=e.p?'<div class="card-detail"><span class="icon">🎟️</span><span>'+esc(e.p)+'</span></div>':'';
  return '<div class="card">'+
    '<div class="card-photo-wrap">'+
      '<img src="'+PHOTO_BASE+esc(e.sl)+'.jpg" alt="'+esc(e.a)+'" loading="lazy" onerror="this.style.display=\\'none\\';this.nextElementSibling.style.display=\\'flex\\'">'+
      '<div class="card-photo-fallback" style="background:'+grad+'">'+esc(e.a)+'</div>'+
    '</div>'+
    '<div class="card-body">'+
      '<div class="card-artist">'+esc(e.a)+'</div>'+
      (e.vn?'<div class="card-venue">'+esc(e.vn)+'</div>':'')+
      '<div class="card-detail"><span class="icon">📅</span><span>'+esc(fmtDate(e.si))+(e.st?' · '+esc(e.st):'')+'</span></div>'+
      (locLine?'<div class="card-detail"><span class="icon">📍</span><span>'+esc(locLine)+'</span></div>':'')+
      plat+
    '</div>'+
    '<a class="card-btn" href="'+esc(e.t)+'" target="_blank" rel="noopener">Get Tickets</a>'+
  '</div>';
}
function render(){
  const q=(document.getElementById('search').value||'').toLowerCase().trim();
  const st=document.getElementById('stateFilter').value;
  const filtered=events.filter(e=>{
    if(st&&e.s!==st)return false;
    if(!q)return true;
    return (e.a&&e.a.toLowerCase().includes(q))||(e.c&&e.c.toLowerCase().includes(q))||(e.vn&&e.vn.toLowerCase().includes(q))||(e.l&&e.l.toLowerCase().includes(q));
  });
  const grid=document.getElementById('grid');
  if(filtered.length===0){grid.innerHTML='<div class="no-results">No events match your filters.</div>';return}
  grid.innerHTML=filtered.map(card).join('');
}
document.getElementById('search').addEventListener('input',render);
document.getElementById('stateFilter').addEventListener('change',render);
document.getElementById('clearBtn').addEventListener('click',()=>{document.getElementById('search').value='';document.getElementById('stateFilter').value='';render()});
render();
</script>
</body>
</html>
`;
}

// ---- Main ----

async function main() {
  console.log('Pulling events from Airtable...');
  const { events, skipped } = await pullEvents();
  console.log(`  ${events.length} events kept; skipped ${JSON.stringify(skipped)}`);

  const linkIds = events.map(e => e.artistLinkId).filter(Boolean);
  console.log(`Pulling ${new Set(linkIds).size} unique bands...`);
  const bandsById = await pullBands(linkIds);

  const venueLinkIds = events.map(e => e.venueLinkId).filter(Boolean);
  console.log(`Pulling ${new Set(venueLinkIds).size} unique venues...`);
  const venuesById = await pullVenues(venueLinkIds);

  // Attach canonical names + slug to each event.
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
  console.log(`  Unique venues:               ${new Set(usableEvents.map(e => e.venue).filter(Boolean)).size}`);
  console.log(`  Photos downloaded:           ${photoResults.downloaded}`);
  console.log(`  Photos unchanged:            ${photoResults.unchanged}`);
  console.log(`  Photos missing (fallback):   ${photoResults.skipped.length}`);
  console.log(`  Date range:                  ${usableEvents[0]?.date} → ${usableEvents.at(-1)?.date}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
