# Dilemma — live voting game

A big screen (projector) runs a game of dilemmas; the audience votes **1** or **2** from their phones,
then guesses what the majority chose, then sees animated results with a demographic breakdown.
All UI text is Hebrew, RTL.

## Map

| Path | Role |
|---|---|
| `app/server.js` | HTTP routing, validation, admin auth, CSV export. Zero npm dependencies. |
| `app/lib/game.js` | The game **state machine** (pure logic, injectable clock). All rules live here. |
| `app/lib/sse.js` | Server-Sent Events hub: per-client views, coalesced pushes. |
| `app/lib/store.js` | JSON-file persistence (atomic tmp+rename, debounced writes). |
| `app/lib/auth.js` | Admin login: signed session tokens, Basic-auth check, failed-login limiter. |
| `app/lib/defaults.js` | Seed dilemmas + default settings (used only when the data dir is empty). |
| `app/public/play.html`, `js/play.js` | Phone screen (`/`, the QR target). |
| `app/public/host.html`, `js/host.js` | Game-runner big screen (`/admin/host`). |
| `app/public/js/sound.js` | Procedural music + SFX (Web Audio, no audio files). Host screen only. |
| `app/public/admin.html`, `js/admin.js` | Admin: dilemmas CRUD, settings, new/end game, CSV (`/admin`). |
| `app/public/login.html`, `js/login.js` | Admin login page (`/login`, "remember me" checkbox). |
| `app/public/css/theme.css` | Shared design tokens (colors, fonts, buttons, keyframes). |
| `app/public/vendor/qrcode.js` | Vendored qrcode-generator (MIT). Bundled so events never depend on a CDN. |
| `deploy/setup.sh` | Idempotent server install, run by CI on every deploy. |
| `infra/provision.sh` | One-time OCI provisioning of the Always Free VM (OCI CLI). |
| `.github/workflows/deploy.yml` | Push to `main` → test → upload → `setup.sh` → smoke test. |

## Game model

Phases: `idle → lobby → vote → guess → results → (vote next | end)`.

- `newGame` snapshots the **active** dilemmas and the settings, so admin edits never disturb a running game.
- Phones join once per game with a **profile** (answers to the configured segment questions, e.g. age, sector);
  the profile drives the results **breakdown**. `play.js` remembers it in `localStorage` and auto-joins the next
  game; a change in segment ids/options invalidates it and the phone asks again.
- One vote per participant per dilemma, enforced server-side. Votes carry the dilemma `index` to reject stale taps.
- The vote countdown is server-authoritative: `tick()` auto-advances to `guess` after `voteSeconds` plus
  `VOTE_GRACE_MS`. Clients receive `remainingMs` (never absolute timestamps), so client clocks don't matter.
- Host `next` sends `expected: {phase, index}`; a mismatch returns `stale`. This makes double clicks and two open
  host screens safe.
- `publicView` (phones) never includes dilemma texts or other people's votes. `hostView` adds results only in
  `results`/`end`.
- `onChange('hosts')` vs `onChange('all')`: only phase changes are pushed to phones. Votes and joins go to hosts
  only, so a burst of votes doesn't fan out to every phone.
- Starting a new game archives the previous one to `$DATA_DIR/games/<id>.json`.

Data on disk (`DATA_DIR`, default `app/data/`, prod `/var/lib/dilemma`): `dilemmas.json`, `settings.json`,
`game.json` (live state, survives restarts), `games/*.json`, `auth-secret.json` (session signing key).
Deploys never touch this directory. `defaults.js` seeds only an empty one, so editing seeds does not change
production: add dilemmas through `/admin` or `PUT /admin/api/dilemmas`.

## Conventions

- **Zero dependencies** in `app/`: Node built-ins only, vendored browser libs. Target **Node 18**
  (the server runs Ubuntu 24.04's apt `nodejs`; CI tests on 18 too).
- Hebrew copy addresses the audience in plural (`הצביעו`, `נחשו`) and writes options in first-person future
  (`אגיד`, `אחזיר`) so text stays gender-neutral.
- Mixed-direction strings such as `18–30` or `51+` need `unicode-bidi: plaintext` (plus an explicit
  `text-align`) or they render reversed.
- Host screen sizing uses `--u` (≈1% of the short side of a 16:9 viewport). Keep content inside the
  safe area: chips occupy the top ~7u, the control bar the bottom ~11u.
- Real dilemmas are long (up to ~400 chars with line breaks, options up to ~120 chars). Host text is never
  a fixed size: each screen object exposes `fit()`, which uses `fitFont()` (binary search on font-size) so
  text fills its box without overflowing. Blocks sized as a unit (`.options`, `.bars`, `.summary`) use `em`
  inside, so scaling the container font scales everything. `fit()` runs on build, on resize, and when web
  fonts finish loading (`document.fonts` `loadingdone`; `fonts.ready` alone resolves too early).
  Measure with `offsetHeight`/`offsetTop`, not `scrollHeight`: entry animations (`translateY`) inflate
  `scrollHeight`. Results are fitted in the split (breakdown open) layout up front, so nothing jumps.
  Dilemma text keeps its line breaks (`white-space: pre-line`).
- Palette: wine/bordeaux backgrounds, gold gradients, cream text. Fonts: Suez One (display) and Assistant
  (body). Option 1 is red, option 2 is gold, everywhere.
- Every API POST/PUT requires `Content-Type: application/json`. This is also the CSRF guard for the
  cookie-authenticated admin.
- `/admin*` (admin + host + their APIs and SSE) requires login: user `admin`, password `ADMIN_PASSWORD`.
  `/login` sets the `adm` cookie, an HMAC-signed expiry (1 year with "remember me", else a browser-session
  cookie capped at 12h). The key mixes `auth-secret.json` with the credentials, so restarts and deploys keep
  people logged in and changing `ADMIN_PASSWORD` logs everyone out. Unauthenticated pages redirect to
  `/login?next=`; APIs return 401 JSON. A `Authorization: Basic` header is still accepted, for scripts and
  for puppeteer (`page.setExtraHTTPHeaders`; `page.authenticate` no longer works, there is no 401 challenge).
  Failed logins are limited to 10 per IP per 10 minutes.

## Verify a change

1. `cd app && node --test` covers the state machine. Add a test in `app/test/` for any rule change in `game.js`.
2. For UI changes, run locally and look at the screens:
   `ADMIN_PASSWORD=secret DATA_DIR=<scratch dir> PORT=3999 node app/server.js`.
   An end-to-end pass drives a host page plus several phone contexts with `puppeteer-core` against the
   installed Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe`) and screenshots each phase at
   1600×900. Install puppeteer in a scratch directory, never in `app/`. A short `voteSeconds` in the scratch
   `settings.json` makes the timeout path quick to exercise.
   For text layout, run every real dilemma (`GET /admin/api/dilemmas` from prod) through vote/guess/results
   and the end screen at 1920×1080, 1366×768, 1280×720, 1024×768 and 1280×800, and check in-page for text
   that is offscreen, clipped, overlapping another text block or the HUD, or below ~15px. Use one browser
   per viewport: background tabs do not run `requestAnimationFrame`, so their refits never happen.

## Deployment

- **CI/CD**: every push to `main` runs `.github/workflows/deploy.yml`. It tars `app/` + `deploy/`, scps it to
  the VM, writes `/etc/dilemma.env` from secrets, and runs `deploy/setup.sh` as root. `setup.sh` must stay
  **idempotent**: it installs Node, Caddy and iptables-persistent if missing, then rewrites the systemd unit
  and the Caddyfile on every run.
- GitHub **secrets**: `OCI_HOST` (VM public IP), `OCI_SSH_PRIVATE_KEY`, `ADMIN_PASSWORD`.
  **Variable**: `CUSTOM_DOMAIN` (`dilemma.yonatankatz.com`). Manage them with `gh secret` / `gh variable`.
- **Server**: Oracle Cloud, region `il-jerusalem-1`, `VM.Standard.A1.Flex` (ARM, 2 OCPU / 12 GB, Always
  Free), Ubuntu 24.04, public IP `129.159.145.89`. Node listens on `127.0.0.1:3000` as systemd unit
  `dilemma`; Caddy terminates TLS (Let's Encrypt) for `129-159-145-89.sslip.io` and `CUSTOM_DOMAIN`, and
  serves plain HTTP on the raw IP.
- **Gotchas**:
  - Oracle's Ubuntu images REJECT all inbound traffic except 22 in iptables, independent of the VCN
    security list. `setup.sh` opens 80/443 and persists the rules.
  - Keep `encode gzip` out of the Caddyfile: it can buffer the SSE stream.
- **SSH**: `ssh -i ~/.ssh/dilemma_oci ubuntu@129.159.145.89`.
  Logs: `journalctl -u dilemma -f`, `journalctl -u caddy`.
- **OCI CLI**: installed in the venv `C:\Users\katzy\.oci-cli-venv\Scripts\oci`, config `~/.oci/config`
  (API key `~/.oci/oci_api_key.pem`). Set `OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING=True` on Windows.
- **Infra changes**: re-running `infra/provision.sh` is safe; it reuses resources by display name. Use
  **Always Free** resources only (A1.Flex up to 4 OCPU/24 GB total, E2.1.Micro, ≤200 GB block storage).
  Check before adding anything billable.
- **DNS**: `yonatankatz.com` is on GoDaddy. `dilemma` is an A record pointing to the VM IP. If the IP
  changes, update that record and the `OCI_HOST` secret.
