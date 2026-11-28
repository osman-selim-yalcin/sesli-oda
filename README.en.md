# Sesli Oda

[Türkçe](README.md)

A voice chat app with many rooms, synchronized YouTube watching and listening, and games. Each room holds at most 10 people.
When two rooms merge, the limit is 20 people (10 from each room). The site admin does not count toward this limit and can also enter a full room.

**Live:** https://agalar.app

## Features

- Accounts: sign up and sign in with a username and password, with an optional profile picture. The sign-in stays
  active in the browser. The same name cannot be taken twice. If someone signs in with the same account from a second place, the first session
  leaves the room. The account password is changed from the account window.
- Rooms: after sign-in, the room list opens. The address is `/oda/<oda>` (games are at `/oda/<oda>/oyunlar/...`, radio at
  `/oda/<oda>/radyo`). One account can be in only one room at a time. See "Rooms and roles" below for details.
- Voice chat (WebRTC, Opus), with a noise gate and a volume threshold setting. If the microphone cannot start (permission off, no device,
  another app is using it), a note shows the reason. With "Try again", or when the device comes back, the microphone reconnects
  without leaving the room.
- YouTube plays for everyone at the same time, with search inside the site and a play history
- Text chat and an emoji picker
- Sound effects. Everyone can also upload their own effect.
- Screen sharing (in Chrome/Edge, with tab audio)
- Games (a tab in the top bar; music and voice chat continue during a game): tier list (text or picture cards
  on a shared board), time guess and time race, dino run, word, memory match, number puzzle,
  target number, secret rule, logic grid, Push XOX, typing duel, slide puzzle, speed reading. Multiplayer games
  start from the "Create lobby" lobby (everyone in the room and bots can be in the lobby; word is limited to 6, dino run to 7, and number puzzle and Push XOX to
  2 players). Score tables are shared across all rooms.
- The **Board Games** section has Orbit Siege, Archipelago, and Seven Doors. In Orbit Siege, each fleet has
  one Echo, one Dive, and one Tractor. These are the space-themed counterparts of the Hive expansion pieces Mosquito, Ladybug, and Pillbug.
  [Hive rule book](https://hivegame.com/download/rules.pdf)
- Archipelago is a game about building piers, lighthouses, and routes on a long island with 24 land tiles: four goods (timber, stone, fish, salt),
  a single tide die, a storm that drifts on its own at the end of each turn, and 3:1 trades with the bank. The first to 8 points wins.
  Seven Doors is played up to level 10, with original dungeon encounters, equipment, potions, and offers of help.
  Both are for 2–4 players. If the server that Dev connects to does not support the game yet, it can be played
  against a bot or on the same device from the game card.
- Audio recording: with or without music, or only the speech, saved as MP3 or WebM. The recording is saved only to the recorder's
  computer. It does not go to the server.

## Running on your computer

You need Node.js 20 or newer. On `localhost`, the microphone works without HTTPS. To try with more than one person,
open the same address in several tabs (or in separate browser profiles).

**Test server for trying changes** (it does not connect to Supabase, does not read `.env`, and keeps everything in memory; details
below in "Tests and the test server"):

```bash
npm install
PORT=4100 node -r ./test/preload.js server.js     # http://localhost:4100
```

**Real server:** `npm start` (default http://localhost:3030) reads the `.env` file. If `.env` has Supabase
keys, this server connects to the **live database**: it works on the accounts, rooms, and records of the live site.
It is only for running the code that is already published. Do not create test accounts, test rooms, or test
data here, and do not test a branch's changes with it. Before the multi-room SQL files are applied to the live database, the new code
does not start with this server (the log shows `SUNUCU AÇILMIYOR` (SERVER WILL NOT START); see "Going live").

## Project structure

There is no build step. The files in `public/` are served as they are.

| File | What it does |
| --- | --- |
| `server.js` | Express + Socket.IO: live room state, signaling, chat, YouTube search, games |
| `rooms.js` | Room records, room requests, members of password-protected rooms, theme list (`THEMES`) |
| `merge.js` | Room merging (in memory only) |
| `games/` | Server side of the typing, target number, secret rule, and logic grid games |
| `store.js` | Persistent storage in Supabase (history, effects, tier lists, score tables) |
| `accounts.js` | Accounts, sessions, profile pictures, site admins (`ADMINS`) |
| `clientip.js` | The visitor's real address (for attempt limits; `CLIENT_IP_HEADER`) |
| `deploy/` | Publishing on our own server: `Dockerfile`, `compose.yml`, `yayin.sh`, firewall `sesli-oda-ag.sh`, the dev environment (`dev/Caddyfile`, `dev-yayin.sh`), systemd units (see "Contributing and publishing", "Development flow") |
| `public/dev.js` | The DEV label at the top of dev.agalar.app (does nothing on the live site) |
| `.github/workflows/test.yml` | Runs `npm test` on PRs and on pushes to `dev` |
| `db/` | SQL files that are run by hand when going live |
| `public/index.html` | The markup of the interface; the embedded icon set (`<svg id="ui-icons">`) |
| `public/css/base.css`, `shell.css`, `games.css` | Shared components, screen frames, game boards (they use variables only) |
| `public/themes/<tema>.css` | A theme: color, font, corner, and shadow variables |
| `public/theme.js` | Theme loader, theme list, and preview colors |
| `public/lobby.js` | The room list after sign-in, room requests, password windows, the Members page |
| `public/app.js` | The in-room client: audio, YouTube, chat, recording, games |
| `public/icons/ui/` | Interface icons (Lucide, with its license next to it) |
| `public/vendor/fonts/` | Embedded fonts (Geist, Nunito; with their licenses next to them) |
| `public/sfx.js`, `public/sfx/` | Sound effects |
| `public/gate-worklet.js` | Microphone noise gate (AudioWorklet) |
| `public/rec-worklet.js`, `mp3-worker.js` | Recording and conversion to MP3 |
| `public/vendor/lame.min.js` | MP3 encoder (lamejs 1.2.1, LGPL); do not edit by hand |

## Rooms and roles

There are three roles:

- **Site admin** (`accounts.js` `ADMINS`, currently `osyalcin`): opens rooms (can choose the owner), approves or rejects room
  requests, closes a room (`genel` cannot be closed), can do everything an owner can do in every room, and
  changes a room's name and owner. Only the admin sees the Members page (`/uyeler`) and the 🫏 button.
- **Room owner**: changes the theme and password of their own room, merges their room with another room, or
  splits the merge.
- **Member**: enters a room without a password directly. For a room with a password, the person becomes a member after typing the password correctly once, and is not
  asked again.

**Room request:** a person who is not an admin uses "Request a room" in the list to send a name, an optional password, a theme, and a note
(only one pending request at a time). When the admin approves it in "Requests", the room opens and the requester becomes the owner. The result
reaches the requester at once.

**Passwords:** a room password is 4-200 characters. Only its hash is stored. When the password changes or is removed, the old
memberships are deleted and everyone types the new password again.

**Merging:** the room owner (or the admin) asks to merge with another room from the room settings. If the owner of the other room
accepts within 60 seconds, the people in the guest room move to the host room. Chat, music, game lobbies,
and the theme (the host's theme) become shared. At most 10 people from each room, 20 in total. If the admin asks, the merge happens at once.
After a rejected or expired request, there can be no new request in the same direction for 60 seconds. One account
sends at most 3 requests per minute. With "Split rooms", everyone goes back to their own room with their own theme.
A merge exists only in memory: if the server restarts, the rooms open separately.

**Muting:** in the "In the room" box, a person's "Manage" (three dots) button opens "Mute". The muted person's
microphone and screen share audio are turned off and locked. They cannot play or upload sound effects. Everyone else
does not play any sound from that person. The chat shows who muted them. When the mute is lifted, the person turns their microphone on
themselves. Rules:
- The origin is the room of the door the person entered through (also in a merged room). A mute is not copied between rooms.
- An owner's mute belongs to the room and applies only to people who entered through that room's door. In a merged room, it does not apply to a person who entered through the other
  room's door. The owner of that door (in the same merged room) or the admin mutes that person.
- An admin's mute belongs to the account: it applies in every room, through every door, during a merge and after it. Only an
  admin lifts it (it is in memory: it is lifted if the server restarts). A person's mute is: the admin's mute if there is one, otherwise the
  owner mute of their origin.
- The admin mutes and unmutes everyone. When the admin unmutes a person, the person's owner mutes in every room are lifted too. An owner mutes and unmutes
  people whose origin is the owner's own room (except the admin and people the admin muted). Nobody can mute themselves.
- An owner mute is deleted when the room closes, or when none of the people with that room as their origin are left in the live rooms or in the refresh grace period.
  A person who leaves the room and comes back is still muted.

## Themes

All colors, fonts, corners, and shadows of the look are variables. The variable contract is written at the start of
`public/css/base.css`. Rules do not contain fixed colors. The room owner chooses the theme in the room
settings and presses "Apply". It changes for everyone in the room without a page refresh. The room list and the sign-in screen
are always in the default theme (Night Room). The themes are: Night Room (`gece`, dark, the default), Bright Room
(`aydinlik`, light), Pixel Room (`piksel`, retro game: its own pixel fonts and pixel icon set), Winter Room
(`kis`, a cold blue night; snowfall and winter decorations: a snowman, icicles, snow piles, all made with the rules at the end of the theme
file and an embedded SVG; the quick emoji row also follows the winter theme, `app.js` `THEME_QUICK_EMOJIS`), and Neon Room
(`neon`, a dark indigo background with pink → violet → cyan neon edges; on desktop the stage is laid out like a game
console: a people column on the left, the volume dial, tools, cross-shaped seek buttons and a big play button on both
sides of the player, the time bar and round page buttons below it; all of it in the theme file's
`@media (min-width: 1000px)` block, with `display: contents` and grid areas, without touching the HTML. The volume
dial reads its percentage from the `data-val` value of the `.vol` box, written by `app.js` `paintRange`. The phone
layout is shared).

Adding a new theme (example id `yeni`):

1. `public/themes/yeni.css`: defines all the variables in the contract (copy `public/themes/gece.css`).
   Text contrast must be at least 4.5:1. If it has its own font, `@font-face` goes in this file (it downloads only when the theme is selected),
   and the font file goes under `public/vendor/fonts/<ad>/` with its license.
2. Icon set: `public/icons/ui/<set>.svg`, with the same `i-…` names as `lucide.svg` (put its license next to it,
   `LICENSE-<set kaynağı>`). The generator is `test/tools/icons.js`. If it uses the same set, skip this step.
3. `public/theme.js`: add `'yeni'` to `LIST`, the displayed name to `NAMES`, the icon set to `ICON_SETS`, and the room
   card preview colors (bg, surface, text, accent) to `PREVIEW`.
4. `rooms.js`: add `'yeni'` to the `THEMES` array (the server does not accept a theme it does not know).
5. Cache: change `CSS_VERSION` in `public/theme.js` and the `theme.js?v=…` tag in `public/index.html`
   (also every time a theme file changes; otherwise browsers use the old file for hours).

## Language (Turkish / English)

The site is written in Turkish; English is a translation layer. The language is chosen from the sign-in card, the account window, or the room
settings (`localStorage.lang`). If none is chosen, the site opens in English when the browser language is not `tr`. It changes without a page
refresh.

- `public/i18n.js` (in `<head>`, before everything else): when English is selected, it translates every text shown on the screen, the `placeholder`,
  `title`, and `aria-label` attributes, and the text of `alert/confirm/prompt` from the dictionary (MutationObserver).
  It can be called in code: `I18N.t('Türkçe metin')`, `I18N.lang`, `I18N.locale` (date and number format), and the `langchange` event.
- Dictionaries: `public/lang/en-ui.js` (the site shell), `en-games.js` (games), `en-server.js` (the system messages and errors
  the server sends). The key is the Turkish text on the screen itself. Variable parts are written as `{0}`, `{1}`… and
  can be reordered in the translation: `"{0} odaya katıldı": "{0} joined the room"`.
- Not translated: boxes that have `translate="no"` and the `KEEP` selectors in `i18n.js` (chat messages,
  song and list titles, the words of Typing, Word, and Speed reading; the content of these games stays Turkish).
- The logic grid puzzle is generated on the server in two languages (`games/mantik.js` `clueTextEn`, sent to the player as `game.en`).
- Texts inside CSS (`content:`) are replaced with the `:lang(en)` rule (at the end of `public/css/games.css`).

When you add a new text, also write its English in the matching dictionary file. To find missing ones, open the site in English and
look for text nodes that contain Turkish characters on the page.

## Tests and the test server

```bash
npm test           # node --test --test-concurrency=1 test/*.test.js  (test/*.test.js, in sequence)
```

The tests start their own servers in memory, without Supabase.

To try the interface by hand, use the **test server** (it does not connect to Supabase, does not read `.env`, and keeps everything in memory):

```bash
PORT=4100 node -r ./test/preload.js server.js
```

In the browser, without signing in, type `localStorage.token = 'test:Ali'` and refresh the page to sign in under that name.
`test:osyalcin` is the site admin. For tasks that need a registered account, such as changing the account password,
create an account with `POST /auth/register`. The test server also has a second test theme ("Deneme (test)"); it does not
exist on the live site. **Never run the server on a branch without the preload (`npm start` or `node server.js`):**
if `.env` exists, it connects to the live database.

## Going live (multi-room switch)

When multi-room goes live for the first time, the order is exactly this (the SQL files are run by hand in the Supabase SQL editor;
read the notes at the start of the files):

1. Apply `db/2026-11-22-rooms.sql` (the room, request, and membership tables; the old server does not use them, so it can be
   done in advance).
2. Stop the old server.
3. Apply `db/2026-11-22-golive.sql` (the `genel` room and the shared score tables).
4. Start the new server.

When Supabase is set and step 1 or step 3 is missing, the new server refuses to start: the log shows a `SUNUCU AÇILMIYOR` (SERVER WILL NOT START) line
and the process exits (so that records are not lost silently). So the new code does not
run on the live site until the SQL files are applied.

## Contributing and publishing

Every commit that goes into `main` is on the live site within about one minute. There is no direct push to `main`; changes enter only
by pull request (see "Development flow"). First:

1. Try the change on your computer with the test server (`PORT=<port> node -r ./test/preload.js server.js`) and
   run `npm test`. There must be no errors in the browser console. `npm start` connects to the live database, so it is not used
   for trying changes.
2. Push a front-end change to the `dev` branch and try it on dev.agalar.app. Then open a pull request to `main` (the tests
   run on GitHub Actions on their own).
3. Write commit messages in Turkish, and describe what the commit does.

**Transition period:** the site is moving from Render to our own server. Until the move is approved, the Render service and
`render.yaml` stay in place (behavior does not change there, because `CLIENT_IP_HEADER` is not set on Render). When the move
has run without problems for one week, the Render service is deleted, `render.yaml` is removed, and this note is updated.
Until then, the status and logs of the Render deployment are in the **Events** and **Logs** tabs of the Render panel.

### Publishing on our own server

The app runs in a Docker container on the server and opens no port to the outside. Visitors come through Cloudflare Tunnel
(the `tunnel` container connects to Cloudflare by itself and forwards only to `app:3030`).

**Every deploy causes a few seconds of downtime; with a broken commit, about 1 minute** (the new container waits for the health check,
and if it fails, the previous version is started again). The old and new servers never run together at any moment: room state is
already in memory and is reset at every restart, and two servers writing to the same database would be worse.

Layout on the server:

| Path | Owner, permission | What |
| --- | --- | --- |
| `/srv/sesli-oda/` | `root:sesli-oda 750` | Root directory |
| `/srv/sesli-oda/app/` | `sesli-oda` | The git copy of this repository; the deploy script moves it to a given commit |
| `/srv/sesli-oda/compose.yml` | `root:root 644` | The compose file that is **in use**: a reviewed copy of `deploy/compose.yml` |
| `/srv/sesli-oda/Dockerfile` | `root:root 644` | The Dockerfile that is **in use**: a reviewed copy of `deploy/Dockerfile` |
| `/srv/sesli-oda/.env` | `root:root 600` | Secrets: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`, `YT_API_KEY`, `CLIENT_IP_HEADER=cf-connecting-ip`, `TUNNEL_TOKEN`. It does not go into git. |
| `/srv/sesli-oda/state/` | `root 755` | Records of the deploy script (failed or pinned commit, warnings) and the temporary build archive |
| `/run/sesli-oda-yayin/lock` | `root 700` directory | The deploy lock (two deploys do not run at the same time) |
| `/usr/local/sbin/sesli-oda-yayin` | `root:root 755` | A copy of `deploy/yayin.sh` |
| `/usr/local/sbin/sesli-oda-ag` | `root:root 755` | A copy of `deploy/sesli-oda-ag.sh` (firewall) |
| `/etc/systemd/system/sesli-oda-yayin.{service,timer}`, `sesli-oda-ag.service` | `root:root 644` | Copies of the files under `deploy/` |

- `deploy/compose.yml` (the source) and its approved copy: the compose project is `sesli-oda`; `app` (user `1000:1000`,
  read-only file system, no capabilities, 512 MB, health check `GET /theme-list`) and `tunnel`
  (`cloudflare/cloudflared`). Its own network is `sesli-oda` (`172.31.240.0/28`, IPv4 only), and no port is published. Secrets
  are given to compose with `--env-file /srv/sesli-oda/.env`, and each container gets only its own variables
  (`app` does not see the tunnel key, and `tunnel` does not see the Supabase key). The user and the health check are fixed in compose.
  Both containers get `1.1.1.1` and `9.9.9.9` as DNS: the server's own upstream DNS is on a private address
  (`10.114.15.254`), Docker's embedded DNS asks it from the container's network namespace, and the firewall drops
  anything going to private networks. The embedded DNS still resolves the names `app` and `tunnel` by itself.
- `deploy/Dockerfile` (the source) and its approved copy `/srv/sesli-oda/Dockerfile`: `node:22-alpine`,
  `npm ci --omit=dev --ignore-scripts` (the install scripts of dependencies do not run; no package in the express and socket.io
  tree has an install script). Only `package*.json`, the `*.js` files in the root, `games/`, and `public/`
  are copied. If a new folder is added to the root, it must also be added to the Dockerfile (and to `.dockerignore`, for size).
- Logs are in journald: `journalctl -t sesli-oda-sesli-oda-app-1 -f` (the tunnel is `...-tunnel-1`), and the deploy script
  is `journalctl -u sesli-oda-yayin`.

**Deploy (`sesli-oda-yayin`, once a minute by timer):** it fetches `origin/main`. If there is a new commit, it builds the image
from a clean archive of that commit (`git archive`; not the working tree and not `.git`) and from the installed Dockerfile, as
`sesli-oda-app:<short sha>`. It restarts `app` with it and waits up to 60 seconds for it to pass the health check. If it passes, the image gets the `current` tag
(the last healthy version). If it cannot build, cannot start, or does not pass (for example `SUNUCU AÇILMIYOR` in the log), `current` is started again,
the script exits with an error code, and it does not try that commit again on its own. The last 3 images are kept. In a successful deploy, `app` is recreated once.
If the container is starting (`starting`), the round is skipped. If the running version is unhealthy or crashes repeatedly
(`restarting`, `exited`), the same version is not recreated automatically, and a `SİTE KAPALI: ...` (SITE DOWN: ...) line
is written on every round (also when the new and the previous version both did not start).
- **A change to compose or the Dockerfile does not take effect on its own.** Compose is always read from
  `/srv/sesli-oda/compose.yml` (`--project-directory /srv/sesli-oda/app`), and the Dockerfile is always read from
  `/srv/sesli-oda/Dockerfile`. If `deploy/compose.yml` or `deploy/Dockerfile` in the repository differs from the installed copy, the installed copy is still used, and once per commit
  the line `UYARI: compose değişti, kurulu kopya kullanılıyor: elle güncelle` (WARNING: compose changed, the installed copy is used: update by hand) (or `Dockerfile değişti, …`) is written. The same applies to `deploy/yayin.sh`,
  `deploy/sesli-oda-ag.sh`, and the systemd units: when they change in the repository, they are copied to the server by hand
  (see "Updating the installed copies" below).
- **The risk that stays tied to the repository during the build:** someone who can push to main can change only (a) the
  files copied into the image (the `*.js` files in the root, `games/`, `public/`, `package*.json`) and (b) which registry
  packages (npm) `package-lock.json` pins. The build steps, the build network, fetching files from outside with `ADD`, the base image, and the dependency
  install scripts are fixed in the installed Dockerfile and by `--ignore-scripts`. Because the build context is an archive, symlinks in the context cannot point outside (for example
  to `.env`). So a malicious push can publish bad code or a bad npm package (this was also true on Render), but during the build it cannot
  reach the server's internal network or files.
- **Manual deploy and rollback:** `ssh otomasyon sudo sesli-oda-yayin <sha>` deploys that commit (it must be in main's
  history; if its image still exists, it is not rebuilt). When you go back to an old commit, the automatic deploy stops until
  a new commit arrives on main. A commit that failed is retried with the same command. If a manual call is made while another deploy
  is running, it gives an error; try again a little later.
- Running compose by hand:
  `sudo docker compose -f /srv/sesli-oda/compose.yml --project-directory /srv/sesli-oda/app --env-file /srv/sesli-oda/.env ps`.
  A manual `up -d` (without APP_TAG) **recreates** `app` with the `current` tag (the deploy script had started it with the sha
  tag): a few seconds of downtime. If `--env-file` is forgotten, compose stops with a required-variable error. **Environment variables in the shell
  take priority over the `--env-file` values:** do not use `sudo -E`, and variables such as `SUPABASE_*` and `APP_TAG` must not be defined in the shell.

**Server firewall (`sesli-oda-ag`):** everything that goes from the container network (`172.31.240.0/28`) to the server itself
(`INPUT`) and everything that goes to private/internal networks (`10/8`, `172.16/12`, `192.168/16`, Tailscale `100.64/10`, `169.254/16`)
(`DOCKER-USER`) is dropped. Traffic between app and tunnel, and the internet, are open. The rules are IPv4 only (there is no IPv6 on the compose network).
Each time Docker starts, `sesli-oda-ag.service` checks the rules again (running it again is safe);
`sudo sesli-oda-ag kaldir` removes only these rules. The `DOCKER-USER` rules of other units are not touched.
**Out of scope:** the image build (`docker build`) runs on Docker's default build network and on the host's network, and is not
caught by these rules. This is why the build steps come from the installed Dockerfile, not from the repository (see "The risk that stays tied to the repository
during the build" above). When Docker starts, the containers may start a few seconds before the rules.
The deploy unit depends on the firewall unit (`Requires=`): if the rules cannot be loaded, no deploy is made.

**First setup (once, as root):**

```bash
useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin sesli-oda
install -d -o root -g sesli-oda -m 750 /srv/sesli-oda
install -d -o sesli-oda -g sesli-oda -m 755 /srv/sesli-oda/app
setpriv --reuid=sesli-oda --regid=sesli-oda --init-groups --reset-env \
  git clone https://github.com/osman-selim-yalcin/sesli-oda.git /srv/sesli-oda/app
install -d -o root -g root -m 755 /srv/sesli-oda/state
install -o root -g root -m 600 /dev/null /srv/sesli-oda/.env   # sonra değerler yazılır (editörle)
cd /srv/sesli-oda/app/deploy
install -o root -g root -m 644 compose.yml /srv/sesli-oda/compose.yml
install -o root -g root -m 644 Dockerfile /srv/sesli-oda/Dockerfile
install -o root -g root -m 755 yayin.sh /usr/local/sbin/sesli-oda-yayin
install -o root -g root -m 755 sesli-oda-ag.sh /usr/local/sbin/sesli-oda-ag
install -o root -g root -m 644 sesli-oda-yayin.service sesli-oda-yayin.timer sesli-oda-ag.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sesli-oda-ag.service          # kurallar; iptables -L DOCKER-USER -n ile bak
cd /                                                 # depo dizininden çık (yayın checkout'u değiştirir)
sesli-oda-yayin                                      # ilk yayın elle: imaj, app, sonra tunnel
                                                     # (kilit dizini /run/sesli-oda-yayin root 700 açılır)
systemctl enable --now sesli-oda-yayin.timer
```

If a value in `.env` contains `$`, put it in single quotes (compose takes it for a variable).

**When the server restarts:** Docker starts, `app` and `tunnel` come up with their own images by `restart: unless-stopped`
(the sha-tagged image of the last successful deploy; compose is not evaluated again), `sesli-oda-ag.service` adds the rules, and the timer
starts the deploy rounds 1 minute later. Nothing is needed by hand.

**Updating the installed copies** (when something under `deploy/` changes in the repository, or when `UYARI: …
değişti` (WARNING: ... changed) appears in the deploy log). Each file is reviewed by looking at its diff first, and only the changed ones are copied:

```bash
D=/srv/sesli-oda/app/deploy   # yönetici bu dizine giremez (750); komutlar sudo ile
for f in compose.yml Dockerfile; do sudo diff -u /srv/sesli-oda/$f $D/$f; done
sudo diff -u /usr/local/sbin/sesli-oda-yayin $D/yayin.sh
sudo diff -u /usr/local/sbin/sesli-oda-ag $D/sesli-oda-ag.sh
for f in sesli-oda-yayin.service sesli-oda-yayin.timer sesli-oda-ag.service; do sudo diff -u /etc/systemd/system/$f $D/$f; done

# compose: kopyala, sonra yeni ayarlarla yeniden yarat (APP_TAG yok: app current ile yeniden yaratılır, kesinti)
sudo install -o root -g root -m 644 $D/compose.yml /srv/sesli-oda/compose.yml
sudo docker compose -f /srv/sesli-oda/compose.yml --project-directory /srv/sesli-oda/app \
  --env-file /srv/sesli-oda/.env up -d
# Dockerfile: kopyala; bir sonraki yayında kullanılır (hemen denemek için: sudo sesli-oda-yayin <main'deki sha>)
sudo install -o root -g root -m 644 $D/Dockerfile /srv/sesli-oda/Dockerfile
# yayın betiği: bir sonraki zamanlayıcı turunda kullanılır
sudo install -o root -g root -m 755 $D/yayin.sh /usr/local/sbin/sesli-oda-yayin
# güvenlik duvarı betiği: eski kuralları kaldır, yenisini kur
sudo sesli-oda-ag kaldir
sudo install -o root -g root -m 755 $D/sesli-oda-ag.sh /usr/local/sbin/sesli-oda-ag && sudo systemctl restart sesli-oda-ag
# birimler
sudo install -o root -g root -m 644 $D/sesli-oda-yayin.service $D/sesli-oda-yayin.timer $D/sesli-oda-ag.service \
  /etc/systemd/system/ && sudo systemctl daemon-reload
```

If you need to rebuild the same commit with a new installed Dockerfile (the script does not rebuild, because the image already exists with that sha),
first delete that image: `sudo docker image rm sesli-oda-app:<short sha>` (if it is not the running one).

**Things to check on the server** (at setup and from time to time):

- Does `172.31.240.0/28` overlap with another Docker network or with an interface of the server
  (`docker network inspect $(docker network ls -q) | grep Subnet`, `ip -4 addr`)?
- Is the Docker build cache growing (`docker system df`)? If needed, `docker builder prune --filter until=168h`.
- Is there a service on the server that works by looking at Docker labels (for example Traefik, Watchtower, an automatic backup)?
  If there is, make sure it does not publish or update the `sesli-oda` containers on its own.
- Does the firewall really work: `sudo docker exec sesli-oda-app-1 node -e "fetch('http://<sunucunun iç
  adresi>:22').catch(e=>console.log('engelli',e.cause?.code))"` must time out. Name resolution and the internet must be open:
  `... node -e "require('dns').promises.lookup('supabase.co').then(console.log)"` and `lookup('tunnel')`
  (thanks to `dns: [1.1.1.1, 9.9.9.9]` in compose). The counters from `sudo iptables -L INPUT -v -n | grep sesli-oda`
  must not grow on a DNS query.

**The real visitor address (`CLIENT_IP_HEADER`):** the limits for sign-in, password change, room password, and sign-up
are counted by visitor address (for IPv6, the /64 prefix of the address). Behind the tunnel, `CLIENT_IP_HEADER=cf-connecting-ip`
is set: the address is taken from this header. If the header is missing or is not a single valid address, the connection's own address is
used, `X-Forwarded-For` is not looked at, and a warning is written to the log (at most once every 10 minutes). This setting is safe only if
the app cannot be reached from outside Cloudflare (a client can also write the header). If it is not set, the old
rule applies (Render's proxy: the last value of `X-Forwarded-For`).

## Development flow

- **The `dev` branch → https://dev.agalar.app** (once a minute). The dev environment is **front end only:** the `public/` directory of the `dev` branch
  is served as it is; API and socket.io requests go to the **live server**. So dev uses the
  **live database**: the account you sign in with, the room you open, the message you write, and the score you win are real.
  Know this when you create a test account or a test room on dev.
- **Server changes do not work on dev.** Changes in files such as `server.js`, `accounts.js`, `rooms.js`, and `games/`
  run on the server only when they enter `main`. On dev, they are tried with the tests (`npm test`, GitHub Actions) and the local
  test server. A dev front end that needs a new server feature does not work on dev until that feature enters `main`
  (for example, a new endpoint returns 404).
- **`main` changes only by pull request.** When a PR is opened and on every push to `dev`, `.github/workflows/test.yml`
  runs `npm ci` and `npm test` (it uses no secrets and needs no network). When the PR is merged, the live deploy happens on its own.
- A small red **DEV** label appears at the top of the dev page (`public/dev.js`; it runs only on an address that starts with `dev.`,
  and does nothing on the live site). Dev is closed to search engines (`X-Robots-Tag: noindex`). html, js, and
  css are revalidated on every open (`Cache-Control: no-cache`); sound effects, fonts, and icons
  stay in the cache.

### How the dev deploy works

- `sesli-oda-dev-yayin` (`deploy/dev-yayin.sh`, once a minute by timer, root): in the shared git copy
  (`/srv/sesli-oda/app`) it fetches only `origin/dev`. It **does not check out** (the working tree belongs to the live deploy). If there is a new
  commit, it first checks that commit's `public/` tree in git: only plain files and directories (a symlink or a submodule
  is rejected), every path under `public/`, at most 5000 files and 200 MB. Then it extracts only the archive of `public/`
  (`git archive <sha> public`) into a new directory owned by root (`/srv/sesli-oda/dev/www/releases/<short
  sha>/public`), switches the `current` symlink to it atomically, and writes the commit to `/srv/sesli-oda/state/dev-rev`.
  The last 3 releases are kept. The container is not restarted. A rejected commit is not tried again (the log has
  `REDDEDİLDİ:` (REJECTED:) and `HATA:` (ERROR:)); the version on dev keeps being served as it is. If there is no `dev` branch, it exits silently.
- By hand: `sudo sesli-oda-dev-yayin <sha>` (it must be in the history of the `dev` branch). When you go back to an old commit, the automatic dev
  deploy stops until a new commit arrives on dev.
- The `dev` container (Caddy, `deploy/dev/Caddyfile`): `:8080`, HTTP only. `/srv/sesli-oda/dev/www` is mounted read-only
  and served from `current/public`. The order is: the live site's dynamic endpoints (socket.io, `/auth/*`, `/rooms*`,
  `/admin/*`, `/config`, `/status`, `/search`, `/theme-list`, `/avatar/*`, `/img/*`, `/card-img/*`,
  `/sfx-custom/*`, `/radio/*`) always go to the live `app`. Page addresses (`/uyeler`, `/oda/...`) get dev's
  `index.html`. A file that exists on dev is served from dev. Everything else goes to the live `app`. When a new endpoint is added to the server, it must also be added to the list in the Caddyfile.
  `Cf-Connecting-Ip` is passed as it is; on this path, nothing the client can fake is
  more than on the direct tunnel path.
- It runs no code, takes no secrets, and does not see `.env`. The live deploy (`sesli-oda-yayin`) does not touch this container.

**First setup of the dev environment (once, as root; the live site must already be set up):**

```bash
install -d -o root -g root -m 755 /srv/sesli-oda/dev /srv/sesli-oda/dev/www /srv/sesli-oda/dev/www/releases
D=/srv/sesli-oda/app/deploy   # bu dosyalar, commit'i main'e girip canlıya yayınlanınca checkout'ta olur
install -o root -g root -m 644 $D/dev/Caddyfile /srv/sesli-oda/dev/Caddyfile
install -o root -g root -m 755 $D/dev-yayin.sh /usr/local/sbin/sesli-oda-dev-yayin
install -o root -g root -m 644 $D/sesli-oda-dev-yayin.service $D/sesli-oda-dev-yayin.timer /etc/systemd/system/
sudo diff -u /srv/sesli-oda/compose.yml $D/compose.yml       # yalnız dev servisi eklenmiş olmalı
install -o root -g root -m 644 $D/compose.yml /srv/sesli-oda/compose.yml
systemctl daemon-reload
cd /
sesli-oda-dev-yayin                                         # ilk sürüm (dev dalı GitHub'da olmalı)
ls -l /srv/sesli-oda/dev/www                                # current -> releases/<kısa sha>
docker compose -f /srv/sesli-oda/compose.yml --project-directory /srv/sesli-oda/app \
  --env-file /srv/sesli-oda/.env up -d --no-deps dev
systemctl enable --now sesli-oda-dev-yayin.timer
```

In Cloudflare (Zero Trust → Tunnels → `sesli-oda` → Public hostnames): `dev.agalar.app` → `http://dev:8080`.
If `dev` starts while `current` does not exist, everything returns 404 (the health check too); publish the first release first. When the Caddyfile
changes, it is copied and `dev` is restarted (`... restart dev`): a single-file mount keeps seeing the old file.
Stopping the `dev` container does not affect the live site (`... stop dev`).

## Environment variables

On our own server they are in `/srv/sesli-oda/.env` (see "Publishing on our own server"), on Render in the **Environment** section, and
on your computer in `.env`. Keys are never written in the code. In the container on the server, `SUPABASE_URL`,
`SUPABASE_SECRET_KEY`, `CLIENT_IP_HEADER`, and `TUNNEL_TOKEN` are required; the rest are optional.

| Variable | What it does |
| --- | --- |
| `YT_API_KEY` | YouTube search inside the site (YouTube Data API v3, free, about 100 searches per day). If it is missing, search is off, and pasting a link still works. The same search is kept in the cache for 1 hour. |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Cloudflare TURN: on some mobile networks a direct connection cannot be made ("Bağlanamadı" (Could not connect)); the server makes temporary TURN credentials with these keys. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | On some mobile networks a direct connection cannot be made ("Bağlanamadı" (Could not connect)); in that case a TURN server is needed. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Accounts, pre-played songs, custom effects, and tier lists are stored permanently in Supabase (the `accounts`, `sessions`, `room_state`, `rooms`, `room_requests`, `room_members` tables and the private `media` bucket). Only the scrypt hash of passwords and only the SHA-256 hash of session keys are stored. If missing, data stays only in memory and is deleted when the server sleeps. On your computer, it is written in the `.env` file (it does not go into git). A server started with `npm start` on your computer uses the same records as the live site (the test server does not): if both are running at the same time and a change is made in the same room, the last writer wins, and each server reads the records only when it starts. |
| `CLIENT_IP_HEADER` | The header the visitor address is read from; behind the tunnel it is `cf-connecting-ip`. If it is not set, the last value of `X-Forwarded-For` (Render). Set it only if the app cannot be reached from outside except through the proxy that writes that header. |
| `TUNNEL_TOKEN` | Only on the server, for the `tunnel` container (the Cloudflare Tunnel key); it is not given to the app container. |
| `PORT` | The server port (default 3030; Render sets it itself; 3030 in the container). |

## Internet usage

- Audio: Opus 32 kbps, almost 0 when silent (DTX). About 10-20 MB/hour when 5 people talk. Everyone is connected directly
  to everyone: the speaker sends their voice separately to each listener (with 10 people, 9 × 32 kbps; in a merged room, 19 × 32 kbps).
- Screen sharing: the video goes to each person separately. It is at most 1 Mbps per person, and in a crowded room the rate per person goes down so that the total upload
  does not pass 6 Mbps (about 670 kbps per person with 10 people, about 315 kbps with 20 people).
- Music/video: everyone plays YouTube on their own device; the app only passes the "play / pause / go to this second"
  commands. The real data use is the YouTube video itself.

## Licenses

The sources and licenses of the sound effects are in `public/sfx/KAYNAKLAR.txt`; do not delete this file. Four effects
(Ding, Hüzün, Tada, Bum) are licensed CC BY 3.0 and require attribution; the app currently has no attribution link.
