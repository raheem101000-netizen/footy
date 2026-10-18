# FOOTY — 1v1 online head football

Real-cash 1v1 head football for tenten.run. Same lobby, seats, prizes, entry
fees, walkover rules, rematch and auto-credit as Pong multiplayer (pong-claus);
the match itself is the Big Head Cup engine running on the server.

- `server/src/footy/sim.ts` — the match: planck (Box2D) at the original 30 fps,
  1 minute, golden goal if level. Server-authoritative: pages send keys only.
- `server/src/rooms/GameRoom.ts` — one match: account seats, presence,
  walkover (away 30 s), no-show walkover (paid, 90 s), quit = instant loss,
  credit `footymp:<roomId>` once, rematch through the lobby.
- `server/src/rooms/LobbyRoom.ts` — Pong's lobby (rooms, $5 / $10 / both,
  Ready = pay when entry fees are on, 3-minute payment window, Refund Balance).
- `client/public/rooms.html` — lobby page; `client/public/footy-match.html` — match page.

## Render

Build `npm run build`, start `npm start`, Node 20.11.0 (render.yaml).

Environment:
- `DATABASE_URL` — the shared Neon database (same as Pong)
- `BASE_URL` — this service's URL (Stripe return links)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — new-room alerts
- `ENTRY_FEES_ENABLED=true` + `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` — entry fees (off until set);
  Stripe webhook endpoint: `<BASE_URL>/stripe/webhook`
- `FOOTYMP_PAYOUTS_ENABLED=false` — turns win credits off (on when unset)

On first start the server adds `footy` to the game list of the shared
`match_payments` and `settled_matches` tables (the other games are unaffected).

tenten.run's FOOTY button hands the login over the same way as Pong:
`/rooms.html#token=…&player_id=…&name=…`.
