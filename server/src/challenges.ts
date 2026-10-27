import type { PoolClient } from "pg";
import { pool } from "./db";

/**
 * Open challenges — the data layer (Stage 1). A challenge is a row that
 * outlives any server restart; the lobby room is only a temporary copy while
 * someone is in it. Nothing calls these functions yet: the lobby is wired in
 * Stage 2.
 *
 * Shared table: Pong will use the same two tables with GAME = 'pong' (same
 * DDL, created idempotently by whichever service starts first, behind the
 * shared migration lock — like settledMatches.ts).
 *
 * Lifecycle (every transition is one guarded UPDATE, so two servers or two
 * clicks can never both move the same row):
 *
 *   open ──claim──▶ in_match ──finish──▶ finished
 *    │  ▲              │
 *    │  └──reopen──────┘   (match didn't happen: joiner left, payment failed…)
 *    │  └──reconcile───┘   (startup: no live room for it any more)
 *    ├──cancel──▶ cancelled   (the host takes it down)
 *    └──expire──▶ expired     (14 days open without a match)
 *
 * finished / cancelled / expired are final: a trigger refuses any later UPDATE.
 * Every transition writes a challenge_events row in the same statement.
 */

export const GAME = "footy";

// The lobby's challenge hooks (rooms/LobbyRoom.ts) are all gated on this:
// unset / anything but "true" = the lobby behaves exactly as before, and no
// challenge row is ever written.
export function challengesEnabled(): boolean {
  return process.env.CHALLENGES_ENABLED === "true";
}

// The lobby never waits on the database for long: a call that takes longer
// is treated as the database being unreachable.
export const DB_TIMEOUT_MS = 3_000;
export class DbTimeout extends Error {}
export function withTimeout<T>(p: Promise<T>, ms = DB_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DbTimeout(`database call took over ${ms} ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
export const NAME_MAX = 24;
export const OPEN_DAYS = 14;
const MIGRATION_LOCK = 727274;   // the shared-table migration lock

export type ChallengeStatus = "open" | "in_match" | "finished" | "cancelled" | "expired";
export const FINAL_STATUSES: ChallengeStatus[] = ["finished", "cancelled", "expired"];

export interface Challenge {
  id: number;
  game: string;
  host_user_id: number;
  name: string;
  prize_key: string;
  entry_cents: number;
  prize_cents: number;
  status: ChallengeStatus;
  joiner_user_id: number | null;
  room_code: string | null;
  match_key: string | null;
  close_reason: string | null;
  reopen_count: number;
  created_at: Date;
  opened_at: Date;
  expires_at: Date;
  joined_at: Date | null;
  closed_at: Date | null;
}

export async function migrateChallenges() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS challenges (
        id              SERIAL PRIMARY KEY,
        game            TEXT NOT NULL CHECK (game IN ('pong','footy')),
        host_user_id    INTEGER NOT NULL REFERENCES users(id),
        name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND ${NAME_MAX} AND name = btrim(name)),
        prize_key       TEXT NOT NULL CHECK (char_length(prize_key) BETWEEN 1 AND 16),
        entry_cents     INTEGER NOT NULL CHECK (entry_cents >= 0),
        prize_cents     INTEGER NOT NULL CHECK (prize_cents > 0),
        status          TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','in_match','finished','cancelled','expired')),
        joiner_user_id  INTEGER REFERENCES users(id),
        room_code       TEXT,
        match_key       TEXT,
        close_reason    TEXT,
        reopen_count    INTEGER NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '${OPEN_DAYS} days',
        joined_at       TIMESTAMPTZ,
        closed_at       TIMESTAMPTZ,
        -- the shape each status must have
        CONSTRAINT challenges_open_shape     CHECK (status <> 'open'     OR (joiner_user_id IS NULL AND joined_at IS NULL)),
        CONSTRAINT challenges_in_match_shape CHECK (status <> 'in_match' OR (joiner_user_id IS NOT NULL AND joined_at IS NOT NULL)),
        CONSTRAINT challenges_finished_shape CHECK (status <> 'finished' OR (joiner_user_id IS NOT NULL AND match_key IS NOT NULL)),
        CONSTRAINT challenges_closed_iff_final CHECK ((status IN ('finished','cancelled','expired')) = (closed_at IS NOT NULL)),
        CONSTRAINT challenges_not_self       CHECK (joiner_user_id IS NULL OR joiner_user_id <> host_user_id),
        CONSTRAINT challenges_expiry_after_open CHECK (expires_at > opened_at)
      )
    `);
    // One live challenge per host per game — the guard against duplicates.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS challenges_one_live_per_host
        ON challenges (host_user_id, game) WHERE status IN ('open','in_match')`);
    // The lobby list (newest open first) and the expiry sweep.
    await client.query(`CREATE INDEX IF NOT EXISTS challenges_open_by_game ON challenges (game, opened_at DESC) WHERE status = 'open'`);
    await client.query(`CREATE INDEX IF NOT EXISTS challenges_open_expiry ON challenges (expires_at) WHERE status = 'open'`);
    // Startup reconcile looks at a game's in-match rows.
    await client.query(`CREATE INDEX IF NOT EXISTS challenges_in_match_by_game ON challenges (game) WHERE status = 'in_match'`);
    // A settled match belongs to at most one challenge.
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS challenges_match_key_key ON challenges (match_key) WHERE match_key IS NOT NULL`);

    // Final statuses never change again — enforced by the database, not just by
    // the WHERE clauses below.
    await client.query(`
      CREATE OR REPLACE FUNCTION challenges_final_guard() RETURNS trigger AS $$
      BEGIN
        IF OLD.status IN ('finished','cancelled','expired') THEN
          RAISE EXCEPTION 'challenge % is % (final) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'challenges_final_guard') THEN
        CREATE TRIGGER challenges_final_guard BEFORE UPDATE ON challenges
          FOR EACH ROW EXECUTE FUNCTION challenges_final_guard();
      END IF;
    END $$`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS challenge_events (
        id            SERIAL PRIMARY KEY,
        challenge_id  INTEGER NOT NULL REFERENCES challenges(id),
        event         TEXT NOT NULL
                        CHECK (event IN ('created','claimed','reopened','reconciled','finished','cancelled','expired')),
        user_id       INTEGER,
        detail        JSONB,
        at            TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS challenge_events_by_challenge ON challenge_events (challenge_id, at)`);
    await client.query("COMMIT");
    console.log("[challenges] tables ready");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[challenges] migration failed — open challenges are unavailable until this is fixed:", e);
  } finally {
    client.release();
  }
}

type Queryable = Pick<PoolClient, "query">;
const one = (rows: any[]): Challenge | null => (rows.length ? rows[0] : null);

// Runs `update` (a single UPDATE … RETURNING *) and writes one event per row
// it changed, in the same statement — the event exists iff the transition did.
async function transition(db: Queryable, update: string, params: any[], event: string, userIdParam: string, detailParam: string) {
  const { rows } = await db.query(
    `WITH c AS (${update}),
          e AS (INSERT INTO challenge_events (challenge_id, event, user_id, detail)
                SELECT c.id, '${event}', ${userIdParam}, ${detailParam} FROM c)
     SELECT * FROM c`,
    params
  );
  return rows as Challenge[];
}

export type CreateResult =
  | { ok: true; challenge: Challenge }
  | { ok: false; reason: "bad_name" | "bad_prize" | "already_live" };

/** Host posts a challenge. One live (open / in_match) per host per game. */
export async function createChallenge(
  opts: { hostUserId: number; name: string; prizeKey: string; entryCents: number; prizeCents: number },
  db: Queryable = pool
): Promise<CreateResult> {
  const name = String(opts.name || "").trim();
  if ([...name].length < 1 || [...name].length > NAME_MAX) return { ok: false, reason: "bad_name" };
  if (!opts.prizeKey || !Number.isInteger(opts.entryCents) || opts.entryCents < 0
      || !Number.isInteger(opts.prizeCents) || opts.prizeCents <= 0) return { ok: false, reason: "bad_prize" };
  try {
    const { rows } = await db.query(
      `WITH c AS (
         INSERT INTO challenges (game, host_user_id, name, prize_key, entry_cents, prize_cents)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *),
            e AS (INSERT INTO challenge_events (challenge_id, event, user_id) SELECT c.id, 'created', $2 FROM c)
       SELECT * FROM c`,
      [GAME, opts.hostUserId, name, opts.prizeKey, opts.entryCents, opts.prizeCents]
    );
    return { ok: true, challenge: rows[0] };
  } catch (e: any) {
    if (e?.code === "23505" && e?.constraint === "challenges_one_live_per_host") return { ok: false, reason: "already_live" };
    throw e;
  }
}

export type ClaimResult =
  | { ok: true; challenge: Challenge }
  | { ok: false; reason: "not_found" | "not_open" | "expired" | "own_challenge" };

/**
 * A player takes an open challenge: open → in_match in ONE guarded UPDATE.
 * Two players claiming at the same moment: Postgres row-locks the row, the
 * second UPDATE re-checks status after the first commits and matches nothing.
 */
export async function claimChallenge(id: number, joinerUserId: number, roomCode: string, db: Queryable = pool): Promise<ClaimResult> {
  const rows = await transition(db,
    `UPDATE challenges
        SET status = 'in_match', joiner_user_id = $2, joined_at = now(), room_code = $3
      WHERE id = $1 AND game = $4 AND status = 'open' AND expires_at > now() AND host_user_id <> $2
      RETURNING *`,
    [id, joinerUserId, roomCode, GAME], "claimed", "$2", "jsonb_build_object('room_code', $3::text)");
  if (rows.length) return { ok: true, challenge: rows[0] };
  // Why not — read after the fact, for the lobby's message only.
  const { rows: now } = await db.query(`SELECT status, host_user_id, expires_at <= now() AS overdue FROM challenges WHERE id = $1 AND game = $2`, [id, GAME]);
  if (!now.length) return { ok: false, reason: "not_found" };
  if (now[0].host_user_id === joinerUserId) return { ok: false, reason: "own_challenge" };
  if (now[0].status === "open" && now[0].overdue) return { ok: false, reason: "expired" };
  return { ok: false, reason: "not_open" };
}

/**
 * The match didn't happen (joiner left, payment failed, …): in_match → open,
 * the joiner cleared, a fresh 14 days on the clock, reopen_count + 1.
 */
export async function reopenChallenge(id: number, reason: string, db: Queryable = pool): Promise<Challenge | null> {
  return one(await transition(db,
    `UPDATE challenges
        SET status = 'open', joiner_user_id = NULL, joined_at = NULL, room_code = NULL,
            opened_at = now(), expires_at = now() + interval '${OPEN_DAYS} days', reopen_count = reopen_count + 1
      WHERE id = $1 AND game = $3 AND status = 'in_match'
      RETURNING *`,
    [id, reason, GAME], "reopened", "NULL", "jsonb_build_object('reason', $2::text)"));
}

/**
 * Undo a claim that never turned into a seat (the room filled, closed or the
 * joiner's connection went while the claim was in flight): in_match → open
 * exactly as it was — same clock, same reopen_count (nobody actually joined).
 * Only that joiner's claim.
 */
export async function unclaimChallenge(id: number, joinerUserId: number, reason: string, db: Queryable = pool): Promise<Challenge | null> {
  return one(await transition(db,
    `UPDATE challenges
        SET status = 'open', joiner_user_id = NULL, joined_at = NULL, room_code = NULL
      WHERE id = $1 AND game = $4 AND status = 'in_match' AND joiner_user_id = $2
      RETURNING *`,
    [id, joinerUserId, reason, GAME], "reopened", "$2::int", "jsonb_build_object('reason', $3::text, 'undo', true)"));
}

/** The match was played and settled: in_match → finished (final). */
export async function finishChallenge(id: number, matchKey: string, db: Queryable = pool): Promise<Challenge | null> {
  return one(await transition(db,
    `UPDATE challenges
        SET status = 'finished', match_key = $2, close_reason = 'played', closed_at = now()
      WHERE id = $1 AND game = $3 AND status = 'in_match'
      RETURNING *`,
    [id, matchKey, GAME], "finished", "NULL", "jsonb_build_object('match_key', $2::text)"));
}

/**
 * Take an open challenge down: open → cancelled (final). With byUserId, only
 * that user's own challenge (the host); without it (admin/system), any.
 */
export async function cancelChallenge(id: number, reason: string, byUserId: number | null = null, db: Queryable = pool): Promise<Challenge | null> {
  return one(await transition(db,
    `UPDATE challenges
        SET status = 'cancelled', close_reason = $2, closed_at = now()
      WHERE id = $1 AND game = $4 AND status = 'open' AND ($3::int IS NULL OR host_user_id = $3)
      RETURNING *`,
    [id, reason, byUserId, GAME], "cancelled", "$3::int", "jsonb_build_object('reason', $2::text)"));
}

/** Sweep: every open challenge of this game past expires_at → expired (final). */
export async function expireChallenges(db: Queryable = pool): Promise<Challenge[]> {
  return transition(db,
    `UPDATE challenges
        SET status = 'expired', close_reason = 'expired', closed_at = now()
      WHERE game = $1 AND status = 'open' AND expires_at <= now()
      RETURNING *`,
    [GAME], "expired", "NULL", "NULL");
}

/**
 * Startup: an in_match challenge whose room is gone (the server restarted
 * mid-match) goes back to open. liveRoomCodes = the rooms this server still
 * has. Not a reopen: the host did nothing, so expires_at and reopen_count
 * stay as they were (an overdue one is then caught by expireChallenges).
 */
export async function reconcileChallenges(liveRoomCodes: string[], db: Queryable = pool): Promise<Challenge[]> {
  return transition(db,
    `UPDATE challenges
        SET status = 'open', joiner_user_id = NULL, joined_at = NULL, room_code = NULL
      WHERE game = $1 AND status = 'in_match' AND (room_code IS NULL OR NOT (room_code = ANY($2::text[])))
      RETURNING *`,
    [GAME, liveRoomCodes], "reconciled", "NULL", "NULL");
}

export interface OpenChallenge extends Challenge { host_display_name: string | null }

/** The lobby list: this game's open, unexpired challenges, newest first. */
export async function listOpenChallenges(limit = 100, db: Queryable = pool): Promise<OpenChallenge[]> {
  const { rows } = await db.query(
    `SELECT c.*, u.display_name AS host_display_name
       FROM challenges c JOIN users u ON u.id = c.host_user_id
      WHERE c.game = $1 AND c.status = 'open' AND c.expires_at > now()
      ORDER BY c.opened_at DESC
      LIMIT $2`,
    [GAME, Math.max(1, Math.min(500, limit))]
  );
  return rows;
}
