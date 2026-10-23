// Touch/click effects drawn on a 2D canvas that sits between the background and the notes.
// Water, vortex and melt also warp the WebGL background itself (via Backgrounds.addTouch).
// The animation loop only runs while something is on screen, so an idle window costs nothing.

window.Effects = (() => {
  const EFFECTS = [
    { id: "water", label: "💧 Water" },
    { id: "raindrops", label: "🌧️ Raindrops" },
    { id: "thunderstorm", label: "⛈️ Thunderstorm" },
    { id: "vortex", label: "🌀 Vortex" },
    { id: "melt", label: "🫠 Melt" },
    { id: "fireworks", label: "🎆 Fireworks" },
    { id: "bubbles", label: "🫧 Bubbles" },
    { id: "snow", label: "❄️ Snow" },
    { id: "off", label: "Off" },
  ];

  let canvas = null;
  let ctx = null;
  let flashElement = null;
  let shakeElement = null;
  let effect = "water";
  let ambient = false;
  let soundOn = false;
  let running = false;
  let paused = false; // while the window is hidden behind the bubble
  let lastTimestamp = 0;
  let nextAmbientAt = 0;

  let ripples = [];
  let splashes = [];
  let drops = [];
  let dropTrails = [];
  let bolts = [];
  let rainStreaks = [];
  let sparks = [];
  let bubbles = [];
  let flakes = [];
  let orbiters = [];
  let drips = [];

  const random = (min, max) => min + Math.random() * (max - min);
  const width = () => window.innerWidth;
  const height = () => window.innerHeight;

  // ---------- sound (synthesised, so there are no audio files to ship) ----------

  let audioContext = null;

  function getAudioContext() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
    return audioContext;
  }

  function playTone({ wave = "sine", from, to, duration, volume, delay = 0 }) {
    if (!soundOn) return;
    const audio = getAudioContext();
    const start = audio.currentTime + delay;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(from, start);
    oscillator.frequency.exponentialRampToValueAtTime(to, start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.05);
  }

  function playNoise({ duration, filter = "lowpass", from, to = from, volume, delay = 0, attack = 0.01 }) {
    if (!soundOn) return;
    const audio = getAudioContext();
    const start = audio.currentTime + delay;
    const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * duration), audio.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    const source = audio.createBufferSource();
    source.buffer = buffer;
    const biquad = audio.createBiquadFilter();
    biquad.type = filter;
    biquad.frequency.setValueAtTime(from, start);
    biquad.frequency.exponentialRampToValueAtTime(to, start + duration);
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(biquad).connect(gain).connect(audio.destination);
    source.start(start);
  }

  // ---------- water ----------

  function startWater(x, y) {
    Backgrounds.addTouch(x, y, "water");
    ripples.push({ x, y, age: 0 });
    for (let i = 0; i < 9; i++) {
      const angle = random(-Math.PI * 0.9, -Math.PI * 0.1);
      const speed = random(80, 220);
      splashes.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, r: random(1.5, 3.5), age: 0, life: random(0.4, 0.8) });
    }
    playTone({ from: random(1000, 1400), to: 300, duration: 0.18, volume: 0.2 });
    playTone({ from: 700, to: 220, duration: 0.25, volume: 0.08, delay: 0.05 });
  }

  function updateAndDrawWater(dt) {
    ripples = ripples.filter((ripple) => (ripple.age += dt) < 2.5);
    for (const ripple of ripples) {
      for (let ring = 0; ring < 3; ring++) {
        const radius = ripple.age * 230 - ring * 22;
        if (radius <= 0) continue;
        const alpha = Math.max(0, 0.45 * (1 - ripple.age / 2.5) - ring * 0.1);
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
        ctx.lineWidth = 2.2 - ring * 0.5;
        ctx.beginPath();
        ctx.ellipse(ripple.x, ripple.y, radius, radius * 0.92, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    splashes = splashes.filter((drop) => (drop.age += dt) < drop.life);
    for (const drop of splashes) {
      drop.vy += 600 * dt;
      drop.x += drop.vx * dt;
      drop.y += drop.vy * dt;
      ctx.fillStyle = `rgba(220,240,255,${0.8 * (1 - drop.age / drop.life)})`;
      ctx.beginPath();
      ctx.arc(drop.x, drop.y, drop.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------- raindrops on glass ----------

  function addRaindrop(x, y, r) {
    drops.push({ x, y, r, vy: 0, pause: random(0.2, 1.2), age: 0, life: r < 5 ? random(5, 10) : Infinity, distanceSinceTrail: 0 });
    if (drops.length > 160) drops.shift();
  }

  function startRaindrops(x, y) {
    addRaindrop(x, y, random(10, 15));
    for (let i = 0; i < 5; i++) addRaindrop(x + random(-60, 60), y + random(-40, 40), random(2.5, 7));
    playTone({ from: 1900, to: 900, duration: 0.06, volume: 0.1 });
  }

  function drawGlassBead(x, y, r, alpha) {
    const gradient = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r * 1.1);
    gradient.addColorStop(0, `rgba(255,255,255,${0.5 * alpha})`);
    gradient.addColorStop(0.45, `rgba(255,255,255,${0.08 * alpha})`);
    gradient.addColorStop(0.85, `rgba(0,0,0,${0.12 * alpha})`);
    gradient.addColorStop(1, `rgba(0,0,0,${0.3 * alpha})`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 1.15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${0.85 * alpha})`;
    ctx.beginPath();
    ctx.ellipse(x - r * 0.35, y - r * 0.45, r * 0.22, r * 0.15, -0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function updateAndDrawRaindrops(dt) {
    for (const drop of drops) {
      drop.age += dt;
      // Big drops stick, then slide in jerks as they gather water, like on a window.
      if (drop.r >= 6) {
        if (drop.pause > 0) {
          drop.pause -= dt;
          drop.vy = 0;
        } else {
          drop.vy = Math.min(drop.vy + 400 * dt, 60 + drop.r * 12);
          const step = drop.vy * dt;
          drop.y += step;
          drop.x += random(-0.6, 0.6);
          drop.distanceSinceTrail += step;
          if (drop.distanceSinceTrail > 10) {
            drop.distanceSinceTrail = 0;
            dropTrails.push({ x: drop.x + random(-1.5, 1.5), y: drop.y - drop.r, r: random(1, drop.r * 0.35), age: 0, life: random(2, 4) });
            drop.r = Math.max(6, drop.r - 0.05);
          }
          if (Math.random() < dt * 0.8) drop.pause = random(0.1, 0.6);
        }
      }
    }
    drops = drops.filter((drop) => drop.y < height() + 30 && drop.age < drop.life);
    dropTrails = dropTrails.filter((trail) => (trail.age += dt) < trail.life);
    for (const trail of dropTrails) drawGlassBead(trail.x, trail.y, trail.r, 1 - trail.age / trail.life);
    for (const drop of drops) {
      const grow = Math.min(1, drop.age * 6);
      const fade = drop.life === Infinity ? 1 : Math.min(1, (drop.life - drop.age) / 1.5);
      drawGlassBead(drop.x, drop.y, drop.r * grow, fade);
    }
  }

  // ---------- thunderstorm ----------

  function buildBoltPath(x0, y0, x1, y1, roughness, depth) {
    // Midpoint displacement: split each segment and nudge the middle sideways.
    let points = [[x0, y0], [x1, y1]];
    let offset = roughness;
    for (let level = 0; level < depth; level++) {
      const next = [points[0]];
      for (let i = 1; i < points.length; i++) {
        const [ax, ay] = points[i - 1];
        const [bx, by] = points[i];
        next.push([(ax + bx) / 2 + random(-offset, offset), (ay + by) / 2 + random(-offset * 0.3, offset * 0.3)]);
        next.push(points[i]);
      }
      points = next;
      offset /= 2;
    }
    return points;
  }

  function strikeLightning(x, y) {
    const startX = x + random(-180, 180);
    const main = buildBoltPath(startX, -10, x, y, 120, 6);
    const branches = [];
    for (let i = 0; i < 4; i++) {
      const [bx, by] = main[Math.floor(random(main.length * 0.2, main.length * 0.8))];
      const length = random(60, 180);
      const angle = random(0.3, 1.2) * (Math.random() < 0.5 ? -1 : 1);
      branches.push(buildBoltPath(bx, by, bx + Math.sin(angle) * length, by + Math.cos(angle) * length, 40, 4));
    }
    bolts.push({ main, branches, age: 0, life: 0.7 });
    flashScreen();
    shakeBoard();
    playNoise({ duration: 0.25, filter: "highpass", from: 1500, volume: 0.35 });
    playNoise({ duration: 3.2, filter: "lowpass", from: 260, to: 60, volume: 0.9, delay: random(0.15, 0.6), attack: 0.3 });
  }

  function flashScreen() {
    flashElement.classList.remove("flash");
    void flashElement.offsetWidth; // restart the CSS animation
    flashElement.classList.add("flash");
  }

  function shakeBoard() {
    shakeElement.classList.remove("shake");
    void shakeElement.offsetWidth;
    shakeElement.classList.add("shake");
  }

  function strokePath(points) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.stroke();
  }

  function keepRainFalling(dt) {
    const target = Math.min(260, Math.round((width() * height()) / 5000));
    while (rainStreaks.length < target) {
      rainStreaks.push({ x: random(-50, width()), y: random(-height(), height()), length: random(12, 26), speed: random(700, 1100) });
    }
    rainStreaks.length = Math.min(rainStreaks.length, target);
    ctx.strokeStyle = "rgba(200,220,255,0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const streak of rainStreaks) {
      streak.y += streak.speed * dt;
      streak.x += streak.speed * 0.15 * dt;
      if (streak.y > height()) {
        streak.y = random(-60, -10);
        streak.x = random(-50, width());
      }
      ctx.moveTo(streak.x, streak.y);
      ctx.lineTo(streak.x - streak.length * 0.15, streak.y - streak.length);
    }
    ctx.stroke();
  }

  function updateAndDrawStorm(dt) {
    if (effect === "thunderstorm") keepRainFalling(dt);
    else rainStreaks = [];
    bolts = bolts.filter((bolt) => (bolt.age += dt) < bolt.life);
    for (const bolt of bolts) {
      const flicker = Math.random() < 0.25 ? 0.35 : 1;
      const alpha = flicker * (1 - bolt.age / bolt.life);
      ctx.save();
      ctx.shadowColor = "rgba(150,200,255,1)";
      ctx.shadowBlur = 28;
      ctx.strokeStyle = `rgba(235,245,255,${alpha})`;
      ctx.lineWidth = 3.2;
      strokePath(bolt.main);
      ctx.lineWidth = 1.4;
      for (const branch of bolt.branches) strokePath(branch);
      ctx.restore();
    }
  }

  // ---------- vortex & melt (the background shader does most of the work) ----------

  function startVortex(x, y) {
    Backgrounds.addTouch(x, y, "vortex");
    for (let i = 0; i < 50; i++) {
      orbiters.push({ cx: x, cy: y, angle: random(0, Math.PI * 2), radius: random(60, 260), spin: random(2.5, 5), hue: random(0, 360), age: 0, life: random(1.5, 2.8) });
    }
    playNoise({ duration: 1.6, filter: "bandpass", from: 200, to: 1800, volume: 0.25, attack: 0.4 });
  }

  function updateAndDrawOrbiters(dt) {
    orbiters = orbiters.filter((orbiter) => (orbiter.age += dt) < orbiter.life && orbiter.radius > 3);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const orbiter of orbiters) {
      orbiter.angle += orbiter.spin * dt * (1 + 120 / orbiter.radius);
      orbiter.radius *= 1 - dt * 1.1;
      const x = orbiter.cx + Math.cos(orbiter.angle) * orbiter.radius;
      const y = orbiter.cy + Math.sin(orbiter.angle) * orbiter.radius;
      ctx.fillStyle = `hsla(${orbiter.hue},100%,70%,${1 - orbiter.age / orbiter.life})`;
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function startMelt(x, y) {
    Backgrounds.addTouch(x, y, "melt");
    for (let i = 0; i < 6; i++) {
      drips.push({ x: x + random(-90, 90), y: y + random(-10, 10), length: 0, maxLength: random(80, 320), width: random(4, 12), age: 0, life: random(4, 7) });
    }
    playTone({ from: 320, to: 70, duration: 0.9, volume: 0.18 });
  }

  function updateAndDrawDrips(dt) {
    drips = drips.filter((drip) => (drip.age += dt) < drip.life);
    for (const drip of drips) {
      drip.length = drip.maxLength * Math.min(1, drip.age / 2.2) ** 0.7;
      const alpha = 0.3 * Math.min(1, (drip.life - drip.age) / 1.5);
      const gradient = ctx.createLinearGradient(drip.x, drip.y, drip.x + drip.width, drip.y);
      gradient.addColorStop(0, `rgba(255,255,255,0)`);
      gradient.addColorStop(0.35, `rgba(255,255,255,${alpha})`);
      gradient.addColorStop(1, `rgba(255,255,255,0)`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.roundRect(drip.x, drip.y, drip.width, drip.length, drip.width / 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(drip.x + drip.width / 2, drip.y + drip.length, drip.width * 0.75, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------- fireworks ----------

  function startFireworks(x, y) {
    const baseHue = random(0, 360);
    for (let i = 0; i < 70; i++) {
      const angle = random(0, Math.PI * 2);
      const speed = random(60, 280);
      sparks.push({ x, y, px: x, py: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, hue: baseHue + random(-35, 35), age: 0, life: random(0.9, 1.6) });
    }
    playNoise({ duration: 0.35, filter: "bandpass", from: 900, to: 300, volume: 0.4 });
    for (let i = 0; i < 6; i++) playNoise({ duration: 0.04, filter: "highpass", from: 3000, volume: 0.12, delay: random(0.3, 0.9) });
  }

  function updateAndDrawSparks(dt) {
    sparks = sparks.filter((spark) => (spark.age += dt) < spark.life);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 2;
    for (const spark of sparks) {
      spark.px = spark.x;
      spark.py = spark.y;
      spark.vx *= 1 - dt * 1.2;
      spark.vy = spark.vy * (1 - dt * 1.2) + 140 * dt;
      spark.x += spark.vx * dt;
      spark.y += spark.vy * dt;
      ctx.strokeStyle = `hsla(${spark.hue},100%,65%,${1 - spark.age / spark.life})`;
      ctx.beginPath();
      ctx.moveTo(spark.px, spark.py);
      ctx.lineTo(spark.x, spark.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- bubbles ----------

  function addBubble(x, y) {
    bubbles.push({ x, y, r: random(6, 24), vy: random(-95, -40), phase: random(0, 6), hue: random(0, 360), age: 0, life: random(2.5, 6), popped: false, popAge: 0 });
  }

  function startBubbles(x, y) {
    for (let i = 0; i < 12; i++) addBubble(x + random(-30, 30), y + random(-20, 20));
  }

  function updateAndDrawBubbles(dt) {
    for (const bubble of bubbles) {
      bubble.age += dt;
      if (bubble.popped) {
        bubble.popAge += dt;
        const alpha = 1 - bubble.popAge / 0.25;
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2;
          const inner = bubble.r * (1 + bubble.popAge * 3);
          ctx.beginPath();
          ctx.moveTo(bubble.x + Math.cos(angle) * inner, bubble.y + Math.sin(angle) * inner);
          ctx.lineTo(bubble.x + Math.cos(angle) * (inner + 5), bubble.y + Math.sin(angle) * (inner + 5));
          ctx.stroke();
        }
        continue;
      }
      bubble.y += bubble.vy * dt;
      bubble.x += Math.sin(bubble.age * 3 + bubble.phase) * 25 * dt;
      bubble.hue += 60 * dt;
      if (bubble.age > bubble.life || bubble.y < -bubble.r) {
        bubble.popped = true;
        playTone({ from: 500, to: 1300, duration: 0.06, volume: 0.12 });
        continue;
      }
      const gradient = ctx.createRadialGradient(bubble.x, bubble.y, bubble.r * 0.6, bubble.x, bubble.y, bubble.r);
      gradient.addColorStop(0, "rgba(255,255,255,0.02)");
      gradient.addColorStop(0.8, `hsla(${bubble.hue},100%,75%,0.18)`);
      gradient.addColorStop(1, `hsla(${bubble.hue + 120},100%,80%,0.45)`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(bubble.x, bubble.y, bubble.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.beginPath();
      ctx.ellipse(bubble.x - bubble.r * 0.4, bubble.y - bubble.r * 0.4, bubble.r * 0.22, bubble.r * 0.12, -0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    bubbles = bubbles.filter((bubble) => !bubble.popped || bubble.popAge < 0.25);
  }

  // ---------- snow ----------

  function newFallingFlake(startAbove) {
    return { x: random(0, width()), y: startAbove ? random(-40, -5) : random(0, height()), r: random(1, 3.5), vx: 0, vy: 0, fall: random(18, 55), phase: random(0, 6), puff: false };
  }

  function startSnowPuff(x, y) {
    for (let i = 0; i < 45; i++) {
      const angle = random(0, Math.PI * 2);
      const speed = random(60, 260);
      flakes.push({ x, y, r: random(1.2, 3.5), vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, fall: random(18, 55), phase: random(0, 6), puff: true });
    }
    playNoise({ duration: 0.35, filter: "highpass", from: 4000, volume: 0.05 });
  }

  function updateAndDrawSnow(dt) {
    if (effect === "snow") {
      const target = Math.min(220, Math.round((width() * height()) / 7000));
      let ambientCount = flakes.filter((flake) => !flake.puff).length;
      while (ambientCount++ < target) flakes.push(newFallingFlake(false));
    }
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    for (const flake of flakes) {
      // Puff velocity bleeds off until the flake is just drifting down like the rest.
      flake.vx *= 1 - Math.min(1, dt * 2.5);
      flake.vy *= 1 - Math.min(1, dt * 2.5);
      flake.phase += dt;
      flake.x += (flake.vx + Math.sin(flake.phase) * 15) * dt;
      flake.y += (flake.vy + flake.fall) * dt;
      if (flake.y > height() + 5 && !flake.puff && effect === "snow") Object.assign(flake, newFallingFlake(true));
      ctx.moveTo(flake.x + flake.r, flake.y);
      ctx.arc(flake.x, flake.y, flake.r, 0, Math.PI * 2);
    }
    ctx.fill();
    flakes = flakes.filter((flake) => flake.y < height() + 5 && (effect === "snow" || flake.puff));
  }

  // ---------- ambient mode: the effect happens on its own now and then ----------

  const AMBIENT_GAP_SECONDS = {
    water: [0.4, 1.6], raindrops: [0.15, 0.5], thunderstorm: [5, 14], vortex: [7, 14],
    melt: [9, 16], fireworks: [1.2, 3.5], bubbles: [0.4, 1.4], snow: [4, 9],
  };

  function runAmbientEffect(now) {
    if (!ambient || effect === "off" || now < nextAmbientAt) return;
    const [minGap, maxGap] = AMBIENT_GAP_SECONDS[effect];
    nextAmbientAt = now + random(minGap, maxGap);
    const x = random(0.1, 0.9) * width();
    const y = random(0.1, 0.9) * height();
    if (effect === "raindrops") addRaindrop(random(0, width()), random(0, height()), random(2, 9));
    else if (effect === "thunderstorm") strikeLightning(x, random(0.5, 0.95) * height());
    else if (effect === "fireworks") startFireworks(x, random(0.1, 0.5) * height());
    else if (effect === "bubbles") addBubble(random(0, width()), height() + 20);
    else if (effect === "snow") startSnowPuff(x, random(0.1, 0.4) * height());
    else trigger(x, y, { quiet: true });
  }

  // ---------- loop ----------

  function hasSomethingToDraw() {
    return ripples.length || splashes.length || drops.length || dropTrails.length || bolts.length
      || sparks.length || bubbles.length || flakes.length || orbiters.length || drips.length
      || effect === "thunderstorm" || effect === "snow" || (ambient && effect !== "off");
  }

  function onFrame(timestamp) {
    if (paused) {
      running = false;
      return;
    }
    const dt = lastTimestamp ? Math.min((timestamp - lastTimestamp) / 1000, 0.05) : 0.016;
    lastTimestamp = timestamp;
    resizeCanvas();
    ctx.clearRect(0, 0, width(), height());
    runAmbientEffect(timestamp / 1000);
    updateAndDrawStorm(dt);
    updateAndDrawWater(dt);
    updateAndDrawRaindrops(dt);
    updateAndDrawOrbiters(dt);
    updateAndDrawDrips(dt);
    updateAndDrawSparks(dt);
    updateAndDrawBubbles(dt);
    updateAndDrawSnow(dt);
    if (hasSomethingToDraw()) {
      requestAnimationFrame(onFrame);
    } else {
      running = false;
      ctx.clearRect(0, 0, width(), height());
    }
  }

  function ensureRunning() {
    if (running) return;
    running = true;
    lastTimestamp = 0;
    requestAnimationFrame(onFrame);
  }

  function resizeCanvas() {
    const ratio = window.devicePixelRatio || 1;
    const targetWidth = Math.round(width() * ratio);
    const targetHeight = Math.round(height() * ratio);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
  }

  function trigger(x, y, { quiet = false } = {}) {
    const wasSoundOn = soundOn;
    if (quiet && effect !== "thunderstorm") soundOn = false;
    try {
      if (effect === "water") startWater(x, y);
      else if (effect === "raindrops") startRaindrops(x, y);
      else if (effect === "thunderstorm") strikeLightning(x, y);
      else if (effect === "vortex") startVortex(x, y);
      else if (effect === "melt") startMelt(x, y);
      else if (effect === "fireworks") startFireworks(x, y);
      else if (effect === "bubbles") startBubbles(x, y);
      else if (effect === "snow") startSnowPuff(x, y);
    } finally {
      soundOn = wasSoundOn;
    }
    if (effect !== "off") ensureRunning();
  }

  return {
    EFFECTS,
    init(effectsCanvas, { flash, shakeTarget }) {
      canvas = effectsCanvas;
      ctx = canvas.getContext("2d");
      flashElement = flash;
      shakeElement = shakeTarget;
      resizeCanvas();
    },
    trigger,
    setEffect(id) {
      effect = EFFECTS.some((item) => item.id === id) ? id : "water";
      ensureRunning();
    },
    setAmbient(value) {
      ambient = Boolean(value);
      ensureRunning();
    },
    setPaused(value) {
      paused = Boolean(value);
      if (!paused) ensureRunning();
    },
    setSound(value) {
      soundOn = Boolean(value);
      if (soundOn) getAudioContext();
    },
  };
})();
