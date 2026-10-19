import { Room, Client, matchMaker } from "@colyseus/core";
import { authenticateGameToken, FootyAuth } from "../auth";
import { consumeLaunchTicket } from "../launchTickets";
import { creditFootyWin } from "../payouts";
import { Prize, asPrize, prizeAmount, entryFeeFor } from "../prizes";
import { createSim, FootySim, Side, NO_KEYS } from "../footy/sim";

// The match runs here, on the server, at the original game's 30 frames a
// second (footy/sim.ts), and every frame goes to both players. The pages
// only send which keys are down — neither browser decides a goal or a result.
const FRAME_MS = 1000 / 30;
// Local tests only: delay every key message and every frame by this much, to feel a slow connection.
const TEST_LAG_MS = Number(process.env.FOOTY_TEST_LAG_MS) || 0;
const TEST_JITTER_MS = Number(process.env.FOOTY_TEST_JITTER_MS) || 0;   // random extra delay, in order (like a real uneven connection)
// Per seat (local tests only): FOOTY_TEST_SEAT_LAG="40,10" FOOTY_TEST_SEAT_JITTER="20,0" — seat 0 (host) far, seat 1 near.
const SEAT_LAG = (process.env.FOOTY_TEST_SEAT_LAG || '').split(',').map(Number);
const SEAT_JIT = (process.env.FOOTY_TEST_SEAT_JITTER || '').split(',').map(Number);
const testLast: Record<string, number> = {};
// Hold fn back like a slow connection would, keeping order per path (key: which player and direction).
const later = (fn: () => void, seat = -1, dir = 'x') => {
  const lag = seat >= 0 && SEAT_LAG[seat] ? SEAT_LAG[seat] : TEST_LAG_MS;
  const jit = seat >= 0 && SEAT_JIT[seat] ? SEAT_JIT[seat] : TEST_JITTER_MS;
  if (!lag && !jit) { fn(); return; }
  const key = seat + dir, now = Date.now(), at = Math.max(testLast[key] || 0, now + lag + Math.random() * jit);
  testLast[key] = at; setTimeout(fn, at - now);
};
const PER_SEAT_TEST = SEAT_LAG.some(n => n > 0) || SEAT_JIT.some(n => n > 0);

// ── Account-owned seats (same model as Pong's GameRoom / FIFA's FifaRoom) ────
// A match seat belongs to the account: the same account on a new connection
// (reload, new tab, bfcache, a drop the server never saw) takes its player
// back. Presence comes from the page's "hb" heartbeat (~5 s), not Colyseus
// pings. The room stays open while any seat is held, so a finished match can
// always be reported to a player who comes back. Env overrides: tests only.
const AWAY_AFTER_MS     = Number(process.env.FOOTY_AWAY_AFTER_MS) || 15_000;
// A player away this long during play hands the opponent who is still there
// the win (walkover — same endMatch/credit path).
const WALKOVER_AFTER_MS = Number(process.env.FOOTY_WALKOVER_AFTER_MS) || 30_000;
// Seats are held this long with nobody present; then the room closes.
const MATCH_SEAT_HOLD_MS = Number(process.env.FOOTY_MATCH_SEAT_HOLD_MS) || 20 * 60_000;
// A dropped connection that still holds a seat may resume itself (same
// session) for this long; after that the page rejoins by account.
const MATCH_RESUME_SECONDS = Number(process.env.FOOTY_MATCH_RESUME_SECONDS) || 60;
// A connection replaced by a newer one is cut off after this long.
const RETIRED_CUTOFF_MS = 1_000;
// Paid matches (both entries charged): a player who paid but never joins the
// match room within this long loses to the one who did (walkover).
const NO_SHOW_AFTER_MS = Number(process.env.FOOTY_NO_SHOW_AFTER_MS) || 90_000;
// Once decided, close after nobody has been here this long.
const MATCH_DONE_LINGER_MS = 15 * 60_000;
// Hard cap on a match room's life.
const MATCH_MAX_AGE_MS = 4 * 60 * 60_000;
const SWEEP_MS = 2_000;

interface PlayerSlot { sessionId: string; bid: string | null; name: string; userId: number; connected: boolean; lastSeen: number; away: boolean; awaySince: number; }

// Seat 0 ('p1') plays on the left, seat 1 ('p2') on the right. Each page
// draws itself on the right in blue (the left player's page is mirrored).
const SIDE_OF = (idx: number): Side => (idx === 0 ? 'L' : 'R');

export class GameRoom extends Room {
  // Two seats, with spare connection headroom so a player's own replacement
  // connection is never refused as "full".
  maxClients = 10;
  // Closed by the presence sweep once no seat is held, not when it empties.
  autoDispose = false;

  private gameJoined: PlayerSlot[] = [];
  private sim: FootySim | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private allowedUserIds: number[] = [];
  private matchSettled = false;
  // What a player who comes back after the match ended is shown (display
  // only — the result and payout were already decided).
  private finalResult: any = null;
  private creditResult: { userId: number; state: { status: string; amount?: string } } | null = null;
  // Play was stopped because both players were gone (no one to award).
  private abandoned = false;
  private entriesCharged = false;   // both players paid their entry (entryPayments.ts)
  private lobbyRoomId: string | null = null;
  // The prize both players were ready on when the lobby launched this match.
  private agreedPrize: Prize = 5;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private lastPresentAt = Date.now();
  private createdAt = Date.now();
  private held = new Map<string, { reject: (e?: any) => void }>(); // pending token resumes, by connection

  static async onAuth(token: string, options: any) {
    return authenticateGameToken(token, options?.playerId);
  }

  onCreate(options: any) {
    // Only the lobby may start a match room (launchTickets.ts), for exactly
    // the two accounts that were in the lobby room.
    if (!consumeLaunchTicket(options?.launchTicket)) {
      throw new Error("Matches can only be started from a lobby");
    }
    const ids = Array.isArray(options?.allowedUserIds) ? options.allowedUserIds : [];
    if (ids.length !== 2 || new Set(ids).size !== 2 || !ids.every((n: unknown) => Number.isInteger(n))) {
      throw new Error("A match needs exactly two different players");
    }
    this.allowedUserIds = ids;
    const agreed = asPrize(options?.agreedPrize);
    if (!agreed) throw new Error("A match needs an agreed prize");
    this.agreedPrize = agreed;
    this.lobbyRoomId = typeof options?.lobbyRoomId === 'string' ? options.lobbyRoomId : null;
    this.entriesCharged = options?.entriesCharged === true;
    this.setMetadata({ over: false });
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);

    this.onMessage("joinRoom", (client: Client, data: { code?: string; name?: string; bid?: string }) => {
      // Identity comes from the login token (onAuth), never from the client.
      const auth = client.auth as FootyAuth;
      const name = auth.displayName || 'Player';
      const bid = data?.bid || null;

      // Reconnect / reload / second tab: the same account takes its existing
      // seat back; a different connection that held it is told and let go.
      const prior = this.gameJoined.find(p => p.userId === auth.userId) || null;
      if (prior) {
        const old = prior.sessionId;
        if (old !== client.sessionId) {
          const oldClient = this.clients.find(c => c.sessionId === old);
          if (oldClient) {
            oldClient.send('superseded', { message: 'You opened this match somewhere else.' });
            oldClient.leave(4000);
            setTimeout(() => {
              if (this.clients.find(c => c.sessionId === old)) { try { (oldClient as any).ref?.terminate?.(); } catch (_) {} }
            }, RETIRED_CUTOFF_MS);
          }
          const h = this.held.get(old);
          if (h) { this.held.delete(old); h.reject(false); }
        }
        prior.sessionId = client.sessionId;
        prior.connected = true;
        this.touch(prior);
        const idx = this.gameJoined.indexOf(prior);
        this.sendJoined(client, idx, name);
        const other = this.gameJoined[idx === 0 ? 1 : 0];
        if (other) client.send('opponentName', { name: other.name });
        this.sendPresence(client);
        // Back after the match was decided without them: show the result.
        if (this.finalResult || this.abandoned) this.markResultSeen(auth.userId);
        if (this.finalResult) {
          client.send('matchEnd', { ...this.finalResult, rejoined: true });
          if (this.creditResult && this.creditResult.userId === auth.userId) client.send('footymp:credit', this.creditResult.state);
          if (this.rematchAvailable()) client.send('rematch:available', {});
        } else if (this.abandoned) {
          client.send('opponentLeft');
        }
        return;
      }

      if (this.gameJoined.find(p => p.sessionId === client.sessionId)) return;
      if (this.gameJoined.length >= 2) return;

      this.gameJoined.push({ sessionId: client.sessionId, bid, name, userId: auth.userId, connected: true, lastSeen: Date.now(), away: false, awaySince: 0 });
      const myIndex = this.gameJoined.length - 1;
      this.sendJoined(client, myIndex, name);

      if (this.gameJoined.length === 2) {
        const p1 = this.gameJoined[0], p2 = this.gameJoined[1];
        this.clients.find(c => c.sessionId === p1.sessionId)?.send('opponentName', { name: p2.name });
        this.clients.find(c => c.sessionId === p2.sessionId)?.send('opponentName', { name: p1.name });
        this.startMatch();
      }
    });

    // Keys down: { l, r, u, k } (left, right, jump, kick), in the page's own
    // view — the left player's page is mirrored, so it sends its left/right
    // already swapped back to the pitch's.
    this.onMessage("in", (client: Client, data: any) => {
      const idx = this.gameJoined.findIndex(p => p.sessionId === client.sessionId);
      if (idx === -1) return;
      this.touch(this.gameJoined[idx]);
      if (!this.sim || this.finalResult) return;
      const keys = { left: !!data?.l, right: !!data?.r, jump: !!data?.u, kick: !!data?.k };
      later(() => { if (this.sim && !this.finalResult) this.sim.setKeys(SIDE_OF(idx), keys); }, idx, 'in');
    });

    // Quitting a live match is an instant loss (same rule as every 1v1 game).
    this.onMessage("forfeit", (client: Client) => {
      const idx = this.gameJoined.findIndex(p => p.sessionId === client.sessionId);
      if (idx === -1 || !this.sim || this.finalResult || this.gameJoined.length < 2) return;
      console.log('FORFEIT: ' + this.gameJoined[idx].name + ' quit — ' + this.gameJoined[1 - idx].name + ' wins');
      this.endMatch(idx === 0 ? 'p2' : 'p1', 'forfeit');
    });

    // Rematch (match-over screen): only once the match is decided AND its
    // credit has finished. The lobby runs the two-press handshake; a rematch
    // is a new game_room with its own 'footymp:<roomId>' credit key.
    this.onMessage("rematch", async (client: Client) => {
      const slot = this.gameJoined.find(p => p.sessionId === client.sessionId);
      if (!slot || !this.rematchAvailable() || !this.lobbyRoomId) return;
      try {
        const out: any = await matchMaker.remoteRoomCall(this.lobbyRoomId, 'requestRematch' as any, [this.roomId, slot.userId]);
        if (out && out.ok) this.broadcast('rematch:go', { byName: slot.name });
        else client.send('rematch:error', { message: out?.error || 'Rematch not possible right now' });
      } catch (e) {
        client.send('rematch:error', { message: 'Rematch not possible right now' });
      }
    });

    // Presence heartbeat (~5 s): answered so the page can spot a dead
    // connection, and keeps this account's seat present.
    this.onMessage("hb", (client: Client) => {
      client.send("hb");
      const slot = this.gameJoined.find(p => p.sessionId === client.sessionId);
      if (slot) this.touch(slot);
    });

    this.onMessage("ping", (client: Client, data: { ts: number }) => {
      const ts = data?.ts;
      const seat = this.gameJoined.findIndex(p => p.sessionId === client.sessionId);
      later(() => later(() => client.send("pong", { ts }), seat, 'out'), seat, 'in');   // test lag both ways, like the key messages and frames
    });
  }

  onJoin(_client: Client, _options: any, auth: FootyAuth) {
    if (!this.allowedUserIds.includes(auth.userId)) {
      throw new Error("You're not a player in this match");
    }
  }

  // Fast path: a dropped connection can resume the SAME session with its
  // reconnection token; the heartbeat decides presence either way.
  onDrop(client: Client) {
    const slot = this.gameJoined.find(p => p.sessionId === client.sessionId);
    if (!slot) return;
    this.markGone(slot);
    const held: any = this.allowReconnection(client, MATCH_RESUME_SECONDS);
    if (held?.reject) this.held.set(client.sessionId, held);
    const done = () => { if (this.held.get(client.sessionId) === held) this.held.delete(client.sessionId); };
    held?.then?.(done, done);
  }

  onReconnect(client: Client) {
    const slot = this.gameJoined.find(p => p.sessionId === client.sessionId);
    if (!slot) { if (this.gameJoined.length >= 2) client.leave(4000); return; }
    slot.connected = true;
    this.touch(slot);
  }

  onLeave(client: Client) {
    const slot = this.gameJoined.find(p => p.sessionId === client.sessionId);
    if (slot) this.markGone(slot);
  }

  onDispose() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.stopLoop();
    if (this.lobbyRoomId) matchMaker.remoteRoomCall(this.lobbyRoomId, 'matchClosed' as any, [this.roomId]).catch(() => {});
  }

  public entryFee(): string {
    return entryFeeFor(this.agreedPrize);
  }

  private sendJoined(client: Client, idx: number, name: string) {
    client.send('roomJoined', {
      code: this.roomId, role: idx === 0 ? 'p1' : 'p2', side: SIDE_OF(idx),
      myName: name, prize: prizeAmount(this.agreedPrize),
    });
  }

  private rematchAvailable() {
    return !!this.finalResult && !!this.creditResult && !this.abandoned;
  }

  private setOverMetadata() {
    this.setMetadata({ over: true, unseen: this.gameJoined.filter(p => p.away).map(p => p.userId) });
  }
  private markResultSeen(userId: number) {
    const unseen: number[] = (this.metadata as any)?.unseen || [];
    if (unseen.includes(userId)) this.setMetadata({ over: true, unseen: unseen.filter(id => id !== userId) });
  }

  private markGone(slot: PlayerSlot) {
    slot.connected = false;
    // Nobody is pressing keys for a player who isn't here.
    const idx = this.gameJoined.indexOf(slot);
    if (this.sim && idx >= 0) this.sim.setKeys(SIDE_OF(idx), NO_KEYS);
    if (!slot.away) { slot.away = true; slot.awaySince = Date.now(); this.sendPresence(); }
  }

  private touch(slot: PlayerSlot) {
    slot.lastSeen = Date.now();
    if (slot.away && slot.connected) { slot.away = false; slot.awaySince = 0; this.sendPresence(); }
  }

  private sendPresence(to?: Client) {
    const msg = { p1Away: !!this.gameJoined[0]?.away, p2Away: !!this.gameJoined[1]?.away };
    if (to) to.send('presence', msg); else this.broadcast('presence', msg);
  }

  // Presence check: quiet seats show as away; a player away too long during
  // play loses by walkover (or play stops if both are gone); the room closes
  // once no seat has been held for MATCH_SEAT_HOLD_MS.
  private sweep() {
    const now = Date.now();
    let changed = false;
    this.gameJoined.forEach((slot, idx) => {
      if (!slot.away && (!slot.connected || now - slot.lastSeen > AWAY_AFTER_MS)) {
        slot.away = true; slot.awaySince = now; changed = true;
        if (this.sim) this.sim.setKeys(SIDE_OF(idx), NO_KEYS);
      }
    });
    if (changed) this.sendPresence();

    const anyoneHere = this.gameJoined.some(p => !p.away);
    if (anyoneHere) this.lastPresentAt = now;
    const decided = !!this.finalResult || this.abandoned;
    if ((decided && !anyoneHere && now - this.lastPresentAt > MATCH_DONE_LINGER_MS) ||
        (!anyoneHere && now - this.lastPresentAt > MATCH_SEAT_HOLD_MS) ||
        now - this.createdAt > MATCH_MAX_AGE_MS) {
      console.log('[match] ' + this.roomId + ': nobody holding a seat — closing');
      this.stopLoop();
      this.setMetadata({ over: true });
      this.disconnect();
      return;
    }

    // Paid match, one player here and the other never came: walkover.
    if (this.entriesCharged && !this.sim && !this.finalResult && !this.abandoned && this.gameJoined.length === 1
        && !this.gameJoined[0].away && now - this.createdAt > NO_SHOW_AFTER_MS) {
      console.log('NO-SHOW WALKOVER: ' + this.gameJoined[0].name + ' wins (opponent never joined)');
      this.endMatch('p1', 'walkover');
      return;
    }

    if (!this.sim || this.matchSettled) return; // walkover only while a match is being played
    const gone = this.gameJoined.filter(p => p.away && now - p.awaySince > WALKOVER_AFTER_MS);
    if (!gone.length) return;

    // Walkover: the player who left didn't come back in time, so the opponent
    // who is still here wins — through the same endMatch → creditWinner path
    // and the same 'footymp:<roomId>' key, so a finish and a walkover can't both pay.
    const slot = gone[0];
    const other = this.gameJoined.find(p => p !== slot);
    if (gone.length === 1 && other && !other.away) {
      console.log('WALKOVER: ' + slot.name + ' away — ' + other.name + ' wins');
      this.endMatch(this.gameJoined.indexOf(other) === 0 ? 'p1' : 'p2', 'walkover');
      return;
    }
    console.log('[match] ' + this.roomId + ': both players away — play stopped');
    this.stopLoop();
    this.sim = null;
    this.abandoned = true;
    this.setOverMetadata();
    this.broadcast('opponentLeft');
  }

  // ── The match ─────────────────────────────────────────────────────────────

  private startMatch() {
    this.stopLoop();
    this.sim = createSim();
    this.broadcast('kickoff', {});
    // Fixed 30 fps from wall-clock time (catches up after a late timer, never
    // runs ahead), so a minute of play is a minute on both screens.
    let next = Date.now();
    this.loop = setInterval(() => {
      const sim = this.sim;
      if (!sim) return;
      let n = 0;
      while (Date.now() >= next && n < 5) {
        sim.tick();
        { const snap = sim.snapshot();
          if (PER_SEAT_TEST) this.gameJoined.forEach((p, seat) => later(() => this.clients.find(c => c.sessionId === p.sessionId)?.send('s', snap), seat, 'out'));
          else later(() => this.broadcast('s', snap)); }
        next += FRAME_MS; n++;
        if (sim.result) {
          const r = sim.result;
          this.endMatch(r.winner === 'L' ? 'p1' : 'p2', null);
          return;
        }
      }
      if (Date.now() - next > 1000) next = Date.now();   // the process was stalled: don't fast-forward the match
    }, 4);
  }

  private stopLoop() {
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
  }

  // how: null = played to the end, 'walkover' = the other player was away too
  // long (or never came), 'forfeit' = the other player quit.
  private endMatch(winner: 'p1' | 'p2', how: 'walkover' | 'forfeit' | null) {
    if (this.finalResult) return;
    this.stopLoop();
    const scores = this.sim ? this.sim.scores : { L: 0, R: 0 };
    this.finalResult = {
      winner,
      p1Score: scores.L,
      p2Score: scores.R,
      walkover: how === 'walkover',
      forfeit: how === 'forfeit',
      p1Name: this.gameJoined[0]?.name || null,
      p2Name: this.gameJoined[1]?.name || null,
    };
    this.broadcast('matchEnd', this.finalResult);
    this.sim = null;
    this.setOverMetadata();

    // Auto-credit: the winner's tenten.run account gets the agreed prize, once.
    if (this.matchSettled) return;
    this.matchSettled = true;
    const p1won = winner === 'p1';
    const winnerSlot = this.gameJoined[p1won ? 0 : 1];
    const loserSlot = this.gameJoined[p1won ? 1 : 0];
    if (winnerSlot) void this.creditWinner(winnerSlot, loserSlot || null);
  }

  private async creditWinner(winner: PlayerSlot, loser: PlayerSlot | null) {
    let state: { status: string; amount?: string } = { status: 'failed' };
    for (const delay of [0, 1000, 3000]) {
      if (delay) await new Promise(r => setTimeout(r, delay));
      try {
        const loserUserId = loser ? loser.userId : (this.allowedUserIds.find(id => id !== winner.userId) ?? null);
        const out = await creditFootyWin({ roomId: this.roomId, winnerUserId: winner.userId, loserUserId, prize: this.agreedPrize, entriesCharged: this.entriesCharged });
        console.log(`[footymp-credit] match ${this.roomId} → user ${winner.userId}: ${out.status}` +
          (out.status === 'credited' ? ` $${out.amount} (${out.balanceBefore} → ${out.balanceAfter})` : '') +
          (out.status === 'disabled' ? ' — payouts are OFF (FOOTYMP_PAYOUTS_ENABLED=false)' : ''));
        state = out.status === 'disabled' ? { status: 'disabled' } : { status: 'credited', amount: prizeAmount(this.agreedPrize) };
        break;
      } catch (e) {
        console.error(`[footymp-credit] attempt failed for match ${this.roomId} → user ${winner.userId}:`, e);
      }
    }
    if (state.status === 'failed') console.error(`[footymp-credit] GAVE UP — match ${this.roomId}, winner user ${winner.userId} is owed $${prizeAmount(this.agreedPrize)}`);
    this.creditResult = { userId: winner.userId, state };
    this.clients.find(c => c.sessionId === winner.sessionId)?.send('footymp:credit', state);
    // Decided and paid: both players may now ask for a rematch.
    this.broadcast('rematch:available', {});
  }
}
