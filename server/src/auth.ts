import { ServerError } from "@colyseus/core";
import { createHash, timingSafeEqual } from "crypto";
import { pool } from "./db";

/**
 * Login handoff, same as Pong multiplayer: tenten.run's /api/token?action=generate
 * reads the logged-in session cookie and inserts a game_tokens row; the
 * homepage's FOOTY button then carries {token, player_id} to the lobby.
 *
 * Like Pong's later calls (match-config, record-win, checkout), the token is
 * checked as `token AND user_id` and NOT consumed — Pong reuses it for the
 * lobby join, the match-room join and any rejoin. Unlike Pong, it's bounded:
 * game_tokens.expires_at is only the 60s window for the one-time verify step,
 * so age is checked against created_at instead (both are `timestamp without
 * time zone` written with the DB session's now(), hence LOCALTIMESTAMP).
 */
export const TOKEN_MAX_AGE_HOURS = 12;

export interface FootyAuth {
  userId: number;
  displayName: string;
  testBot?: boolean;
}

/**
 * Test bots (for automated test matches on the live server): two fixed players,
 * "Test Bot A" (-1) and "Test Bot B" (-2), logged in with a secret key. Only the
 * key's SHA-256 is here, so the key can't be read from the code. Bots are kept
 * apart from real players (LobbyRoom: their rooms are hidden, they can't join
 * real rooms and real players can't join theirs) and nothing about them is ever
 * paid or credited (no entry fees, no win credit, no database rows).
 */
const TEST_BOT_KEY_SHA256 = "6acf3c3367ea68d2193de0185d9ac0146fd5f84ba8eb490f0077ea6dbcac7e6b";
export const isTestBot = (userId: number) => userId === -1 || userId === -2;
function testBotKeyOk(key: string): boolean {
  const got = createHash("sha256").update(key).digest(), want = Buffer.from(TEST_BOT_KEY_SHA256, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function authenticateGameToken(token: unknown, playerId: unknown): Promise<FootyAuth> {
  const userId = Number(playerId);
  if (typeof token === "string" && token.startsWith("testbot:")) {
    if (isTestBot(userId) && testBotKeyOk(token.slice(8))) return { userId, displayName: userId === -1 ? "Test Bot A" : "Test Bot B", testBot: true };
    throw new ServerError(401, "Log in on tenten.run to play");
  }
  if (typeof token !== "string" || !token || !Number.isInteger(userId) || userId <= 0) {
    throw new ServerError(401, "Log in on tenten.run to play");
  }
  const result = await pool.query(
    `SELECT u.id, u.display_name
       FROM game_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token = $1 AND t.user_id = $2
        AND t.created_at > LOCALTIMESTAMP - make_interval(hours => $3)`,
    [token, userId, TOKEN_MAX_AGE_HOURS]
  );
  if (!result.rows.length) {
    throw new ServerError(401, "Your login has expired — go back to tenten.run and press PLAY on FOOTY again");
  }
  return { userId: result.rows[0].id, displayName: result.rows[0].display_name };
}
