# Dilemma

A live dilemma game for events. A big screen shows a dilemma with two options; everyone votes
**1** or **2** from their phone (by scanning a QR code), then guesses what the majority chose,
then the results are revealed with animation and a breakdown by audience segment (age, sector…).

| URL | Who |
|---|---|
| `https://dilemma.yonatankatz.com/` | Phones (the QR code points here) |
| `https://dilemma.yonatankatz.com/admin` | Admin: dilemmas, timers, breakdown questions, new game, CSV export |
| `https://dilemma.yonatankatz.com/admin/host` | The big screen that runs the game (with music) |

Admin and host require login at `/login` (remembered on the device for a year): user `admin`, password from
the `ADMIN_PASSWORD` secret.

## Running a game

1. In `/admin`, add or edit dilemmas and set the vote timer and the breakdown questions.
2. Click **משחק חדש**, then open **מסך המשחק** on the projector and click **הפעלה במסך מלא**.
3. People scan the QR code and answer the breakdown questions once.
4. Advance with the big button, or Space / Enter / ← / PageDown (presentation clickers work).
   `M` mutes the music, `F` toggles fullscreen.

## Development

```bash
cd app
node --test                                   # unit tests
ADMIN_PASSWORD=secret node server.js          # http://127.0.0.1:3000
```

Every push to `main` deploys to Oracle Cloud via GitHub Actions. See [CLAUDE.md](CLAUDE.md) for the
architecture, the deployment and the infrastructure details.
