# Multi-region match servers (TENTEN standard)

**Pilot:** HEDDY (`footy`). The same design is meant to be copied into Pong, Kurver, 1v1 Arena and every
future TENTEN game; [Porting to another game](#porting-to-another-game) lists exactly what to copy.

## The idea

One website, one lobby, several match servers. Everything runs from the **same code**; config decides
what each server does.

- **Home server**: the existing Render service (tenten.run links there). It keeps the lobby,
  `rooms.html`, `footy-match.html`, Stripe entry fees and the Stripe webhook. It can also host matches.
- **Regional servers**: the same repo deployed in other Render regions (Oregon, Ohio, Virginia). They
  only host matches. Their `/` and `/rooms.html` redirect to home, and their lobby refuses joins, so
  nobody ends up in a second lobby.

When both players are ready, the home lobby looks at **both players' measured pings to every region**
and starts the match on the region that is **best and most equal** for the two of them. The pages stay
on the home server; only the match connections (and the twin connections) go to the region.

```
 browser ── rooms.html (home) ──── lobby_room (home)
    │  times GET /ping on every region; sends 'lobby:pings' {region: ms}
    │                                   │ both Ready (paid)
    │                                   ▼
    │                        pickRegion(pings A, pings B)
    │                                   │ POST /internal/create-match  (secret)
    │                                   ▼
    │                        game_room on the chosen region
    │  'room:game:start' {code, region}
    ▼
 footy-match.html?room=<id>&srv=<region>   (page from home)
    └─ match socket + twin sockets ─────► the chosen region
```

**With the env vars unset, nothing changes:** one server, no `&srv`, no pings sent, launch options
identical to before. Multi-region is switched on only when all four variables are set and valid.

## Environment variables

Set the same values on every server, except `FOOTY_REGION`.

| Variable | Example | Meaning |
|---|---|---|
| `FOOTY_REGIONS` | `{"home":"https://footy-0ipb.onrender.com","oregon":"https://footy-oregon.onrender.com","ohio":"…","virginia":"…"}` | Every server, **home included**: name → public base URL. Names are lowercase letters, digits or `-`. At least two. |
| `FOOTY_HOME_REGION` | `home` | Name of the home server (must be in `FOOTY_REGIONS`). |
| `FOOTY_REGION` | `ohio` | **This** server's own name (must be in `FOOTY_REGIONS`). |
| `FOOTY_REGION_SECRET` | 32+ random characters | Shared secret for server-to-server calls (at least 16 characters). |

If any of the four is missing or invalid, the server logs
`[regions] multi-region OFF — <why>. Running as a single server.` and runs exactly as before. If all four
are unset, it says nothing.

On boot, a configured server logs:
`[regions] multi-region ON — this server is "ohio" (matches only); regions: home, oregon, ohio, virginia`.

Other variables:

- **Every server (home and regions):** `DATABASE_URL`, the shared Neon database. Logins are checked
  there, and **wins are credited by the server that hosts the match**.
- **Every server, same value:** `FOOTYMP_PAYOUTS_ENABLED`. The payout kill switch is read where the match
  runs, so it must be identical everywhere.
- **Home only:** `ENTRY_FEES_ENABLED`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BASE_URL`, and the
  push-notification keys. Regional servers don't need Stripe.

## How a match finds its region

### 1. Measuring pings (`rooms.html`)

The page loads `/regions.js` (region names → URLs; `{}` on a single server). For each region it times
4 `GET <region>/ping` requests (`cache: 'no-store'`). The first is ignored because it includes
connection setup, and the lowest of the other three is kept. Regions are measured in parallel. The
result is sent as `'lobby:pings' {region: ms}` on every lobby connect and re-measured every 60 s.

`/ping` is tiny, `Access-Control-Allow-Origin: *` and `Cache-Control: no-store`.

**Local testing only:** `rooms.html?pings=ohio:20,oregon:60` replaces the measurement. This is honoured
only when the page is on `localhost` / `127.0.0.1`.

### 2. The fair pick (`server/src/regions.ts` → `pickRegion`)

For each region **both** players measured:

```
score = max(pingA, pingB) + |pingA − pingB| / 2      → lowest score wins
```

The score is the slower player's ping plus half the gap. A region that is great for one player and bad
for the other loses to one that is fair to both. Ties go to the lower total, then home, then name
order.

- No region in common → the **host's** best region → otherwise **home**.
- Only configured regions are ever returned.

| Players | Pick |
|---|---|
| Seattle vs Boston | **Ohio** |
| New York vs Boston | **Virginia** |
| LA vs LA | **Oregon** |

Unit tests: `server/test/regions_test.ts` (`npm test`).

### 3. Starting the match (`LobbyRoom.startMatchRoom`)

- **Chosen region is this server:** `createMatchHere()`, which is `matchMaker.createRoom("game_room", …)`
  with a launch ticket, as before.
- **Chosen region is another server:** `POST <region>/internal/create-match` with the secret in the
  `x-footy-region-secret` header. That server **issues the launch ticket itself** and creates the room.
  Launch tickets are in-memory per server (`launchTickets.ts`) and never travel between servers.
- **The region doesn't answer within 6 s** (down, hanging or erroring): the match starts **on home**
  instead. A match never fails to start because of another region; this matters most when both
  players have already paid. The entries are attached to the home match as usual.

The lobby remembers `matchId → region`. It sends the region in `'room:game:start'` and in the rejoin
answer `'room:match'`, and `rooms.html` adds `&srv=<region>` to the match link.

Every launch is logged on home:

```
[regions] match <id> on <region> — <A> (<A's pings>) vs <B> (<B's pings>) [score 75]
[regions] room 1271: ohio couldn't start the match (…) — starting it on home instead
[regions] match <id> on home — … [score 75, ohio unreachable → fallback]
```

### 4. The match page (`colyseus-adapter.js`, `footy-match.html`)

If the link has `&srv=<region>` **and that name is in `/regions.js`**, the adapter connects to that
region's URL (`http→ws`, `https→wss`). It never accepts a raw URL from the link. The URL is exposed as
`window.footyServerURL`, and the twin connections (`openTwin` → `twin_room`) use it, so a player's match
and twin sockets all go to the match's region.

The page itself (and Back to Lobby) stays on home. Cross-origin matchmaking works because Colyseus
echoes the request's `Origin` in its CORS headers.

### 5. Match → lobby callbacks (`GameRoom.callLobby`)

The match room calls the lobby for `requestRematch` and `matchClosed`:

- **Same server:** `matchMaker.remoteRoomCall` (as before).
- **Regional match** (created with `lobbyIsRemote: true`): `POST <home>/internal/lobby-call`, with the
  secret. Home only, and only those two methods with checked arguments.

A rematch therefore always goes back through the lobby, so its region is **picked again** from fresh
pings.

### 6. Rejoin (`LobbyRoom.liveMatchOf`)

A page that comes back to the lobby while its match is still on is sent back to it. For a match on
another region, the lobby asks that region `POST /internal/match-live {roomId}` → `{live}`. If the region
can't be reached at that moment, the player isn't sent back this time, but the match is remembered and
asked about again on the next connect.

## Endpoints

| Route | Who | Notes |
|---|---|---|
| `GET /ping` | every server | `ok`, CORS `*`, `no-store` |
| `GET /regions.js` | every server | `window.FOOTY_REGIONS`, `window.FOOTY_HOME_REGION` |
| `POST /internal/create-match` | every server | secret; `{allowedUserIds, lobbyRoomId, agreedPrize, entriesCharged}` → `{roomId}`. The room still validates the roster and prize. |
| `POST /internal/match-live` | every server | secret; `{roomId}` → `{live}` |
| `POST /internal/lobby-call` | home only | secret; `{lobbyRoomId, method, args}`, where method is `requestRematch` or `matchClosed` |

`/internal/*` returns 404 on a single server and 403 without the right secret. The secret is compared
as SHA-256 digests with `timingSafeEqual`.

## Render setup

1. **Deploy the code to home first** with no new variables. Nothing changes.
2. **Create the regional services.** Do this once per region (Oregon, Ohio, Virginia): New → Web
   Service → the same repo and branch → choose the region → same build and start commands as home
   (`npm run build` / `npm start`, Node 20.11.0). Use a plan that **doesn't sleep**: a sleeping
   instance answers too slowly, so its matches would all fall back to home. If home is already in one
   of these regions, skip that one; home serves it.
3. **Set the variables on each regional service:**
   - `DATABASE_URL` (same as home);
   - `FOOTYMP_PAYOUTS_ENABLED` (same as home, if set);
   - `FOOTY_REGIONS`, `FOOTY_HOME_REGION`, `FOOTY_REGION_SECRET` (same everywhere);
   - `FOOTY_REGION=<its own name>`.
4. **Check each region:** open `https://<region>/ping` (shows `ok`) and `https://<region>/` (redirects
   to home).
5. **Switch it on:** set the same four variables on **home** (with `FOOTY_REGION=<home's name>`). Home's
   log should show `multi-region ON … (home: lobby + matches)`.
6. **Watch the logs:** the `[regions] match … on …` lines on home show the real choices.

**Switching off:** remove `FOOTY_REGIONS` from home. The lobby goes back to starting every match on
home. Matches already running on a region finish there.

## Testing locally

Run three servers on different ports. For example, oregon is home on `:2601`, ohio on `:2602` and
virginia on `:2603`, all with:

```
FOOTY_REGIONS='{"oregon":"http://localhost:2601","ohio":"http://localhost:2602","virginia":"http://localhost:2603"}'
FOOTY_HOME_REGION=oregon  FOOTY_REGION_SECRET=<16+ chars>  FOOTY_REGION=<its name>  DATABASE_URL=<a test database>
```

Then open `http://localhost:2601/rooms.html?pings=oregon:20,ohio:60,virginia:70` for one player and
another browser profile with the other player's pings. Stop a region server before Ready to see the
fallback.

## Known limits

- **A region dying mid-match** loses that match, the same as a single server restarting mid-match
  today.
- **Credit keys** stay `footymp:<roomId>`. Room ids are random per server; a cross-server collision is
  very unlikely, and the unique key would refuse a double credit rather than pay twice.
- **`/status`** (admin dashboard) counts only the server it's asked, so live matches on regions aren't
  included in home's numbers.
- **A region that answers after the 6 s timeout** leaves an empty, unused match room. Nobody joins it, so
  it credits nothing and closes itself.

## Porting to another game

1. Copy `server/src/regions.ts` and rename the prefix: `FOOTY_` → `PONG_`/`KURVER_`/…, the
   `x-footy-region-secret` header, and `window.FOOTY_REGIONS`. Point `createMatchHere()` at the game's
   match room and options, and `LOBBY_METHODS` at the lobby methods its match room calls.
2. Register the routes in `app.config.ts` with `regionRoutes(app)`, and redirect `/` and the lobby page
   to home with `homeURLIfRegional()`. Both go before `express.static` and the catch-all.
3. **Lobby room:**
   - refuse joins in `onAuth` when `!isHomeServer()`;
   - store `'lobby:pings'` through `cleanPings`;
   - start matches through a `startMatchRoom` that picks a region and falls back to home;
   - send `region` in the game-start and rejoin messages;
   - check `liveMatchOf` on the match's region.
4. **Match room:** accept `lobbyIsRemote`, and send every lobby call through a `callLobby` helper.
5. **Pages:**
   - load `/regions.js` before the connection script;
   - lobby: measure and send pings, and add `&srv=` to the match link;
   - match page: connect to the `&srv` region (by name only), with every extra socket on the same server.
6. Copy the unit test, and run a local three-server test before switching it on.
