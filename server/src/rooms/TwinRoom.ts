import { Room, Client } from "@colyseus/core";
import { authenticateGameToken, FootyAuth } from "../auth";

/**
 * The twin connection: each player's page opens a SECOND connection to the
 * server next to its match connection. The match room sends every frame down
 * both, and the page sends its keys up both; each side uses whichever copy
 * arrives first and ignores the other.
 *
 * Why: a connection delivers in order, so when one piece of data is lost on a
 * shaky Wi-Fi, everything behind it waits for the re-send (~0.2 s) — the
 * freeze. Two connections lose data independently, so while one is waiting
 * the other usually carries the same frame on time.
 *
 * The match itself still lives only in GameRoom; this room just carries copies.
 */

export interface TwinTarget {
  isPlayer(userId: number): boolean;
  keysFromTwin(userId: number, data: any): void;
  addTwin(client: Client, userId: number): void;
  removeTwin(client: Client): void;
}

// match room id → the match room (one server process)
export const twinTargets = new Map<string, TwinTarget>();

export class TwinRoom extends Room {
  maxClients = 4;
  private target: string = '';
  private users = new Map<string, number>();   // sessionId → userId

  static async onAuth(token: string, options: any) {
    return authenticateGameToken(token, options?.playerId);
  }

  onCreate(options: any) {
    this.target = String(options?.room || '');
    this.onMessage('in', (client: Client, data: any) => {
      const userId = this.users.get(client.sessionId);
      const t = twinTargets.get(this.target);
      if (t && userId !== undefined) t.keysFromTwin(userId, data);
    });
    this.onMessage('*', () => {});
  }

  onJoin(client: Client, _options: any, auth: FootyAuth) {
    const t = twinTargets.get(this.target);
    if (!t || !t.isPlayer(auth.userId)) throw new Error("Not a player in this match");
    this.users.set(client.sessionId, auth.userId);
    t.addTwin(client, auth.userId);
  }

  onLeave(client: Client) {
    this.users.delete(client.sessionId);
    twinTargets.get(this.target)?.removeTwin(client);
  }
}
