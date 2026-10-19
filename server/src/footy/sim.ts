/**
 * FOOTY match simulation — the server's copy of the game.
 *
 * This is the match engine of the single-player game (index.html, itself
 * ported from the decompiled original) running on the server, so neither
 * player's browser decides anything: pages send their keys, the server runs
 * the world at the original 30 frames a second (3 × 1/96 s Box2D steps per
 * frame) and sends every frame back to both players.
 *
 * Seats: 'L' = the left player (the original's "opp"), 'R' = the right
 * player (the original's "hero"). Each page draws itself on the right.
 *
 * Differences from the original 2-player mode, all so a cash match is the
 * same for both sides (the original favoured the right-hand player):
 *  - both players can jump off the other's head (right player only before);
 *  - each player is stopped at the mouth of their OWN goal (the left player
 *    was stopped at the right player's goal instead);
 *  - power-ups behave the same whichever player triggers them (the right
 *    player's Freeze and Low Jump never wore off, a broken leg lasted twice
 *    as long on the left player);
 *  - a power-up touched before anyone has played the ball counts for nobody.
 * Plus the match rule chosen for 1v1: one minute, and if it's level at full
 * time, golden goal — play on, the next goal wins.
 */
import * as pl from "planck";

/* Box2D 2.0.2 settings recovered from the original file (pixel units, 96 Hz sub-steps) */
pl.Settings.maxTranslation = 6000 / 96;
pl.Settings.maxRotation = 2500 / 96;
pl.Settings.baumgarte = 0.5;
pl.Settings.velocityThreshold = 1;
pl.Settings.linearSlop = 0.005;
pl.Settings.maxLinearCorrection = 0.2;
pl.Settings.timeToSleep = 0.5;
pl.Settings.linearSleepTolerance = 0.01;

export type Side = "L" | "R";
export interface Keys { left: boolean; right: boolean; jump: boolean; kick: boolean; }
export const NO_KEYS: Keys = { left: false, right: false, jump: false, kick: false };

export const MATCH_SECONDS = Number(process.env.FOOTY_MATCH_SECONDS) || 60;   // env override: local tests only

const PU_LIST = ['Speed_Good', 'Speed_Bad', 'Jump_Good', 'Jump_Bad', 'Ice_Good', 'Ice_Bad', 'Bombs_Good', 'Bombs_Bad', 'Fireground_Neu',
  'Bigball_Neu', 'Bouncyball_Neu', 'Smallball_Neu', 'Deadball_Neu', 'Size_Good', 'Size_Bad', 'Break_Good', 'Break_Bad', 'Streaker_Neu'];
const BREAK_FRAMES = 400;

const r2 = (v: number) => Math.round(v * 100) / 100;

export function createSim() {
  const rand = Math.random;
  const Vec = (x: number, y: number) => pl.Vec2(x, y);
  let world: any = null, ball: any, hero: any, racket: any, heroJoint: any, opp: any, oppracket: any, oppJoint: any,
    leftGoalPost: any, rightGoalPost: any, streaker: any = null;
  const M: any = {};
  const PH: any = {};
  const keys: Record<Side, Keys> = { L: { ...NO_KEYS }, R: { ...NO_KEYS } };
  let timeFns: { t: number; frames: number; fn: () => void }[] = [];
  // What happened this frame, for the pages (sounds and one-shot effects).
  let snd: string[] = [];
  let fx: any[] = [];
  let frame = 0;
  // The boots part-way through this frame: the physics works each frame out in 3 steps of 1/96 s;
  // the boot after steps 1 and 2 ([x, y, angle] × 2 per side) lets the pages draw the whole swing,
  // even when a boot moves a long way in one frame (a fast kick or the whip back after one).
  let bootSub: { R: number[]; L: number[] } | null = null;
  let pauseGame = true;
  let result: { winner: Side; scoreL: number; scoreR: number } | null = null;

  const addTimeFunction = (frames: number, fn: () => void) => timeFns.push({ t: 0, frames, fn });
  const playSound = (n: string) => snd.push(n);

  function resetWorld() {
    world = pl.World({ gravity: Vec(0, 300), allowSleep: true });
    world.on('begin-contact', onContact);
  }
  function mkBody(x: number, y: number, density: number, fixed: boolean, shape: any, friction: number, restitution: number, group: number, ud: any) {
    const b = world.createBody({ type: density > 0 ? 'dynamic' : 'static', position: Vec(x, y), fixedRotation: !!fixed });
    b.createFixture(shape, { density, friction, restitution, filterGroupIndex: group });
    b.setUserData(ud || {}); return b;
  }
  const spawnBox = (x: number, y: number, w: number, h: number, d: number, f: number, r: number, g: number, ud?: any) =>
    mkBody(x, y, d, false, pl.Box(w / 2, h / 2), f, r, g, Object.assign({ shape: 'box', w, h }, ud));
  const spawnCircle = (x: number, y: number, r: number, d: number, f: number, re: number, g: number, ud?: any, fixed?: boolean) =>
    mkBody(x, y, d, !!fixed, pl.Circle(r), f, re, g, Object.assign({ shape: 'circle', r }, ud));
  const setXForm = (b: any, x: number, y: number, a: number) => b.setTransform(Vec(x, y), a);
  const P = (b: any) => b.getPosition(), Vl = (b: any) => b.getLinearVelocity();
  const setV = (b: any, x: number, y: number) => b.setLinearVelocity(Vec(x, y));
  const spawnJoint = (a: any, b: any) => world.createJoint(pl.RevoluteJoint({ enableMotor: true, maxMotorTorque: 100000000, motorSpeed: 0 }, a, b, a.getWorldCenter()));
  const removeBody = (b: any) => { if (b && world) world.destroyBody(b); };
  const heads = (h: number) => 50 * h;

  /* ---------- match start (startLevel + enterGameFrame, 2-player timed) ---------- */
  function startMatch() {
    M.PUs = []; M.bombs = [];
    M.PUTimer = 0; M.scoreLeft = 0; M.scoreRight = 0;
    M.timeMode = true; M.inGoal = false; M.suddenDeath = false;
    M.heroLegBroken = M.oppLegBroken = false; M.xspeed = 0; M.oppxspeed = 0;
    M.heroBombed = M.oppBombed = false; M.streakerAlive = false; M.streakerX = 100 + rand() * 600;
    resetPUVars(); M.timer = 0;
    M.winMargin = 7;
    M.timeLeft = MATCH_SECONDS; M.timeLeftBitch = 0;
    M.headsScale = 1; M.yourHeadScale = 1; M.heroRacketScale = 1; M.oppRacketScale = 1;
    M.heroRacketFrame = M.oppRacketFrame = 1; M.counter = 0;
    M.score = { seq: 0, text: '' }; M.goalWords = null; M.gwSeq = 0;
    M.flasher = 1000; M.matchPoint = false; M.goals = defaultGoals(); PHReset();
    world = null;
    initLevel();
  }
  function resetPUVars() {
    M.ballSender = null; M.heroBombed = M.oppBombed = false; M.heroPUSpeed = 1; M.heroPUJump = 1; M.heroPUFreeze = false;
    M.oppPUSpeed = 1; M.oppPUJump = 1; M.oppPUFreeze = false; M.PUFire = false; M.PUSize = 1; M.PUBouncy = 1;
  }
  function defaultGoals() { return [{ top: 330, hitY: 360, hitH: 100, frame: 1 }, { top: 330, hitY: 360, hitH: 100, frame: 1 }]; }

  function initLevel() {
    resetWorld();
    spawnBox(-5, 240, 20, 480, 0, .5, 0, 0, { wall: 1 }); spawnBox(805, 240, 20, 480, 0, .5, 0, 0, { wall: 1 }); spawnBox(400, -5, 800, 20, 0, .5, 0, 0, { wall: 1 });
    let b = spawnBox(50, 50, 60, 200, 0, .5, 0, 0, { wall: 1 }); setXForm(b, 50, 50, 45 * Math.PI / 180);
    b = spawnBox(750, 50, 60, 200, 0, .5, 0, 0, { wall: 1 }); setXForm(b, 750, 50, -45 * Math.PI / 180);
    b = spawnBox(-20, 240, 60, 520, 0, .5, 0, 0, { wall: 1 }); setXForm(b, -20, 240, 8 * Math.PI / 180);
    b = spawnBox(820, 240, 60, 520, 0, .5, 0, 0, { wall: 1 }); setXForm(b, 820, 240, -8 * Math.PI / 180);
    b = spawnBox(240, -20, 520, 60, 0, .5, 0, 0, { wall: 1 }); setXForm(b, 240, -20, -8 * Math.PI / 180);
    b = spawnBox(560, -20, 520, 60, 0, .5, 0, 0, { wall: 1 }); setXForm(b, 560, -20, 8 * Math.PI / 180);
    leftGoalPost = spawnBox(40, 345, 80, 10, 0, .5, 0, 0, { post: 1 });
    rightGoalPost = spawnBox(760, 345, 80, 10, 0, .5, 0, 0, { post: 1 });
    spawnBox(400, 470, 800, 20, 0, .5, 0, -1, { ground: 1 });
    ball = spawnCircle(400, 230, 10, 1.5, 1, .6, 0, { ball: 1 });
    setV(ball, -150 + rand() * 300, -100);
    hero = spawnCircle(600, 440, 20, 100, 0, .01, 0, { hero: 1 }, true);
    racket = spawnBox(580, 440, 40, 10, 2, .5, 1, -1, { racket: 1 }); setXForm(racket, 600 + 4, 440 + 15.6, 1.37 + Math.PI);
    heroJoint = spawnJoint(hero, racket);
    opp = spawnCircle(200, 440, 20, 100, 0, .01, 0, { opp: 1 }, true);
    oppracket = spawnBox(220, 440, 40, 10, 2, .5, 1, -1, { racket: 1 }); setXForm(oppracket, 200 - 4, 440 + 15.6, -1.37 + Math.PI);
    oppJoint = spawnJoint(opp, oppracket);
    M.heroRacketScale = M.oppRacketScale = M.headsScale = M.yourHeadScale = 1;
    M.heroR = 20; M.oppR = 20; M.ballR = 10;
    pauseGame = true; M.streakerAlive = false; streaker = null; M.streakerX = 100 + rand() * 600;
    M.counter = 2;
    resetGoalSizes();
    M.matchPoint = (M.scoreLeft === 6 || M.scoreRight === 6);
    text(M.scoreLeft + ' - ' + M.scoreRight);
    M.xspeed = 0; M.oppxspeed = 0;
  }

  /* ---------- one frame of play (onFrame_game, 2-player branch, both sides alike) ---------- */
  function onFrame_game() {
    if (pauseGame || !world) return;
    const hp = P(hero), op = P(opp);
    const kR = keys.R, kL = keys.L;
    // right player (hero)
    {
      const onGround = hp.y + heads(M.yourHeadScale) / 2 > 459;
      if (kR.left && !M.heroPUFreeze && !M.heroBombed) { M.xspeed -= 50 + M.heroPUSpeed * 30; if (hp.y > 439 && M.timer % 2 === 0) spawnDust(true, true); }
      if (kR.right && !M.heroPUFreeze && !M.heroBombed && hp.x < 720) { M.xspeed += 50 + M.heroPUSpeed * 30; if (hp.y > 439 && M.timer % 2 === 0) spawnDust(true, false); }
      if (kR.jump && !M.heroBombed &&
          (onGround || (Math.abs(hp.x - op.x) < 30 && hp.y < op.y && hp.y > op.y - 45 && Vl(hero).y >= 1))) {
        playSound('jumpSound'); spawnGreenRing(true); setV(hero, Vl(hero).x, -150 + M.heroPUJump * -50);
      }
      const ha = heroJoint.getJointAngle();
      if (!kR.kick) { if (!M.heroBombed) heroJoint.setMotorSpeed(-6 * (((ha + Math.PI) - 1.2) - 1.67)); }
      else if (!M.heroBombed && !M.heroLegBroken) heroJoint.setMotorSpeed(-12 * ((ha - .2) - 1.67));
      M.xspeed *= .7;
      setV(hero, M.xspeed, Vl(hero).y + 5);
    }
    // left player (opp) — the mirror of the above
    {
      const onGround = op.y + heads(M.headsScale) / 2 > 459;
      const canMove = !M.oppPUFreeze && !M.oppBombed;
      if (kL.left && canMove && op.x > 80) { M.oppxspeed -= 50 + M.oppPUSpeed * 30; if (op.y > 439 && M.timer % 2 === 0) spawnDust(false, true); }
      if (kL.right && canMove) { M.oppxspeed += 50 + M.oppPUSpeed * 30; if (op.y > 439 && M.timer % 2 === 0) spawnDust(false, false); }
      if (kL.jump && !M.oppBombed &&
          (onGround || (Math.abs(op.x - hp.x) < 30 && op.y < hp.y && op.y > hp.y - 45 && Vl(opp).y >= 1))) {
        playSound('jumpSound'); spawnGreenRing(false); setV(opp, Vl(opp).x, -150 + M.oppPUJump * -50);
      }
      const oa = oppJoint.getJointAngle();
      if (!kL.kick) { if (!M.oppBombed) oppJoint.setMotorSpeed(-6 * (((oa - .2) - Math.PI / 2) + 1.67)); }
      else if (!M.oppBombed && !M.oppLegBroken) oppJoint.setMotorSpeed(-12 * ((((oa + Math.PI) - 1.2) - Math.PI / 2) + 1.67));
      M.oppxspeed *= .7; setV(opp, M.oppxspeed, Vl(opp).y + 5);
    }
    if (M.streakerAlive && streaker) {
      const sp = P(streaker);
      if (Math.abs(sp.x - M.streakerX) < 10) M.streakerX = 100 + rand() * 600;
      else setV(streaker, sp.x < M.streakerX ? 100 : -100, Vl(streaker).y);
      if (P(streaker).y > 439) setV(streaker, Vl(streaker).x, -300);
    }
    // ball resting on a crossbar is nudged off
    if (overlapBall(0, M.goals[0].top, 80, 10)) { const v = Vl(ball); setV(ball, v.x + 2, v.y); }
    else if (overlapBall(720, M.goals[1].top, 80, 10)) { const v = Vl(ball); setV(ball, v.x - 2, v.y); }
    M.timer++;
    M.PUTimer++;
    if (M.PUTimer > 200) { spawnPU(); M.PUTimer = 0; }
    flasherUpdate(); PUCollisions(); PHUpdate(); bombsUpdate();
    const subR: number[] = [], subL: number[] = [];
    for (let i = 0; i < 3; i++) {
      world.step(1 / 96, 48, 48);
      if (i < 2) { subR.push(...bodyState(racket)); subL.push(...bodyState(oppracket)); }
    }
    bootSub = { R: subR, L: subL };
    checkWinPoint();
    if (M.timeMode && !M.suddenDeath && M.timeLeft > 0) {
      M.timeLeftBitch++;
      if (M.timeLeftBitch >= 30) { M.timeLeft--; M.timeLeftBitch = 0; if (M.timeLeft <= 0) fullTime(); }
    }
    M.PUs = M.PUs.filter((u: any) => !u.del); M.bombs = M.bombs.filter((e: any) => !e.del);
  }

  // the original tests goals with hitTestObject: axis-aligned boxes of the (rotating) ball sprite
  function ballBox() { const p = P(ball), a = ball.getAngle(), h = M.ballR * 1.02 * (Math.abs(Math.cos(a)) + Math.abs(Math.sin(a))); return [p.x - h, p.y - h, p.x + h, p.y + h]; }
  function overlapBall(x: number, y: number, w: number, h: number) { const b = ballBox(); return b[0] < x + w && b[2] > x && b[1] < y + h && b[3] > y; }

  function onContact(c: any) {
    const b2 = c.getFixtureA().getBody(), b3 = c.getFixtureB().getBody();
    const has = (a: any, b: any) => (b2 === a && b3 === b) || (b2 === b && b3 === a);
    if (has(ball, racket) || has(ball, hero)) M.ballSender = 'hero';
    if (has(ball, oppracket) || has(ball, opp)) M.ballSender = 'opp';
    if (b2 === ball || b3 === ball) {
      const wm = c.getWorldManifold(null), pt = wm && wm.points && wm.points[0];
      if (pt) {
        const va = b2.getLinearVelocityFromWorldPoint(pt), vb = b3.getLinearVelocityFromWorldPoint(pt);
        if (Math.hypot(vb.x - va.x, vb.y - va.y) > 200) { playSound('kickSound'); spawnRing(P(ball).x, P(ball).y); }
      }
    }
  }

  function checkWinPoint() {
    if (M.inGoal) return;
    const g0 = M.goals[0], g1 = M.goals[1];
    if (overlapBall(-5.5, g0.hitY, 70, g0.hitH)) { M.scoreRight++; playSound('dieSound'); playSound('cheerSound'); pointComp('R'); }
    else if (overlapBall(735, g1.hitY, 70, g1.hitH)) { M.scoreLeft++; playSound('dieSound'); playSound('cheerSound'); pointComp('L'); }
  }
  function pointComp(who: Side) {
    if (M.suddenDeath) { wonMatch(who); return; }
    M.inGoal = true;
    M.goalWords = { seq: ++M.gwSeq, side: who, win: false };
    if (streaker) { removeBody(streaker); streaker = null; M.streakerAlive = false; }
    addTimeFunction(15, () => {
      M.inGoal = false; M.goalWords = null; resetPUVars(); M.PUs = []; M.bombs = []; world = null;
      initLevel();
      if (M.timeLeft <= 0) fullTime();   // the minute ran out while the goal was being celebrated
    });
  }
  // The minute is up: most goals wins; level → golden goal (play on, next goal wins).
  function fullTime() {
    if (M.inGoal) return;   // a goal is being celebrated: decided right after it (pointComp)
    if (M.scoreLeft !== M.scoreRight) { wonMatch(M.scoreLeft > M.scoreRight ? 'L' : 'R'); return; }
    M.suddenDeath = true; playSound('whistleSound'); text('Golden Goal');
  }
  function wonMatch(who: Side) {
    if (result || M.over) return;
    M.over = true; M.inGoal = true; playSound('whistleSound');
    M.goalWords = { seq: ++M.gwSeq, side: who, win: true };
    addTimeFunction(60, () => { result = { winner: who, scoreL: M.scoreLeft, scoreR: M.scoreRight }; pauseGame = true; });
  }

  /* ---------- size changes ---------- */
  function makeHero(sz: number) {
    const p = P(hero), x = p.x, y = p.y, sc = [.5, 1, 1.5][sz], r = 20 * sc;
    removeBody(hero); hero = spawnCircle(x, y, r, 100, 0, .01, 0, { hero: 1 }, true); M.yourHeadScale = sc; M.heroR = r;
    removeBody(racket); racket = spawnBox(x - r, y, 40 * sc, 10 * sc, 2, .5, 1, -1, { racket: 1 });
    setXForm(racket, x + 4 * sc, y + 15.6 * sc, 1.37 + Math.PI); M.heroRacketScale = sc; heroJoint = spawnJoint(hero, racket);
  }
  function makeOpp(sz: number) {
    const p = P(opp), x = p.x, y = p.y, sc = [.5, 1, 1.5][sz], r = 20 * sc;
    removeBody(opp); opp = spawnCircle(x, y, r, 100, 0, .01, 0, { opp: 1 }, true); M.headsScale = sc; M.oppR = r;
    removeBody(oppracket); oppracket = spawnBox(x + r, y, 40 * sc, 10 * sc, 2, .5, 1, -1, { racket: 1 });
    setXForm(oppracket, x - 4 * sc, y + 15.6 * sc, -1.37 + Math.PI); M.oppRacketScale = sc; oppJoint = spawnJoint(opp, oppracket);
  }
  function updateBall() {
    const p = P(ball), v = Vl(ball), av = ball.getAngularVelocity();
    removeBody(ball); M.ballR = 5 + M.PUSize * 5;
    ball = spawnCircle(p.x, p.y, M.ballR, .6, 1, .3 + M.PUBouncy * .3, 0, { ball: 1 });
    ball.setLinearVelocity(v); ball.setAngularVelocity(av); spawn4Rings(p.x, p.y);
  }
  function spawnStreaker() { if (M.streakerAlive) return; streaker = spawnCircle(400, 300, 20, 100, 0, .01, 0, { streaker: 1 }, true); M.streakerAlive = true; }

  /* ---------- power-ups (PUHandler) ---------- */
  function PHReset() { for (const k of ['hSpeed', 'hJump', 'hIce', 'hBombs', 'hSize', 'hBreak', 'oSpeed', 'oJump', 'oIce', 'oBombs', 'oSize', 'oBreak', 'Fire', 'Size', 'Bouncy', 'Streaker']) PH[k] = 10000; }
  function spawnPU() {
    playSound('popSound');
    const k = PU_LIST[Math.ceil(rand() * 18) - 1] || PU_LIST[0];
    const u = { k, x: 220 + rand() * 360, y: 150 + rand() * 270, timer: 600, del: false };
    M.PUs.push(u); spawn4Rings(u.x, u.y);
  }
  function PUCollisions() {
    const bp = P(ball);
    for (const u of M.PUs) {
      u.timer--; if (u.timer < 0) u.del = true;
      if (!u.del && M.ballSender && Math.hypot(u.x - bp.x, u.y - bp.y) < 35) { gotOne(M.ballSender, u.k); u.del = true; }
    }
  }
  function text(t: string) { M.score = { seq: (M.score ? M.score.seq : 0) + 1, text: t }; }
  function setGoal(side: number, kind: number) { // side 0 = left goal, kind 1 normal 2 big 3 small
    const g = M.goals[side], top = ({ 1: 330, 2: 290, 3: 370 } as any)[kind];
    g.top = top; g.frame = kind; g.hitY = ({ 1: 360, 2: 320, 3: 400 } as any)[kind]; g.hitH = ({ 1: 100, 2: 140, 3: 60 } as any)[kind];
    setXForm(side === 0 ? leftGoalPost : rightGoalPost, side === 0 ? 40 : 760, top + 15, 0);
  }
  function resetGoalSizes() { setGoal(0, 1); setGoal(1, 1); }
  // Who touched the ball last gets the power-up; "me" is that player, "them" the other.
  function gotOne(who: 'hero' | 'opp', k: string) {
    playSound('coinSound');
    const isHero = who === 'hero';
    const me = isHero ? 'h' : 'o', them = isHero ? 'o' : 'h';
    const theirGoal = isHero ? 0 : 1;   // the goal "me" shoots at
    const setSpeed = (s: string, v: number) => { if (s === 'h') M.heroPUSpeed = v; else M.oppPUSpeed = v; };
    const setJump = (s: string, v: number) => { if (s === 'h') M.heroPUJump = v; else M.oppPUJump = v; };
    const freeze = (s: string) => { if (s === 'h') M.heroPUFreeze = true; else M.oppPUFreeze = true; PH[s + 'Ice'] = 0; };
    const resize = (s: string, sz: number) => { if (s === 'h') makeHero(sz); else makeOpp(sz); PH[s + 'Size'] = 0; };
    const breakLeg = (s: string) => { if (s === 'h') { M.heroLegBroken = true; M.heroRacketFrame = 2; } else { M.oppLegBroken = true; M.oppRacketFrame = 2; } PH[s + 'Break'] = 0; };
    switch (k) {
      case 'Speed_Good': text('Super Speed'); setSpeed(me, 2); PH[me + 'Speed'] = 0; break;
      case 'Speed_Bad': text('Slow Speed'); setSpeed(me, 0); PH[me + 'Speed'] = 0; break;
      case 'Jump_Good': text('Super Jump'); setJump(me, 2); PH[me + 'Jump'] = 0; break;
      case 'Jump_Bad': text('Low Jump'); setJump(me, 0); PH[me + 'Jump'] = 0; break;
      case 'Ice_Good': text('Freeze'); freeze(them); break;
      case 'Ice_Bad': text('Freeze'); freeze(me); break;
      case 'Bombs_Good': text('Big Goal'); setGoal(theirGoal, 2); PH[them + 'Bombs'] = 0; break;
      case 'Bombs_Bad': text('Small Goal'); setGoal(theirGoal, 3); PH[me + 'Bombs'] = 0; break;
      case 'Size_Good': resize(me, 2); break;
      case 'Size_Bad': resize(me, 0); break;
      case 'Break_Good': breakLeg(them); break;
      case 'Break_Bad': breakLeg(me); break;
      case 'Fireground_Neu': text('Bombs'); M.PUFire = true; PH.Fire = 0; break;
      case 'Bigball_Neu': text('Big Ball'); M.PUSize = 2; updateBall(); PH.Size = 0; break;
      case 'Bouncyball_Neu': text('Bouncy Ball'); M.PUBouncy = 2; updateBall(); PH.Size = 0; break;   // original times this on the size timer
      case 'Smallball_Neu': text('Small Ball'); M.PUSize = 0; updateBall(); PH.Bouncy = 0; break;
      case 'Deadball_Neu': text('Dead Ball'); M.PUBouncy = 0; updateBall(); PH.Bouncy = 0; break;
      case 'Streaker_Neu': spawnStreaker(); PH.Streaker = 0; break;
    }
  }
  function PHUpdate() {
    for (const k in PH) PH[k]++;
    if (PH.hSpeed === 200) M.heroPUSpeed = 1;
    if (PH.hJump === 200) M.heroPUJump = 1;
    if (PH.hIce === 200) M.heroPUFreeze = false;
    if (PH.hBombs === 600) resetGoalSizes();
    if (PH.hSize === 600) makeHero(1);
    if (PH.hBreak === BREAK_FRAMES) { M.heroLegBroken = false; M.heroRacketFrame = 1; }
    if (PH.oSpeed === 200) M.oppPUSpeed = 1;
    if (PH.oJump === 200) M.oppPUJump = 1;
    if (PH.oIce === 200) M.oppPUFreeze = false;
    if (PH.oBombs === 600) resetGoalSizes();
    if (PH.oSize === 600) makeOpp(1);
    if (PH.oBreak === BREAK_FRAMES) { M.oppLegBroken = false; M.oppRacketFrame = 1; }
    if (PH.Fire === 700) { M.PUFire = false; M.oppBombed = false; M.heroBombed = false; }
    if (PH.Size === 400) { M.PUSize = 1; updateBall(); }
    if (PH.Bouncy === 200) { M.PUBouncy = 1; updateBall(); }
    if (PH.Streaker === 1000) { removeBody(streaker); streaker = null; M.streakerAlive = false; }
    if (PH.Fire === 1 || PH.Fire === 40 || PH.Fire === 80) spawnBomb();
  }
  function spawnBomb() { const b = { x: 20 + rand() * 760, y: 50, ys: 0, del: false }; M.bombs.push(b); spawn4Rings(b.x, b.y); }
  function bombsUpdate() {
    for (const b of M.bombs) {
      b.ys += .2; b.y += b.ys;
      if (b.y >= 470) {
        b.y = 470;
        if (Math.hypot(b.x - P(hero).x, b.y - P(hero).y) < 50) M.heroBombed = true;
        if (Math.hypot(b.x - P(opp).x, b.y - P(opp).y) < 50) M.oppBombed = true;
        playSound('explosionSound'); fx.push(['boom', r2(b.x), r2(b.y)]); b.del = true;
      }
    }
  }
  function flasherUpdate() { M.flasher++; if (M.timeMode && !M.suddenDeath && M.timeLeft === 10 && M.timeLeftBitch === 0) M.flasher = 0; }

  /* ---------- effects (sent to the pages, which animate them) ---------- */
  function spawnRing(x: number, y: number) { fx.push(['ring', r2(x), r2(y)]); }
  function spawn4Rings(x: number, y: number) { spawnRing(x - 10, y - 10); spawnRing(x + 10, y - 10); spawnRing(x - 10, y + 10); spawnRing(x + 10, y + 10); }
  function spawnGreenRing(isHero: boolean) {
    const j = isHero ? M.heroPUJump : M.oppPUJump, p = P(isHero ? hero : opp);
    fx.push([j === 0 ? 'redring' : 'greenring', r2(p.x), r2(p.y + 20)]);
    if (j === 2) fx.push(['greenring', r2(p.x), r2(p.y)]);
  }
  function spawnDust(isHero: boolean, left: boolean) {
    const p = P(isHero ? hero : opp);
    fx.push(['dust', r2(p.x), 460, r2((left ? 1 : -1) * (rand() * 2 + 2)), r2(rand() * -2)]);
  }

  /* ---------- the frame (tick) ---------- */
  function tick() {
    snd = []; fx = []; bootSub = null;
    frame++;
    onFrame_game();
    if (M.counter >= 2) { M.counter++; if (M.counter >= 90) { M.counter = 0; if (!result) pauseGame = false; } }
    const fns = timeFns; timeFns = [];
    for (const f of fns) { f.t++; if (f.t === f.frames) f.fn(); else timeFns.push(f); }
  }

  const bodyState = (b: any) => { const p = P(b); return [r2(p.x), r2(p.y), r2(b.getAngle())]; };

  /** Everything a page needs to draw this frame. */
  function snapshot() {
    return {
      f: frame,
      w: !!world,
      b: world ? [...bodyState(ball), M.ballR, M.PUBouncy] : null,
      // [x, y, angle] of head and boot, then head scale, boot scale, leg broken, frozen, bombed, speed, jump
      R: world ? [...bodyState(hero), ...bodyState(racket), M.yourHeadScale, M.heroRacketScale, M.heroLegBroken ? 1 : 0, M.heroPUFreeze ? 1 : 0, M.heroBombed ? 1 : 0, M.heroPUSpeed, M.heroPUJump] : null,
      bs: world && bootSub ? bootSub : null,
      L: world ? [...bodyState(opp), ...bodyState(oppracket), M.headsScale, M.oppRacketScale, M.oppLegBroken ? 1 : 0, M.oppPUFreeze ? 1 : 0, M.oppBombed ? 1 : 0, M.oppPUSpeed, M.oppPUJump] : null,
      st: world && streaker && M.streakerAlive ? bodyState(streaker).slice(0, 2) : null,
      pu: M.PUs.map((u: any) => [u.k, r2(u.x), r2(u.y), u.timer]),
      bm: M.bombs.map((b: any) => [r2(b.x), r2(b.y)]),
      g: [M.goals[0].frame, M.goals[1].frame],
      sl: M.scoreLeft, sr: M.scoreRight,
      tl: M.timeLeft, gg: M.suddenDeath ? 1 : 0, fl: M.flasher,
      cnt: M.counter, mp: M.matchPoint ? 1 : 0,
      tx: M.score, gw: M.goalWords,
      snd, fx,
    };
  }

  startMatch();

  return {
    setKeys(side: Side, k: Partial<Keys>) {
      keys[side] = { left: !!k.left, right: !!k.right, jump: !!k.jump, kick: !!k.kick };
    },
    tick,
    snapshot,
    get result() { return result; },
    get scores() { return { L: M.scoreLeft as number, R: M.scoreRight as number }; },
    // test hook
    _debug: () => ({ M, ball: ball && P(ball), hero: hero && P(hero), opp: opp && P(opp), pauseGame }),
  };
}
export type FootySim = ReturnType<typeof createSim>;
