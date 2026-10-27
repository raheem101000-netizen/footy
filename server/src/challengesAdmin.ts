import express, { type Application, type Request, type Response } from "express";
import { matchMaker } from "@colyseus/core";
import { timingSafeEqual } from "crypto";
import { isHomeServer, multiRegion, regionCall } from "./regions";
import { listInMatchChallenges, releaseStuckChallenge, InMatchChallenge } from "./challenges";

/**
 * Admin: stuck open challenges. Reconcile isn't wired (multi-region: a match
 * can be live where this server can't see it), so an in_match challenge whose
 * room went with a home-server restart stays in_match — no Cancel, no expiry,
 * and its host can't make a new one. These two calls let admin free it, by id:
 *
 *   GET  /admin/challenges/stuck?key=…        every in_match challenge, split
 *        into `stuck` (nothing here holds it) and `live` (with the reasons)
 *   POST /admin/challenges/release?key=…  {id, ignore_warnings?, note?}
 *        in_match → open (fresh 14 days). Refused (409) if it looks live;
 *        refused if it has warnings unless ignore_warnings is true.
 *
 * Home server only (the lobby is there). Key: ADMIN_KEY env, the same value as
 * tenten.run's — no fallback; unset or short = every call refused (503).
 */

const ADMIN_KEY_MIN_LENGTH = 32;
// A claim this recent may still be held by the other server during a deploy.
const RECENT_CLAIM_MS = 15 * 60_000;

function adminGate(req: Request, res: Response): boolean {
  const key = process.env.ADMIN_KEY || "";
  if (key.length < ADMIN_KEY_MIN_LENGTH) {
    console.error("[admin] ADMIN_KEY is not set (or too short) — refused");
    res.status(503).json({ error: "Admin is not configured" }); return false;
  }
  const given = req.get("x-admin-key") ?? req.query.key;
  const a = Buffer.from(typeof given === "string" ? given : ""), b = Buffer.from(key);
  if (a.length !== b.length || !timingSafeEqual(a, b)) { res.status(401).json({ error: "Unauthorized" }); return false; }
  return true;
}

interface Assessment { live: string[]; warnings: string[] }

// Everything this server can see that says the challenge may still be in use.
// Read-only: looks at every lobby_room instance here (their rooms are in memory)
// and asks a match's region whether it's still being played.
async function assess(rows: InMatchChallenge[]): Promise<{ lobbies: number; out: Map<number, Assessment> }> {
  const lobbies: any[] = [];
  for (const l of await matchMaker.query({ name: "lobby_room" })) {
    const room = matchMaker.getLocalRoomById(l.roomId);
    if (room) lobbies.push(room);
  }
  const cfg = multiRegion();
  const out = new Map<number, Assessment>();
  for (const c of rows) {
    const a: Assessment = { live: [], warnings: [] };
    for (const lobby of lobbies) {
      const rooms: Record<string, any> = lobby.lobbyRooms || {};
      for (const r of Object.values(rooms)) {
        if (r.challenge?.id === c.id) a.live.push(`lobby room ${r.code} holds this challenge`);
      }
      if (c.room_code && rooms[c.room_code] && rooms[c.room_code].challenge?.id !== c.id) {
        a.live.push(`lobby room ${c.room_code} (the challenge's room) still exists${rooms[c.room_code].matchId ? ` — match ${rooms[c.room_code].matchId} launched from it` : ""}`);
      }
      for (const userId of [c.host_user_id, c.joiner_user_id]) {
        const matchId: string | undefined = userId ? lobby.userMatch?.get(userId) : undefined;
        if (!matchId) continue;
        const region: string | null = lobby.matchRegion?.get(matchId) || null;
        if (cfg && region && region !== cfg.self) {
          try {
            const r = await regionCall(region, "/internal/match-live", { roomId: matchId }, 4_000);
            if (r?.live === true) a.live.push(`account ${userId} is in match ${matchId}, live on ${region}`);
          } catch (e: any) {
            a.live.push(`account ${userId} was sent to match ${matchId} on ${region}, which can't be reached — treated as live`);
          }
        } else {
          const [listing] = await matchMaker.query({ name: "game_room", roomId: matchId });
          if (listing && listing.metadata?.over === false) a.live.push(`account ${userId} is in match ${matchId}, live here`);
        }
      }
    }
    if (c.played_match_key) a.warnings.push(`a HEDDY match between host and opponent was settled after the claim (${c.played_match_key}) — it was probably played; releasing reopens it`);
    if (c.joined_at && Date.now() - new Date(c.joined_at).getTime() < RECENT_CLAIM_MS) {
      a.warnings.push("claimed less than 15 minutes ago — during a deploy the old server may still hold its room");
    }
    out.set(c.id, a);
  }
  return { lobbies: lobbies.length, out };
}

const view = (c: InMatchChallenge, a: Assessment) => ({
  id: c.id, name: c.name, prize_key: c.prize_key,
  host: { user_id: c.host_user_id, name: c.host_display_name },
  opponent: { user_id: c.joiner_user_id, name: c.joiner_display_name },
  room_code: c.room_code, joined_at: c.joined_at, opened_at: c.opened_at, expires_at: c.expires_at,
  reopen_count: c.reopen_count, live_reasons: a.live, warnings: a.warnings,
});

export function challengeAdminRoutes(app: Application) {
  const json = express.json({ limit: "4kb" });

  app.get("/admin/challenges/stuck", async (req, res) => {
    if (!isHomeServer()) { res.status(404).end(); return; }
    if (!adminGate(req, res)) return;
    try {
      const rows = await listInMatchChallenges();
      const { lobbies, out } = await assess(rows);
      res.set("Cache-Control", "no-store").json({
        lobbies_checked: lobbies,
        stuck: rows.filter(c => !out.get(c.id)!.live.length).map(c => view(c, out.get(c.id)!)),
        live: rows.filter(c => out.get(c.id)!.live.length).map(c => view(c, out.get(c.id)!)),
      });
    } catch (e: any) {
      console.error("[admin] stuck challenges list failed:", e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.post("/admin/challenges/release", json, async (req, res) => {
    if (!isHomeServer()) { res.status(404).end(); return; }
    if (!adminGate(req, res)) return;
    const id = req.body?.id;
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Give the challenge's id (a number) — nothing is released without one" }); return; }
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 200) : null;
    try {
      const c = (await listInMatchChallenges()).find(r => r.id === id);
      if (!c) { res.status(409).json({ error: `Challenge ${id} is not in_match — nothing to release` }); return; }
      const a = (await assess([c])).out.get(id)!;
      if (a.live.length) { res.status(409).json({ error: "This challenge looks live — not released", live_reasons: a.live }); return; }
      if (a.warnings.length && req.body?.ignore_warnings !== true) {
        res.status(409).json({ error: "Check the warnings; send ignore_warnings: true to release anyway", warnings: a.warnings }); return;
      }
      const row = await releaseStuckChallenge(id, note);
      if (!row) { res.status(409).json({ error: `Challenge ${id} changed meanwhile — not released` }); return; }
      console.log(`[admin] challenge ${id} released by admin: in_match → open (opponent was account ${c.joiner_user_id}, room ${c.room_code})${a.warnings.length ? " — warnings ignored: " + a.warnings.join("; ") : ""}`);
      res.json({ released: { id: row.id, status: row.status, opened_at: row.opened_at, expires_at: row.expires_at }, warnings_ignored: a.warnings });
    } catch (e: any) {
      console.error(`[admin] release of challenge ${id} failed:`, e);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });
}
