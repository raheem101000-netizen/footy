import { createSim } from "../src/footy/sim";
const sim = createSim(); let f = 0, gg = 0;
while (!sim.result && f < 30 * 120) { sim.tick(); f++; const s = sim.snapshot(); if (s.gg && !gg) { gg = f; console.log('golden goal at frame', f, 'score', s.sl, s.sr, 'text', s.tx.text); } if (f === gg + 300 && gg) { const d: any = sim._debug(); d.M.scoreLeft; } }
console.log('result', sim.result, 'frames', f);
