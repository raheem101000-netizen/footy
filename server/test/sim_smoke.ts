import { createSim, Side } from "../src/footy/sim";
// Two simple scripted players: run at the ball, jump when it's high, kick when close.
const sim = createSim();
let goals = 0, frames = 0, lastL = 0, lastR = 0, puSeen = new Set<string>();
const t0 = Date.now();
while (!sim.result && frames < 30 * 400) {
  const d: any = sim._debug();
  if (d.ball && d.hero && d.opp) {
    for (const side of ['L', 'R'] as Side[]) {
      const me = side === 'R' ? d.hero : d.opp, attackLeft = side === 'R';
      const behind = attackLeft ? d.ball.x + 25 : d.ball.x - 25;
      sim.setKeys(side, { left: me.x > behind + 5, right: me.x < behind - 5, jump: d.ball.y < me.y - 40 && Math.abs(d.ball.x - me.x) < 60, kick: Math.abs(d.ball.x - me.x) < 45 && frames % 6 < 3 });
    }
  }
  sim.tick(); frames++;
  const s = sim.snapshot();
  for (const u of s.pu) puSeen.add(u[0] as string);
  if (s.sl !== lastL || s.sr !== lastR) { goals++; lastL = s.sl; lastR = s.sr; console.log(`frame ${frames} (${(frames/30).toFixed(1)}s): ${s.sl}-${s.sr}  time left ${s.tl}${s.gg ? ' GOLDEN GOAL' : ''}`); }
}
console.log('result', sim.result, 'frames', frames, 'goals', goals, 'power-ups seen', puSeen.size, 'ms/frame', ((Date.now()-t0)/frames).toFixed(3));
console.log('snapshot bytes', JSON.stringify(sim.snapshot()).length);
