import express, { type Application, type Request, type Response, type NextFunction } from "express";
import { matchMaker } from "@colyseus/core";
import { createHash, timingSafeEqual } from "crypto";
import { issueLaunchTicket } from "./launchTickets";

/**
 * Multi-region match servers (docs/MULTI_REGION.md). One website and one
 * lobby (the HOME server); several servers that host matches. When both
 * players are ready, the lobby starts the match on the region that is best
 * and most equal for the two of them, from the pings each page measured.
 *
 * Switched on only by config — all four set and valid:
 *   FOOTY_REGIONS        {"name": "https://url", ...} — every server, home included
 *   FOOTY_HOME_REGION    the home server's name (keeps the lobby, pages, Stripe)
 *   FOOTY_REGION         this server's own name
 *   FOOTY_REGION_SECRET  shared secret (16+ chars) for server-to-server calls
 * Anything else: one server, exactly as before (a warning if it was half set).
 */

export interface RegionConfig {
  regions: Record<string, string>;   // name → base URL (no trailing slash)
  home: string;
  self: string;
  secret: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SECRET_HEADER = "x-footy-region-secret";
// A region that doesn't answer in this long isn't used: the match starts on home.
export const REGION_CREATE_TIMEOUT_MS = 6_000;

let parsed = false;
let config: RegionConfig | null = null;

function parseConfig(env: NodeJS.ProcessEnv): RegionConfig | null {
  const raw = env.FOOTY_REGIONS, home = env.FOOTY_HOME_REGION, self = env.FOOTY_REGION, secret = env.FOOTY_REGION_SECRET;
  if (!raw && !home && !self && !secret) return null;   // not configured: one server, no warning
  const bad = (why: string): null => { console.warn(`[regions] multi-region OFF — ${why}. Running as a single server.`); return null; };
  let obj: unknown;
  try { obj = JSON.parse(raw || ""); } catch { return bad("FOOTY_REGIONS is not valid JSON"); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return bad('FOOTY_REGIONS must be a JSON object {"name": "https://url"}');
  const regions: Record<string, string> = {};
  for (const [name, url] of Object.entries(obj as Record<string, unknown>)) {
    if (!NAME_RE.test(name)) return bad(`region name "${name}" must be lowercase letters, digits or dashes`);
    if (typeof url !== "string" || !/^https?:\/\/[^/\s]+/.test(url)) return bad(`region "${name}" needs an http(s) URL`);
    regions[name] = url.replace(/\/+$/, "");
  }
  if (Object.keys(regions).length < 2) return bad("FOOTY_REGIONS needs at least two servers");
  if (!home || !regions[home]) return bad(`FOOTY_HOME_REGION "${home || ""}" is not in FOOTY_REGIONS`);
  if (!self || !regions[self]) return bad(`FOOTY_REGION "${self || ""}" is not in FOOTY_REGIONS`);
  if (!secret || secret.length < 16) return bad("FOOTY_REGION_SECRET must be at least 16 characters");
  return { regions, home, self, secret };
}

/** The multi-region config, or null when this is a single server. */
export function multiRegion(): RegionConfig | null {
  if (!parsed) {
    parsed = true;
    config = parseConfig(process.env);
    if (config) console.log(`[regions] multi-region ON — this server is "${config.self}" (${config.self === config.home ? "home: lobby + matches" : "matches only"}); regions: ${Object.keys(config.regions).join(", ")}`);
  }
  return config;
}

/** True on the home server, and on a single server (which is its own home). */
export function isHomeServer(): boolean {
  const c = multiRegion();
  return !c || c.self === c.home;
}

/** Served as /regions.js: region names → URLs, for the pages ({} when single-server). */
export function regionsClientScript(): string {
  const c = multiRegion();
  return `window.FOOTY_REGIONS = ${JSON.stringify(c ? c.regions : {})};\nwindow.FOOTY_HOME_REGION = ${JSON.stringify(c ? c.home : null)};\n`;
}

// ── The fair pick ─────────────────────────────────────────────────────────────

export type Pings = Record<string, number>;   // region → round-trip ms, as the page measured it

export interface RegionPick { region: string; why: "fair" | "host-best" | "home"; score?: number; }

/**
 * The region for a match between A and B. Among the regions BOTH measured:
 *   score = max(pingA, pingB) + |pingA − pingB| / 2   → lowest wins
 * (the slower player's ping, plus half the gap — a region that is good for
 * one and bad for the other loses to one that is fair to both). Ties: lower
 * total, then home, then name. No region in common → the host's best region
 * → else home. Only names in `regions` are ever returned.
 */
export function pickRegion(a: Pings | undefined, b: Pings | undefined, host: Pings | undefined, regions: string[], home: string): RegionPick {
  const ok = (p: Pings | undefined, r: string) => !!p && typeof p[r] === "number" && Number.isFinite(p[r]);
  const shared = regions.filter(r => ok(a, r) && ok(b, r));
  if (shared.length) {
    const scored = shared.map(r => {
      const pa = a![r], pb = b![r];
      return { r, score: Math.max(pa, pb) + Math.abs(pa - pb) / 2, sum: pa + pb };
    });
    scored.sort((x, y) => x.score - y.score || x.sum - y.sum || Number(y.r === home) - Number(x.r === home) || x.r.localeCompare(y.r));
    return { region: scored[0].r, why: "fair", score: scored[0].score };
  }
  const mine = regions.filter(r => ok(host, r)).sort((x, y) => host![x] - host![y] || x.localeCompare(y));
  if (mine.length) return { region: mine[0], why: "host-best" };
  return { region: home, why: "home" };
}

/** A page's 'lobby:pings' message, cleaned: known regions only, sane numbers. */
export function cleanPings(data: unknown): Pings | null {
  const c = multiRegion();
  if (!c || !data || typeof data !== "object") return null;
  const out: Pings = {};
  for (const name of Object.keys(c.regions)) {
    const ms = Number((data as any)[name]);
    if (Number.isFinite(ms) && ms >= 0 && ms <= 10_000) out[name] = Math.round(ms);
  }
  return Object.keys(out).length ? out : null;
}

/** "ohio 20 / oregon 60" — for the launch log. */
export function pingsText(p: Pings | undefined): string {
  if (!p || !Object.keys(p).length) return "no pings";
  return Object.keys(p).sort().map(r => `${r} ${p[r]}`).join(" / ");
}

// ── Starting a match room ─────────────────────────────────────────────────────

export interface MatchOptions {
  allowedUserIds: number[];
  lobbyRoomId: string;
  agreedPrize: number;
  entriesCharged: boolean;
}

/**
 * Create the game_room on THIS server. The launch ticket is issued here, in
 * this server's memory, right before the room consumes it — tickets never
 * travel between servers.
 */
export async function createMatchHere(opts: MatchOptions, lobbyIsRemote = false): Promise<string> {
  const gameRoom = await matchMaker.createRoom("game_room", {
    launchTicket: issueLaunchTicket(), // proves this match came from a lobby, not a client
    allowedUserIds: opts.allowedUserIds,
    lobbyRoomId: opts.lobbyRoomId,     // for the rematch handshake
    agreedPrize: opts.agreedPrize,     // the prize both were ready on — the winner is credited this
    entriesCharged: opts.entriesCharged, // both entries paid (entry fees on)
    ...(lobbyIsRemote ? { lobbyIsRemote: true } : {}),
  });
  return gameRoom.roomId;
}

// ── Server-to-server calls ────────────────────────────────────────────────────

/** POST JSON to another region's /internal/… endpoint, with the shared secret. */
export async function regionCall(region: string, path: string, body: unknown, timeoutMs: number): Promise<any> {
  const c = multiRegion();
  if (!c || !c.regions[region]) throw new Error(`unknown region "${region}"`);
  const res = await fetch(c.regions[region] + path, {
    method: "POST",
    headers: { "content-type": "application/json", [SECRET_HEADER]: c.secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const out: any = await res.json().catch((): null => null);
  if (!res.ok) throw new Error(`${region}${path}: HTTP ${res.status}${out?.error ? " — " + out.error : ""}`);
  return out;
}

// Compared as SHA-256 digests, so the check takes the same time whatever the input.
function secretOk(got: unknown): boolean {
  const c = multiRegion();
  if (!c || typeof got !== "string" || !got) return false;
  const a = createHash("sha256").update(got).digest(), b = createHash("sha256").update(c.secret).digest();
  return timingSafeEqual(a, b);
}

function internalOnly(req: Request, res: Response, next: NextFunction) {
  if (!multiRegion()) { res.status(404).end(); return; }        // single server: these don't exist
  if (!secretOk(req.get(SECRET_HEADER))) { res.status(403).json({ error: "forbidden" }); return; }
  next();
}

// Lobby methods a regional match may call on the home lobby — nothing else.
const LOBBY_METHODS: Record<string, (args: unknown[]) => boolean> = {
  requestRematch: a => a.length === 2 && typeof a[0] === "string" && Number.isInteger(a[1]),
  matchClosed: a => a.length === 1 && typeof a[0] === "string",
};

/**
 * The routes every server gets (registered before the pages' catch-all):
 *   GET  /ping                   tiny, CORS *, no-store — the pages time it
 *   GET  /regions.js             region names → URLs for the pages
 *   POST /internal/create-match  (secret) start a match room here
 *   POST /internal/match-live    (secret) is this match still being played?
 *   POST /internal/lobby-call    (secret, home only) a regional match → the lobby
 */
export function regionRoutes(app: Application) {
  app.get("/ping", (_req, res) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }).type("text/plain").send("ok");
  });

  app.get("/regions.js", (_req, res) => {
    res.type("application/javascript").set("Cache-Control", "no-cache").send(regionsClientScript());
  });

  const json = express.json({ limit: "16kb" });

  app.post("/internal/create-match", json, internalOnly, async (req, res) => {
    const b = req.body || {};
    try {
      const roomId = await createMatchHere({
        allowedUserIds: b.allowedUserIds, lobbyRoomId: String(b.lobbyRoomId || ""),
        agreedPrize: b.agreedPrize, entriesCharged: b.entriesCharged === true,
      }, true);
      res.json({ roomId });
    } catch (e: any) {
      console.error("[regions] create-match refused:", e?.message || e);
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  app.post("/internal/match-live", json, internalOnly, async (req, res) => {
    const roomId = String(req.body?.roomId || "");
    try {
      const [listing] = roomId ? await matchMaker.query({ name: "game_room", roomId }) : [];
      res.json({ live: !!listing && listing.metadata?.over === false });
    } catch (e) {
      res.json({ live: false });
    }
  });

  app.post("/internal/lobby-call", json, internalOnly, async (req, res) => {
    if (!isHomeServer()) { res.status(404).end(); return; }
    const { lobbyRoomId, method, args } = req.body || {};
    const check = typeof method === "string" ? LOBBY_METHODS[method] : undefined;
    if (typeof lobbyRoomId !== "string" || !check || !Array.isArray(args) || !check(args)) {
      res.status(400).json({ error: "not allowed" }); return;
    }
    try {
      const result = await matchMaker.remoteRoomCall(lobbyRoomId, method as any, args as any);
      res.json({ result: result ?? null });
    } catch (e: any) {
      res.status(502).json({ error: String(e?.message || e) });
    }
  });
}

/** On a regional (matches-only) server: where the lobby and pages live. null on home / single server. */
export function homeURLIfRegional(): string | null {
  const c = multiRegion();
  return c && c.self !== c.home ? c.regions[c.home] : null;
}
