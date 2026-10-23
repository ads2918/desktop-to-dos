// Draws the animated background with WebGL. Renders at reduced resolution and ~30fps, and stops
// drawing entirely while the window is hidden or the background is set to "still" with no touch
// effects running, so it stays light on CPU/GPU while sitting on the desktop all day.

window.Backgrounds = (() => {
  const PRESETS = [
    { id: "tiedye", label: "Tie-dye", mode: 0, css: "conic-gradient(from 30deg, #ff3cac, #ffd23f, #3bf4fb, #8a4fff, #ff3cac)" },
    { id: "sunset", label: "Sunset", mode: 1, css: "linear-gradient(0deg, #ff8c26, #f24072, #5a1f73)" },
    { id: "ocean", label: "Ocean", mode: 2, css: "linear-gradient(0deg, #001f4d, #007399)" },
    { id: "aurora", label: "Aurora", mode: 3, css: "linear-gradient(0deg, #02040f, #0d2a3a 60%, #3fe38f 75%, #070f2e)" },
    { id: "neon", label: "Neon Acid", mode: 4, css: "linear-gradient(135deg, #39ff14, #ff00e6, #00e5ff)" },
    { id: "lava", label: "Lava Lamp", mode: 5, css: "radial-gradient(circle at 40% 60%, #ffb21a, #ff5a0d 25%, #4d0840 60%)" },
    { id: "cosmic", label: "Cosmic", mode: 6, css: "radial-gradient(circle at 30% 40%, #6b1a8a, #0a0018 70%)" },
    { id: "vortex", label: "Vortex", mode: 7, css: "repeating-conic-gradient(#ff3cac 0 15deg, #2b86c5 15deg 30deg)" },
    { id: "custom", label: "Your colours", mode: 8, css: "" },
  ];

  const MAX_TOUCHES = 8;
  const RENDER_SCALE = 0.5;
  const FRAME_INTERVAL_MS = 1000 / 30;
  const TOUCH_LIFETIME_SECONDS = { 1: 3.5, 2: 3.0, 3: 8.0 };

  let canvas = null;
  let gl = null;
  let uniforms = {};
  let preset = PRESETS[0];
  let customColors = ["#ff3cac", "#784ba0", "#2b86c5"];
  let speed = 1;
  let still = false;
  let animationTime = 0;
  let lastFrameAt = 0;
  let lastDrawAt = 0;
  let lastCaptureAt = 0;
  // Set while the window is hidden behind the bubble: Windows still lets the hidden page animate,
  // which cost as much CPU as the visible window for nothing. Bubble frames are drawn on request.
  let paused = false;
  let frameRequested = false;
  let touches = [];

  function hexToRgb(hex) {
    const value = parseInt(hex.replace("#", ""), 16);
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
  }

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error("Background shader failed to compile: " + gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  function setUpWebGl() {
    gl = canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL is not available.");
    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl.VERTEX_SHADER, SHADER_SOURCES.vertex));
    gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, SHADER_SOURCES.fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error("Background shader failed to link: " + gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    for (const name of ["u_resolution", "u_time", "u_mode", "u_color1", "u_color2", "u_color3", "u_touches"]) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }
  }

  // `size` overrides the window-based size, e.g. a small square for bubble frames.
  function resizeCanvasToWindow(size = null) {
    const width = size ? size.width : Math.max(1, Math.round(window.innerWidth * RENDER_SCALE));
    const height = size ? size.height : Math.max(1, Math.round(window.innerHeight * RENDER_SCALE));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      if (gl) gl.viewport(0, 0, width, height);
    }
  }

  function dropExpiredTouches() {
    const now = performance.now() / 1000;
    touches = touches.filter((touch) => now - touch.startedAt < TOUCH_LIFETIME_SECONDS[touch.kind]);
  }

  function drawFrame(size = null) {
    resizeCanvasToWindow(size);
    const now = performance.now() / 1000;
    const touchData = new Float32Array(MAX_TOUCHES * 4);
    for (let i = 0; i < MAX_TOUCHES; i++) {
      const touch = touches[i];
      touchData.set(touch ? [touch.x, touch.y, now - touch.startedAt, touch.kind] : [0, 0, -1, 0], i * 4);
    }
    gl.uniform2f(uniforms.u_resolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.u_time, animationTime);
    gl.uniform1i(uniforms.u_mode, preset.mode);
    gl.uniform3fv(uniforms.u_color1, hexToRgb(customColors[0]));
    gl.uniform3fv(uniforms.u_color2, hexToRgb(customColors[1]));
    gl.uniform3fv(uniforms.u_color3, hexToRgb(customColors[2]));
    gl.uniform4fv(uniforms.u_touches, touchData);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function needsContinuousDrawing() {
    return !document.hidden && !paused && (!still || touches.length > 0);
  }

  function onAnimationFrame(timestamp) {
    frameRequested = false;
    if (document.hidden) return;
    const elapsed = lastFrameAt ? Math.min(timestamp - lastFrameAt, 100) : 0;
    lastFrameAt = timestamp;
    if (!still) animationTime += (elapsed / 1000) * speed;
    dropExpiredTouches();
    if (timestamp - lastDrawAt >= FRAME_INTERVAL_MS) {
      lastDrawAt = timestamp;
      drawFrame();
    }
    if (needsContinuousDrawing()) requestFrame();
  }

  function requestFrame() {
    if (!gl || frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(onAnimationFrame);
  }

  function redrawOnce() {
    if (!gl) return applyCssFallback();
    lastFrameAt = 0;
    drawFrame();
    requestFrame();
  }

  function applyCssFallback() {
    document.body.style.background = preset.css || `linear-gradient(0deg, ${customColors.join(", ")})`;
  }

  function init(backgroundCanvas) {
    canvas = backgroundCanvas;
    try {
      setUpWebGl();
    } catch (error) {
      console.warn(error.message + " Using a still gradient instead.");
      gl = null;
      canvas.style.display = "none";
      applyCssFallback();
      return;
    }
    window.addEventListener("resize", redrawOnce);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) redrawOnce(); });
    redrawOnce();
  }

  return {
    PRESETS,
    init,
    setPreset(id) {
      preset = PRESETS.find((item) => item.id === id) || PRESETS[0];
      redrawOnce();
    },
    setCustomColors(colors) {
      if (Array.isArray(colors) && colors.length === 3) customColors = colors.slice();
      redrawOnce();
    },
    setSpeed(value) {
      speed = Math.max(0.1, Math.min(3, Number(value) || 1));
    },
    setStill(value) {
      still = Boolean(value);
      redrawOnce();
    },
    // A square image (data URL) of the middle of the current background, for the floating bubble.
    // Drawn and read in one go: the WebGL canvas doesn't keep its picture between frames.
    // While the window is hidden behind the bubble its own animation loop is paused, so each
    // capture moves the animation on by the real time since the last one.
    // `drawAtSnapshotSize` renders just the square needed instead of the whole window and cropping
    // it: for bubble frames this roughly halved the CPU cost. The canvas goes back to the window's
    // size on the next normal frame (when the window is shown again).
    captureSquareSnapshot(sizePx = 256, format = "image/png", drawAtSnapshotSize = false) {
      if (!gl) return null;
      const now = performance.now();
      if (!still && lastCaptureAt) animationTime += (Math.min(now - lastCaptureAt, 500) / 1000) * speed;
      lastCaptureAt = now;
      drawFrame(drawAtSnapshotSize ? { width: sizePx, height: sizePx } : null);
      const side = Math.min(canvas.width, canvas.height);
      const snapshot = document.createElement("canvas");
      snapshot.width = snapshot.height = sizePx;
      snapshot.getContext("2d").drawImage(canvas, (canvas.width - side) / 2, (canvas.height - side) / 2, side, side,
                                          0, 0, sizePx, sizePx);
      return snapshot.toDataURL(format, 0.85);
    },
    isAnimated: () => Boolean(gl) && !still,
    setPaused(value) {
      paused = Boolean(value);
      if (!paused) redrawOnce();
    },
    // x, y are page pixels; kind is "water", "vortex" or "melt".
    addTouch(x, y, kindName) {
      const kind = { water: 1, vortex: 2, melt: 3 }[kindName];
      if (!kind || !gl) return;
      touches.push({ x: x / window.innerWidth, y: 1 - y / window.innerHeight, kind, startedAt: performance.now() / 1000 });
      if (touches.length > MAX_TOUCHES) touches.shift();
      requestFrame();
    },
  };
})();
