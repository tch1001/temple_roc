/* Temple Roc — pseudo-3D runner with a winding path of straight segments
   joined by 90-degree turns (Temple Run style). At every junction a wall
   blocks the corridor with an opening on one side; the player must swipe /
   press the matching arrow key within a small window to round the corner.

   Within each segment:
   - low blocks       — jump (Up)
   - overhead beams   — slide (Down)
   - wall torches     — lean the OPPOSITE way (hold Left or Right)

   Projection: screenX = cx + (worldX/z)·f
               screenY = horizonY + ((camY-worldY)/z)·f
*/
(() => {
  'use strict';

  // ---------- DOM ----------
  const canvas      = document.getElementById('stage');
  const ctx         = canvas.getContext('2d');
  const scoreEl     = document.getElementById('score');
  const bestEl      = document.getElementById('best');
  const overlay     = document.getElementById('overlay');
  const gameover    = document.getElementById('gameover');
  const finalScore  = document.getElementById('finalScore');
  const finalCoins  = document.getElementById('finalCoins');
  const playBtn     = document.getElementById('play');
  const againBtn    = document.getElementById('again');
  const shareBtn    = document.getElementById('share');
  const intro       = document.getElementById('intro');
  const coinsEl     = document.getElementById('coins');
  const finalDist   = document.getElementById('finalDist');
  const finalCoinPts= document.getElementById('finalCoinPts');
  const finalBest   = document.getElementById('finalBest');
  const helpBtn     = document.getElementById('help');
  const helpModal   = document.getElementById('help-modal');
  const helpClose   = document.getElementById('help-close');
  const charPlayer  = document.getElementById('char-player');
  const charChaser  = document.getElementById('char-chaser');
  const bgm         = document.getElementById('bgm');

  // Sprite videos: muted + looped, so they can autoplay silently from page load.
  // We just need their frames available for drawImage; the elements themselves stay hidden.
  function kickSpriteVideos() {
    for (const v of [charPlayer, charChaser]) {
      if (!v) continue;
      v.muted = true;             // some webviews ignore the attribute alone
      v.loop  = true;
      v.playsInline = true;
      v.play().catch(() => { /* autoplay blocked — first user gesture will start them */ });
    }
  }
  kickSpriteVideos();

  function videoReady(v) { return v && v.readyState >= 2 && v.videoWidth > 0; }

  // ---------- URL params (from the bot) ----------
  const params = new URLSearchParams(location.search);
  const auth = {
    uid: params.get('uid'), sig: params.get('sig'),
    cid: params.get('cid'), mid: params.get('mid'), imid: params.get('imid'),
  };

  // ---------- canvas sizing ----------
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width  = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- world / camera ----------
  const ROAD_HALF = 1.5;
  const CAM_Y     = 4.0;          // raised camera — looking down on the path
  const FAR_Z     = 60;
  const PLAYER_Z  = 6.0;          // chase distance (camera at z=0 looks toward +z)
  const TURN_WINDOW = 2.5;        // forgiving tolerance around segment end for turns

  function focal()   { return H * 0.70; }   // wider FOV so more of the path is visible
  function horizon() { return H * 0.30; }   // sky takes top 30% — ground gets the rest
  function project(xw, yw, zw) {
    const z = Math.max(zw, 0.001);
    const f = focal();
    return {
      x: W * 0.5 + (xw / z) * f,
      y: horizon() + ((CAM_Y - yw) / z) * f,
      s: f / z,
    };
  }

  // ---------- input ----------
  // Keyboard / touch produce two channels:
  //  - turnIntent   : 'L'/'R' buffered for ~500 ms (consumed by the turn check)
  //  - held.left/right : continuous lean while pressed / dragging
  //  - jump / slide : one-shot
  let turnIntent = null, turnIntentExpire = 0;
  function bufferTurn(dir) { turnIntent = dir; turnIntentExpire = performance.now() + 500; }

  const held  = { left: false, right: false };
  const input = { jump: false, slide: false };
  function consumeJumpSlide() {
    const i = { jump: input.jump, slide: input.slide };
    input.jump = input.slide = false;
    return i;
  }

  document.addEventListener('keydown', e => {
    if (e.repeat) return;
    if (e.key === 'ArrowLeft'  || e.key === 'a') { held.left  = true; bufferTurn('L'); }
    if (e.key === 'ArrowRight' || e.key === 'd') { held.right = true; bufferTurn('R'); }
    if (e.key === 'ArrowUp'    || e.key === 'w' || e.key === ' ') input.jump  = true;
    if (e.key === 'ArrowDown'  || e.key === 's') input.slide = true;
  });
  document.addEventListener('keyup', e => {
    if (e.key === 'ArrowLeft'  || e.key === 'a') held.left  = false;
    if (e.key === 'ArrowRight' || e.key === 'd') held.right = false;
  });

  // touch: drag to lean, swipe end → turn / jump / slide
  let touchStart = null;
  canvas.addEventListener('touchstart', e => {
    const t = e.changedTouches[0];
    touchStart = { x: t.clientX, y: t.clientY, t: performance.now() };
  }, { passive: true });
  canvas.addEventListener('touchmove', e => {
    if (!touchStart) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStart.x;
    held.left  = dx < -16;
    held.right = dx >  16;
  }, { passive: true });
  canvas.addEventListener('touchend', e => {
    held.left = held.right = false;
    if (!touchStart) return;
    const t  = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    const dt = performance.now() - touchStart.t;
    touchStart = null;
    if (dt > 700) return;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) { input.jump = true; return; }
    if (Math.abs(dx) > Math.abs(dy)) bufferTurn(dx > 0 ? 'R' : 'L');
    else if (dy < 0) input.jump = true;
    else             input.slide = true;
  }, { passive: true });

  // ---------- player ----------
  const player = {
    leanX: 0,            // -1 (left wall) … +1 (right wall)
    y: 0, vy: 0,
    sliding: 0,          // seconds remaining
    pendingSlide: false, // mid-air slide press → fast-fall, then slide on landing
    state: 'run',
  };
  const GRAVITY    = 28;
  const JUMP_VY    = 11;
  const SLIDE_TIME = 0.55;
  const LEAN_RATE  = 6;
  const LEAN_DEATH = 1.05;        // |leanX| > this = scrape wall

  // ---------- world: segments queue ----------
  /** @typedef {{z:number, type:'low'|'high'|'lean', side?:number}} Obstacle */
  /** @typedef {{z:number, picked?:boolean}} Coin */
  /** @typedef {{len:number, exit:'L'|'R', obstacles:Obstacle[], coins:Coin[]}} Segment */
  /** @type {Segment[]} */
  let segments = [];
  let segProgress = 0;             // distance into segments[0]
  let segIndex = 0;                // counts segments cleared (for difficulty)

  let speed = 16;
  const SPEED_ACC = 0.30;
  const SPEED_MAX = 50;

  let distance = 0, coins = 0, score = 0;
  let best = +(localStorage.getItem('temple_roc_best') || 0);
  bestEl.textContent = `best ${best}`;

  // post-turn camera swing animation
  let turnAnim = 0, turnDir = 0;
  const TURN_ANIM_TIME = 0.25;
  let flashAlpha = 0;

  function makeSegment(empty = false) {
    const len = 32 + Math.random() * 18;        // 32 – 50, all in seg-local units
    /** @type {Obstacle[]} */ const obstacles = [];
    /** @type {Coin[]}     */ const coinsArr  = [];
    if (!empty) {
      // Obstacles live in seg-local coords; player starts at z=0.
      // 20 units of grace ≈ 1.25s at speed 16 — never anything right after a turn.
      let z = 20;
      let lastType = null;
      while (z < len - 6) {                     // leave room before the end wall
        let type;
        // Re-roll until we don't get two consecutive 'low' jumps (too punishing).
        do {
          const r = Math.random();
          if (r < 0.40)      type = 'low';
          else if (r < 0.65) type = 'high';
          else if (r < 0.85) type = 'side';
          else               type = 'coins';
        } while (type === 'low' && lastType === 'low');

        if      (type === 'low')   obstacles.push({ z, type: 'low' });
        else if (type === 'high')  obstacles.push({ z, type: 'high' });
        else if (type === 'side')  obstacles.push({ z, type: 'side', side: Math.random() < 0.5 ? -1 : 1 });
        else /* coins */           { for (let i = 0; i < 4; i++) coinsArr.push({ z: z + i * 0.8 }); }

        lastType = type;
        z += 10 + Math.random() * 6;   // 10–16 units between obstacles
      }
    }
    return { len, exit: Math.random() < 0.5 ? 'L' : 'R', obstacles, coins: coinsArr };
  }

  function ensureSegments() {
    while (segments.length < 3) {
      // First segment of a fresh run is empty so the player can learn the turn cue
      const empty = segments.length === 0 && segIndex === 0;
      segments.push(makeSegment(empty));
    }
  }
  function currentSeg() { return segments[0]; }
  ensureSegments();   // populate before the first render frame

  function nextSegment() {
    segments.shift();
    segProgress = 0;                            // start fresh in new seg
    segIndex++;
    ensureSegments();
  }

  function reset() {
    segments = []; ensureSegments();
    segProgress = 0; segIndex = 0;
    player.leanX = 0; player.y = 0; player.vy = 0; player.sliding = 0; player.pendingSlide = false; player.state = 'run';
    speed = 16; distance = 0; coins = 0; score = 0;
    turnAnim = 0; flashAlpha = 0; turnIntent = null;
    scoreEl.textContent = '0';
    coinsEl.textContent = '🪙 0';
  }

  // ---------- update ----------
  function update(dt) {
    if (player.state !== 'run') return;

    if (turnAnim > 0)   turnAnim   = Math.max(0, turnAnim   - dt);
    if (flashAlpha > 0) flashAlpha = Math.max(0, flashAlpha - dt * 4);

    const i = consumeJumpSlide();
    if (i.jump && player.y === 0) { player.vy = JUMP_VY; player.sliding = 0; player.pendingSlide = false; }
    if (i.slide) {
      if (player.y === 0) {
        player.sliding = SLIDE_TIME;
      } else {
        // mid-air slide → fast-fall, slide kicks in the instant you land
        player.vy = -22;
        player.pendingSlide = true;
      }
    }

    // physics
    player.vy -= GRAVITY * dt;
    player.y  += player.vy * dt;
    if (player.y <= 0) {
      player.y = 0; player.vy = 0;
      if (player.pendingSlide) { player.sliding = SLIDE_TIME; player.pendingSlide = false; }
    }
    if (player.sliding > 0) player.sliding -= dt;

    // lean (hold left/right)
    let leanT = 0;
    if (held.left  && !held.right) leanT = -1;
    if (held.right && !held.left)  leanT =  1;
    player.leanX += (leanT - player.leanX) * Math.min(1, LEAN_RATE * dt);
    if (Math.abs(player.leanX) > LEAN_DEATH) return die();

    // forward motion
    speed = Math.min(SPEED_MAX, speed + SPEED_ACC * dt);
    const ds = speed * dt;
    distance    += ds;
    segProgress += ds;

    const seg = currentSeg();
    const distToEnd = seg.len - segProgress;   // segProgress is now the PLAYER's seg-local position

    // turn handling
    const inZone   = Math.abs(distToEnd) < TURN_WINDOW;
    const intentOk = turnIntent && performance.now() < turnIntentExpire;
    if (intentOk && inZone) {
      if (turnIntent === seg.exit) {
        turnDir   = turnIntent === 'L' ? -1 : 1;
        turnAnim  = TURN_ANIM_TIME;
        flashAlpha = 0.55;
        turnIntent = null;
        nextSegment();
        score = Math.floor(distance * 0.5 + coins * 25);
        scoreEl.textContent = String(score);
        return;
      }
      turnIntent = null;
    }
    // overshoot → smashed into the end wall
    if (distToEnd < -TURN_WINDOW * 0.6) return die();

    // collisions: obstacle at o.z hits when |o.z - segProgress| < 0.7 (player is at z=segProgress)
    for (const o of seg.obstacles) {
      const dz = o.z - segProgress;
      if (Math.abs(dz) > 0.7) continue;
      let hit = true;
      if (o.type === 'low'  && player.y > 0.9)     hit = false;
      if (o.type === 'high' && player.sliding > 0) hit = false;
      if (o.type === 'side') {
        // pillar sits offset to `side`; safe if leaning AWAY by more than half
        const safeSign = -o.side;
        if (Math.sign(player.leanX) === safeSign && Math.abs(player.leanX) > 0.5) hit = false;
      }
      if (hit) return die();
    }

    for (const c of seg.coins) {
      if (c.picked) continue;
      if (Math.abs(c.z - segProgress) > 0.7) continue;
      c.picked = true;
      coins++;
    }

    score = Math.floor(distance * 0.5 + coins * 25);
    scoreEl.textContent = String(score);
    coinsEl.textContent = `🪙 ${coins}`;
  }

  function die() {
    player.state = 'dead';

    // Make sure the displayed score is the latest — otherwise update() may have
    // returned early via die() before the per-frame `score = …` line ran.
    score = Math.floor(distance * 0.5 + coins * 25);
    scoreEl.textContent = String(score);
    coinsEl.textContent = `🪙 ${coins}`;

    if (score > best) {
      best = score;
      localStorage.setItem('temple_roc_best', String(best));
      bestEl.textContent = `best ${best}`;
    }

    // Breakdown — exact, since coins*25 is integer:
    //   floor(distance/2 + coins*25) === floor(distance/2) + coins*25
    const distPts = Math.floor(distance * 0.5);
    const coinPts = coins * 25;
    finalDist.textContent     = String(distPts);
    finalCoinPts.textContent  = String(coinPts);
    finalScore.textContent    = String(score);
    finalBest.textContent     = `personal best ${best}`;

    gameover.classList.remove('hide');
    gameover.classList.add('show');
    if (bgm) try { bgm.pause(); } catch (_) {}
    submitScore();
  }

  // ---------- render ----------
  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, horizon());
    g.addColorStop(0, '#6b3a1f');
    g.addColorStop(1, '#2a1408');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, horizon());

    // distant temple silhouette
    ctx.fillStyle = '#1a0a04';
    const hy = horizon();
    ctx.beginPath();
    ctx.moveTo(0, hy);
    ctx.lineTo(W * 0.10, hy - 30);
    ctx.lineTo(W * 0.18, hy - 10);
    ctx.lineTo(W * 0.30, hy - 50);
    ctx.lineTo(W * 0.40, hy - 18);
    ctx.lineTo(W * 0.55, hy - 70);
    ctx.lineTo(W * 0.65, hy - 22);
    ctx.lineTo(W * 0.78, hy - 40);
    ctx.lineTo(W * 0.90, hy - 12);
    ctx.lineTo(W,         hy - 30);
    ctx.lineTo(W,         hy);
    ctx.closePath(); ctx.fill();
  }

  // segProgress is now the player's seg-local position. The camera sits PLAYER_Z behind.
  // For an object at seg-local z=Z, its camera-relative depth is Z + PLAYER_Z - segProgress.
  function camRel(zSegLocal) { return zSegLocal + PLAYER_Z - segProgress; }

  function drawCorridor() {
    const seg = currentSeg();
    const wallCam = seg.len + PLAYER_Z - segProgress;     // depth of end-wall
    const farZ   = Math.min(FAR_Z, wallCam);
    const NEAR   = 0.5;

    // path floor with motion banding (no side walls — open path over the void)
    const slices = 18;
    const phase  = (distance * 0.5) % 1;
    for (let i = 0; i < slices; i++) {
      const z0 = NEAR + (farZ - NEAR) * (i / slices);
      const z1 = NEAR + (farZ - NEAR) * ((i + 1) / slices);
      const lN = project(-ROAD_HALF, 0, z0);
      const rN = project( ROAD_HALF, 0, z0);
      const lF = project(-ROAD_HALF, 0, z1);
      const rF = project( ROAD_HALF, 0, z1);
      const band = ((i + Math.floor(phase * slices)) % 2 === 0);
      ctx.fillStyle = band ? '#7a5b3a' : '#6a4d2e';
      ctx.beginPath();
      ctx.moveTo(lN.x, lN.y); ctx.lineTo(rN.x, rN.y);
      ctx.lineTo(rF.x, rF.y); ctx.lineTo(lF.x, lF.y);
      ctx.closePath(); ctx.fill();
    }

    // 90° branch corridor on the inner side of the upcoming turn — drawn
    // BEFORE the wall and edge highlights so the wall still stamps over the
    // outer side and the path edge stops at the corner.
    if (wallCam > NEAR + 0.5 && wallCam < FAR_Z) {
      const dir   = seg.exit === 'L' ? -1 : 1;
      const ext   = 9;                                  // how far the side corridor extends
      const xNear = dir * ROAD_HALF;
      const xFar  = dir * (ROAD_HALF + ext);
      const zNear = wallCam - ROAD_HALF;
      const zFar  = wallCam + ROAD_HALF;

      // banding strips drawn perpendicular to the new direction of travel
      const bands = 5;
      for (let bi = 0; bi < bands; bi++) {
        const f0 = bi / bands, f1 = (bi + 1) / bands;
        const x0 = xNear + (xFar - xNear) * f0;
        const x1 = xNear + (xFar - xNear) * f1;
        const c1 = project(x0, 0, zNear);
        const c2 = project(x1, 0, zNear);
        const c3 = project(x1, 0, zFar);
        const c4 = project(x0, 0, zFar);
        ctx.fillStyle = bi % 2 === 0 ? '#7a5b3a' : '#6a4d2e';
        ctx.beginPath();
        ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y);
        ctx.lineTo(c3.x, c3.y); ctx.lineTo(c4.x, c4.y);
        ctx.closePath(); ctx.fill();
      }

      // gold edge along the FAR side of the branch corridor (the "outer" rail of the new path)
      ctx.strokeStyle = 'rgba(244,194,103,.30)';
      ctx.lineWidth = 2;
      const ec1 = project(xNear, 0, zFar);
      const ec2 = project(xFar,  0, zFar);
      ctx.beginPath(); ctx.moveTo(ec1.x, ec1.y); ctx.lineTo(ec2.x, ec2.y); ctx.stroke();
    }

    // path edge highlights — clip the inner edge at the corner so it doesn't draw across the branch
    ctx.strokeStyle = 'rgba(244,194,103,.25)';
    ctx.lineWidth = 2;
    for (const x of [-ROAD_HALF, ROAD_HALF]) {
      const stopZ = (wallCam < FAR_Z && Math.sign(x) === (seg.exit === 'L' ? -1 : 1))
        ? Math.max(NEAR, wallCam - ROAD_HALF)         // inner edge stops at the corner
        : farZ;                                       // outer edge runs to the wall
      const a = project(x, 0, NEAR);
      const b = project(x, 0, stopZ);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Solid end wall blocking straight passage. Player must turn.
    if (wallCam > NEAR + 0.5 && wallCam < FAR_Z) {
      const z = wallCam;
      const wallH = 2.6;
      const bL = project(-ROAD_HALF, 0, z),     bR = project(ROAD_HALF, 0, z);
      const tL = project(-ROAD_HALF, wallH, z), tR = project(ROAD_HALF, wallH, z);
      ctx.fillStyle = '#5a3a22';
      ctx.beginPath();
      ctx.moveTo(bL.x, bL.y); ctx.lineTo(bR.x, bR.y);
      ctx.lineTo(tR.x, tR.y); ctx.lineTo(tL.x, tL.y);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#1a0a04'; ctx.lineWidth = 2; ctx.stroke();

      // big glowing arrow centered on the wall, pointing toward the branch corridor
      const a = project(0, 1.6, z);
      const fontPx = Math.max(28, Math.min(180, a.s * 1.1));
      ctx.font = `bold ${fontPx}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = '#f4c267';
      ctx.shadowBlur = fontPx * 0.4;
      ctx.fillStyle = '#fff7c2';
      ctx.fillText(seg.exit === 'L' ? '←' : '→', a.x, a.y);
      ctx.shadowBlur = 0;
    }

    // floor chevron pointing toward the exit during the last few units before the wall
    const distToEnd = seg.len - segProgress;
    if (distToEnd > 0 && distToEnd < 8) {
      const dir = seg.exit === 'L' ? -1 : 1;
      const fade = Math.min(1, (8 - distToEnd) / 4) * 0.6;
      ctx.fillStyle = `rgba(244,194,103,${fade})`;
      // three stacked chevrons starting just ahead of the player
      for (let i = 0; i < 3; i++) {
        const cz = camRel(segProgress + 2 + i * 1.2);
        const w = 0.6, h = 0.4;
        const tip = project(dir * w, 0.02, cz);
        const ll  = project(-dir * w * 0.2, 0.02, cz - h);
        const lr  = project(-dir * w * 0.2, 0.02, cz + h);
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y); ctx.lineTo(ll.x, ll.y); ctx.lineTo(lr.x, lr.y);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  function drawObstacle(o, z) {
    if (o.type === 'low') {
      // Spans nearly the full path width — clearly a "jump it" obstacle, not dodgeable by leaning.
      const w = ROAD_HALF - 0.05;
      const bl = project(-w, 0,   z), br = project(w, 0,   z);
      const tl = project(-w, 0.7, z), tr = project(w, 0.7, z);
      ctx.fillStyle = '#8a6a45';
      ctx.beginPath();
      ctx.moveTo(bl.x, bl.y); ctx.lineTo(br.x, br.y);
      ctx.lineTo(tr.x, tr.y); ctx.lineTo(tl.x, tl.y);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#3a2616'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#4a6a3a';
      ctx.fillRect(tl.x, tl.y - 2, tr.x - tl.x, 4);
    } else if (o.type === 'high') {
      const bl = project(-0.8, 1.6, z), br = project(0.8, 1.6, z);
      const tl = project(-0.8, 2.3, z), tr = project(0.8, 2.3, z);
      ctx.fillStyle = '#5a3a22';
      ctx.beginPath();
      ctx.moveTo(bl.x, bl.y); ctx.lineTo(br.x, br.y);
      ctx.lineTo(tr.x, tr.y); ctx.lineTo(tl.x, tl.y);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#1a0a04'; ctx.lineWidth = 2; ctx.stroke();
    } else {
      // freestanding side-pillar / brazier — sits offset toward `side`
      const cx = o.side * 0.85;                 // off-center within path
      const bl = project(cx - 0.25, 0,   z), br = project(cx + 0.25, 0,   z);
      const tl = project(cx - 0.25, 1.5, z), tr = project(cx + 0.25, 1.5, z);
      ctx.fillStyle = '#3a2010';
      ctx.beginPath();
      ctx.moveTo(bl.x, bl.y); ctx.lineTo(br.x, br.y);
      ctx.lineTo(tr.x, tr.y); ctx.lineTo(tl.x, tl.y);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#1a0a04'; ctx.lineWidth = 2; ctx.stroke();
      // flame on top
      const fl = project(cx, 1.7, z);
      const r = Math.max(3, fl.s * 0.18);
      const flicker = 0.85 + 0.15 * Math.sin(performance.now() * 0.02 + z);
      const grad = ctx.createRadialGradient(fl.x, fl.y, 0, fl.x, fl.y, r * flicker);
      grad.addColorStop(0, '#fff7c2'); grad.addColorStop(0.5, '#f4a043'); grad.addColorStop(1, 'rgba(244,160,67,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(fl.x, fl.y, r * flicker, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawCoin(c, z) {
    const p = project(0, 0.6, z);
    const r = Math.max(2, p.s * 0.18);
    const t  = performance.now() * 0.005 + z;
    const sx = Math.max(0.2, Math.cos(t));
    ctx.fillStyle = '#f4c267';
    ctx.beginPath(); ctx.ellipse(p.x, p.y, r * sx, r, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#8a6a2a'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  function drawObstacles() {
    const seg = currentSeg();
    const items = [];
    for (const o of seg.obstacles) {
      const z = camRel(o.z);
      if (z > 0.5 && z < FAR_Z) items.push({ kind: 'obs', z, ref: o });
    }
    for (const c of seg.coins) {
      if (c.picked) continue;
      const z = camRel(c.z);
      if (z > 0.5 && z < FAR_Z) items.push({ kind: 'coin', z, ref: c });
    }
    items.sort((a, b) => b.z - a.z);
    for (const it of items) {
      if (it.kind === 'obs') drawObstacle(it.ref, it.z);
      else                   drawCoin(it.ref, it.z);
    }
  }

  // Project a flat sprite quad at a single z and stamp the given video onto it.
  function drawSprite(video, x, yBase, tall, z, fallbackFill) {
    const aspect = (video && video.videoHeight) ? (video.videoWidth / video.videoHeight) : 0.5;
    const wide   = tall * aspect / 2;

    const left  = project(x - wide, yBase,        z);
    const right = project(x + wide, yBase + tall, z);
    const sx = Math.min(left.x, right.x);
    const sy = Math.min(left.y, right.y);
    const sw = Math.abs(right.x - left.x);
    const sh = Math.abs(right.y - left.y);

    if (videoReady(video)) {
      ctx.drawImage(video, sx, sy, sw, sh);
    } else if (fallbackFill) {
      ctx.fillStyle = fallbackFill;
      ctx.fillRect(sx, sy, sw, sh);
    }
  }

  function drawChaser() {
    if (!videoReady(charChaser)) return;
    // Fixed-position HUD sprite at the bottom-center — represents the chaser
    // right behind the camera. Smaller than the player by design.
    const v = charChaser;
    const aspect = v.videoWidth / v.videoHeight;
    const targetH = H * 0.16;
    const targetW = targetH * aspect;
    const sx = (W - targetW) / 2 + player.leanX * 14;   // tiny lateral follow
    const sy = H - targetH - 4;
    // ground shadow blob
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.beginPath();
    ctx.ellipse(W / 2, H - 6, targetW * 0.45, targetH * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.drawImage(v, sx, sy, targetW, targetH);
  }

  function drawPlayer() {
    const z = PLAYER_Z;
    const x = player.leanX * (ROAD_HALF - 0.5);
    const yBase = player.y;
    const tall  = player.sliding > 0 ? 1.1 : 1.9;

    // shadow on the ground
    const sh = project(x, 0, z);
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.beginPath(); ctx.ellipse(sh.x, sh.y, 38, 10, 0, 0, Math.PI * 2); ctx.fill();

    drawSprite(charPlayer, x, yBase, tall, z, '#d65a2a');
  }

  function render() {
    ctx.clearRect(0, 0, W, H);

    let restored = false;
    if (turnAnim > 0) {
      // small camera swing during the post-turn animation
      const t = 1 - turnAnim / TURN_ANIM_TIME;          // 0 → 1
      const angle = turnDir * (1 - t) * (Math.PI / 8);  // ease-out
      ctx.save();
      ctx.translate(W / 2, horizon());
      ctx.rotate(angle);
      ctx.translate(-W / 2, -horizon());
      restored = true;
    }

    drawSky();
    drawCorridor();
    drawObstacles();
    drawPlayer();
    drawChaser();      // fixed HUD sprite at the bottom — drawn last so it sits on top

    if (restored) ctx.restore();

    if (flashAlpha > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${flashAlpha})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ---------- score submission ----------
  let submitted = false;
  async function submitScore() {
    if (submitted) return;
    submitted = true;
    if (!auth.uid || !auth.sig) return;
    try {
      await fetch('https://temple-roc.tanchienhao.workers.dev/submit_score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: auth.uid, sig: auth.sig,
          cid: auth.cid, mid: auth.mid, imid: auth.imid,
          score,
        }),
      });
    } catch (_) { /* offline — keep local best only */ }
  }

  // ---------- loop ----------
  let last = performance.now();
  let running = false;
  let paused  = false;                // help modal opened during a run
  let everStarted = false;            // don't paint anything until first run begins
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (running && !paused) update(dt);
    if (everStarted) render();        // before that the canvas stays transparent so the intro video shows
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  function startGame() {
    reset();
    overlay.classList.add('hide');   overlay.classList.remove('show');
    gameover.classList.add('hide');  gameover.classList.remove('show');
    if (intro) { intro.classList.add('gone'); try { intro.pause(); } catch (_) {} }
    running = true;
    everStarted = true;
    submitted = false;
    // Make sure the sprite videos are running (autoplay may have been blocked until now)
    kickSpriteVideos();
    // Background music — loops, picks up from where it left off on Run Again.
    if (bgm) {
      bgm.loop = true;
      try { bgm.play().catch(() => {}); } catch (_) {}
    }
  }

  // First click goes through the intro video; subsequent runs (Run Again) skip straight in.
  let introPlayed = false;
  function playIntroThenStart() {
    if (introPlayed || !intro || intro.error) { startGame(); return; }
    overlay.classList.add('hide');   overlay.classList.remove('show');
    intro.classList.remove('gone');
    intro.currentTime = 0;
    const finish = () => {
      if (introPlayed) return;
      introPlayed = true;
      intro.classList.add('gone');           // CSS fade
      // Start the run mid-fade so the canvas is already rendering when video clears.
      setTimeout(startGame, 120);
      setTimeout(() => { intro.pause(); intro.removeAttribute('src'); }, 600);
    };
    intro.addEventListener('ended', finish, { once: true });
    intro.addEventListener('error', finish, { once: true });
    intro.play().catch(finish);              // autoplay refused → just begin
  }

  // Show the first frame of the video on load so the start menu isn't black.
  // Some browsers don't paint until played; nudging currentTime forces a frame.
  intro.addEventListener('loadeddata', () => {
    if (intro.readyState >= 2) intro.currentTime = 0.01;
  }, { once: true });

  playBtn.addEventListener('click',  playIntroThenStart);
  againBtn.addEventListener('click', startGame);
  shareBtn.addEventListener('click', () => {
    try { window.TelegramGameProxy && TelegramGameProxy.shareScore(); } catch (_) {}
  });

  // Help menu — pauses an active run, resumes on close.
  function openHelp() {
    if (running && player.state === 'run') {
      paused = true;
      if (bgm) try { bgm.pause(); } catch (_) {}
    }
    helpModal.classList.remove('hide');
    helpModal.classList.add('show');
  }
  function closeHelp() {
    helpModal.classList.add('hide');
    helpModal.classList.remove('show');
    if (paused) {
      paused = false;
      last = performance.now();   // reset dt baseline so the world doesn't lurch forward
      if (bgm) try { bgm.play().catch(() => {}); } catch (_) {}
    }
  }
  helpBtn.addEventListener('click', openHelp);
  helpClose.addEventListener('click', closeHelp);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !helpModal.classList.contains('hide')) closeHelp();
  });
})();
