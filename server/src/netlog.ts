/**
 * Connection recorder (test phase): every page sends a short report every 5 s
 * about what its connection did — freezes, each connection's stalls, whether
 * they stalled together, ping, screen fps, page version. Kept in memory (last
 * 3000 reports) and in the server log, so a player's lag can be diagnosed
 * after the fact without them. Read with /netlog?key=<test key>[&user=<name>].
 */
import type { Request, Response } from "express";
import { testBotKeyOk } from "./auth";

const MAX = 3000;
const reports: any[] = [];

export function recordNet(entry: any) {
  reports.push(entry);
  if (reports.length > MAX) reports.splice(0, reports.length - MAX);
  console.log("[netdiag] " + JSON.stringify(entry));
}

export function netlogHandler(req: Request, res: Response) {
  const key = String(req.query.key || "");
  if (!key || !testBotKeyOk(key)) { res.status(404).end(); return; }
  const user = String(req.query.user || "").toLowerCase();
  const out = user ? reports.filter(r => String(r.name || "").toLowerCase().includes(user)) : reports;
  res.json(out.slice(-Number(req.query.n || 500)));
}
