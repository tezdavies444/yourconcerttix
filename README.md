# yourconcerttix

Static site for [yourconcerttix.com](https://yourconcerttix.com), deployed via Vercel from this repo.

## How it works

- **`index.html`** — the entire site, single-file. Embeds the event list as a JS array, plus inline CSS and a search/filter UI.
- **`artist-photos/`** — one `.jpg` per artist slug. Missing photos fall back to a gradient with the artist name.
- **`scripts/sync.mjs`** — pulls upcoming events from Airtable (base `appEy2dr1ecmzbEpb`), downloads artist photos, and rebuilds `index.html` from scratch.
- **`.github/workflows/sync.yml`** — runs `scripts/sync.mjs` every 4 hours (and on manual dispatch) and commits any changes. Vercel auto-deploys on each commit.

## Running the sync locally

```bash
export AIRTABLE_PAT=patXXXXXXXXXXXX
node scripts/sync.mjs            # write changes
node scripts/sync.mjs --dry-run  # just report what would change
```

## Secrets

The GitHub Action needs `AIRTABLE_PAT` set as a repo secret (Settings → Secrets and variables → Actions). The token needs `data.records:read` scope on base `appEy2dr1ecmzbEpb`.
