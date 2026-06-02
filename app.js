(() => {
  "use strict";

  const canvas = document.getElementById("scene");
  const unsupported = document.getElementById("unsupported");
  const statusEl = document.getElementById("status");
  const movesEl = document.getElementById("moves");
  const timerEl = document.getElementById("timer");
  const scrambleButton = document.getElementById("scramble");
  const undoButton = document.getElementById("undo");
  const resetButton = document.getElementById("reset");
  const glossOnButton = document.getElementById("gloss-on");
  const glossOffButton = document.getElementById("gloss-off");

  const gl = canvas.getContext("webgl", {
    antialias: true,
    alpha: true,
    depth: true,
    stencil: false,
  });

  if (!gl) {
    unsupported.hidden = false;
    return;
  }

  const COLORS = {
    plastic: [0.92, 0.68, 0.32],
    matteFrame: [0.025, 0.026, 0.03],
    red: [0.95, 0.055, 0.045],
    orange: [1.0, 0.42, 0.055],
    yellow: [1.0, 0.84, 0.12],
    green: [0.03, 0.72, 0.34],
    blue: [0.04, 0.28, 0.95],
    white: [0.92, 0.96, 0.98],
  };

  const FACE_STICKERS = [
    { normal: [1, 0, 0], color: COLORS.red, key: "x+" },
    { normal: [-1, 0, 0], color: COLORS.orange, key: "x-" },
    { normal: [0, 1, 0], color: COLORS.white, key: "y+" },
    { normal: [0, -1, 0], color: COLORS.yellow, key: "y-" },
    { normal: [0, 0, 1], color: COLORS.green, key: "z+" },
    { normal: [0, 0, -1], color: COLORS.blue, key: "z-" },
  ];

  const MOVE_DEFS = {
    U: { axis: "y", layer: 1, sign: -1 },
    D: { axis: "y", layer: -1, sign: 1 },
    R: { axis: "x", layer: 1, sign: -1 },
    L: { axis: "x", layer: -1, sign: 1 },
    F: { axis: "z", layer: 1, sign: -1 },
    B: { axis: "z", layer: -1, sign: 1 },
  };

  const AXIS_INDEX = { x: 0, y: 1, z: 2 };
  const SPACING = 1.05;
  const TURN_DURATION = 165;
  const SCRAMBLE_DURATION = 82;
  const GLOSS_STORAGE_KEY = "metalRubik.gloss";
  const WORLD_UP = [0, 1, 0];
  const INITIAL_YAW = -0.72;
  const INITIAL_PITCH = 0.48;
  const CAMERA_DRAG_X = 0.008;
  const CAMERA_DRAG_Y = 0.006;
  const MATERIALS = {
    glossFrame: { shade: 0.12, metallic: 1, roughness: 0.004 },
    glossSticker: { shade: 0.48, metallic: 0.82, roughness: 0.006 },
    matteFrame: { shade: 0.82, metallic: 0.08, roughness: 0.58 },
    matteSticker: { shade: 1, metallic: 0, roughness: 0.64 },
  };

  const vertexShaderSource = `
    attribute vec3 a_position;
    attribute vec3 a_normal;
    uniform mat4 u_model;
    uniform mat4 u_viewProj;
    uniform mat3 u_normalMat;
    uniform vec3 u_color;
    varying vec3 v_normal;
    varying vec3 v_color;
    varying vec3 v_worldPos;

    void main() {
      vec4 world = u_model * vec4(a_position, 1.0);
      v_normal = normalize(u_normalMat * a_normal);
      v_color = u_color;
      v_worldPos = world.xyz;
      gl_Position = u_viewProj * world;
    }
  `;

  const fragmentShaderSource = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    varying vec3 v_normal;
    varying vec3 v_color;
    varying vec3 v_worldPos;
    uniform vec3 u_lightDir;
    uniform vec3 u_fillLightDir;
    uniform vec3 u_cameraPos;
    uniform vec3 u_cameraRight;
    uniform vec3 u_cameraUp;
    uniform vec3 u_cameraForward;
    uniform float u_shade;
    uniform float u_metallic;
    uniform float u_roughness;
    uniform float u_time;

    float softBox(vec2 point, vec2 center, vec2 halfSize, float blur) {
      vec2 delta = abs(point - center) - halfSize;
      float outside = length(max(delta, 0.0));
      float inside = min(max(delta.x, delta.y), 0.0);
      return 1.0 - smoothstep(0.0, blur, outside + inside * 0.18);
    }

    vec2 surfaceUv(vec3 normal, vec3 position) {
      vec3 axis = abs(normal);
      if (axis.x > axis.y && axis.x > axis.z) return position.zy;
      if (axis.y > axis.z) return position.xz;
      return position.xy;
    }

    vec3 environmentColor(vec3 reflected) {
      vec3 lowerRoom = vec3(0.038, 0.042, 0.052);
      vec3 upperRoom = vec3(0.66, 0.72, 0.78);
      vec3 warmFloor = vec3(0.18, 0.135, 0.075);
      vec3 env = mix(lowerRoom, upperRoom, smoothstep(-0.22, 0.78, reflected.y));
      env = mix(env, warmFloor, smoothstep(0.08, 0.86, -reflected.y) * 0.58);

      float horizon = 1.0 - smoothstep(0.0, 0.16, abs(reflected.y + 0.04));
      env = mix(env, vec3(0.012, 0.014, 0.018), horizon * 0.28);

      float ceilingPanel = softBox(reflected.xz, vec2(0.12, 0.26), vec2(0.56, 0.26), 0.18) *
        smoothstep(0.18, 0.78, reflected.y);
      float leftWindow = softBox(reflected.xy, vec2(-0.28, 0.18), vec2(0.18, 0.48), 0.14);
      float rightWindow = softBox(reflected.zy, vec2(0.24, 0.1), vec2(0.2, 0.42), 0.15);
      env += vec3(1.0, 0.97, 0.9) * (ceilingPanel * 1.05 + leftWindow * 0.72 + rightWindow * 0.58);

      vec3 panelA = normalize(vec3(-0.36, 0.78, 0.52));
      vec3 panelB = normalize(vec3(0.68, 0.38, 0.62));
      vec3 panelC = normalize(vec3(-0.82, -0.08, 0.42));
      float lightA = pow(max(dot(reflected, panelA), 0.0), 72.0);
      float lightB = pow(max(dot(reflected, panelB), 0.0), 46.0) * 0.74;
      float lightC = pow(max(dot(reflected, panelC), 0.0), 34.0) * 0.38;
      env += vec3(1.0, 0.96, 0.86) * (lightA * 1.35 + lightB + lightC);

      return env;
    }

    void main() {
      vec3 normal = normalize(v_normal);
      vec3 viewDir = normalize(u_cameraPos - v_worldPos);
      vec3 reflected = normalize(reflect(-viewDir, normal));
      vec3 reflectedView = normalize(vec3(
        dot(reflected, u_cameraRight),
        dot(reflected, u_cameraUp),
        dot(reflected, -u_cameraForward)
      ));
      vec3 keyLight = normalize(u_lightDir);
      vec3 fillLight = normalize(u_fillLightDir);

      float rough = clamp(u_roughness, 0.015, 0.9);
      float shine = mix(220.0, 34.0, rough);
      float key = max(dot(normal, keyLight), 0.0);
      float fill = max(dot(normal, fillLight), 0.0);
      float directional = 0.22 + key * 0.55 + fill * 0.18;
      float facing = max(dot(normal, viewDir), 0.0);
      float fresnel = pow(1.0 - facing, 4.0);

      vec3 env = environmentColor(reflectedView);
      vec2 glossyUv = surfaceUv(normal, v_worldPos);
      float broadWindow = 1.0 - smoothstep(
        0.0,
        0.31,
        abs(glossyUv.x * 0.48 + glossyUv.y * 0.74 + reflectedView.x * 0.38 - 0.34)
      );
      float edgeWindow = 1.0 - smoothstep(
        0.0,
        0.18,
        abs(glossyUv.x * -0.72 + glossyUv.y * 0.34 + reflectedView.z * 0.22 + 0.68)
      );
      float darkMirror = 1.0 - smoothstep(
        0.0,
        0.3,
        abs(glossyUv.x * 0.66 - glossyUv.y * 0.46 + reflectedView.y * 0.36 + 0.58)
      );
      float thinGlint = 1.0 - smoothstep(
        0.0,
        0.075,
        abs(glossyUv.x * 0.62 + glossyUv.y * 0.74 + reflectedView.x * 0.34 - 0.33)
      );
      vec3 halfKey = normalize(keyLight + viewDir);
      vec3 halfFill = normalize(fillLight + viewDir);
      float specKey = pow(max(dot(normal, halfKey), 0.0), shine);
      float specFill = pow(max(dot(normal, halfFill), 0.0), shine * 0.72) * 0.46;
      float panelReflection = pow(max(dot(reflectedView, normalize(vec3(-0.42, 0.7, 0.58))), 0.0), 72.0);

      float envLum = dot(env, vec3(0.299, 0.587, 0.114));
      float chromeLight = envLum * 0.82 + broadWindow * 1.18 + edgeWindow * 0.56 + panelReflection * 0.22;
      chromeLight = clamp(chromeLight, 0.0, 1.95);

      vec3 enamelLit = v_color * directional + env * 0.06;
      vec3 enamel = mix(v_color * 0.76 + env * 0.025, enamelLit, u_shade);
      vec3 saturatedColor = mix(v_color, normalize(v_color + vec3(0.025)) * 0.92, 0.28);
      vec3 coloredReflection = saturatedColor * (0.18 + chromeLight * 1.34);
      coloredReflection = mix(coloredReflection, coloredReflection * 0.22, darkMirror * u_metallic * 0.82);
      coloredReflection += saturatedColor * fresnel * 0.34;

      vec3 mirrorTint = mix(vec3(0.78, 0.76, 0.7), saturatedColor, 0.88);
      vec3 mirrorMetal = coloredReflection + env * mirrorTint * 0.22;
      mirrorMetal += vec3(1.0, 0.96, 0.84) * thinGlint * u_metallic * 0.46;
      float mirrorAmount = clamp(u_metallic * (0.9 + fresnel * 0.18), 0.0, 1.0);
      vec3 base = mix(enamel, mirrorMetal, mirrorAmount);

      vec3 specColor = mix(vec3(0.96), vec3(1.0, 0.96, 0.86), u_metallic);
      vec3 specular = specColor * (specKey * 1.12 + specFill * 0.48 + panelReflection * (0.16 + u_metallic * 0.34));
      vec3 rim = env * fresnel * (0.1 + u_metallic * 0.42);

      vec3 finalColor = base + specular + rim;
      finalColor *= 1.08;
      float peak = max(max(finalColor.r, finalColor.g), finalColor.b);
      finalColor = finalColor / (1.0 + peak * 0.3);
      gl_FragColor = vec4(pow(finalColor, vec3(0.78)), 1.0);
    }
  `;

  const program = createProgram(vertexShaderSource, fragmentShaderSource);
  const locations = {
    position: gl.getAttribLocation(program, "a_position"),
    normal: gl.getAttribLocation(program, "a_normal"),
    model: gl.getUniformLocation(program, "u_model"),
    viewProj: gl.getUniformLocation(program, "u_viewProj"),
    normalMat: gl.getUniformLocation(program, "u_normalMat"),
    color: gl.getUniformLocation(program, "u_color"),
    lightDir: gl.getUniformLocation(program, "u_lightDir"),
    fillLightDir: gl.getUniformLocation(program, "u_fillLightDir"),
    cameraPos: gl.getUniformLocation(program, "u_cameraPos"),
    cameraRight: gl.getUniformLocation(program, "u_cameraRight"),
    cameraUp: gl.getUniformLocation(program, "u_cameraUp"),
    cameraForward: gl.getUniformLocation(program, "u_cameraForward"),
    shade: gl.getUniformLocation(program, "u_shade"),
    metallic: gl.getUniformLocation(program, "u_metallic"),
    roughness: gl.getUniformLocation(program, "u_roughness"),
    time: gl.getUniformLocation(program, "u_time"),
  };

  const cubeGeometry = createGeometry(createBeveledBoxVertices(0.9, 0.045));
  const stickerGeometries = Object.fromEntries(
    FACE_STICKERS.map((face) => [face.key, createGeometry(createStickerVertices(face.normal))]),
  );

  let cubies = createSolvedCubies();
  let queue = [];
  let activeTurn = null;
  let history = [];
  let moveCount = 0;
  let scramblingCount = 0;
  let timerStart = 0;
  let elapsedBeforeStart = 0;
  let timerRunning = false;
  let orbitDir = initialOrbitDirection();
  let cameraUp = initialCameraUp();
  let distance = 7.2;
  let dragMode = null;
  let lastPointer = [0, 0];
  let cubeGesture = null;
  let cameraRollGesture = null;
  let touchPointers = new Map();
  let touchCameraGesture = null;
  let lastFrame = performance.now();
  let lastCamera = null;
  let lastMove = null;
  let glossEnabled = loadGlossPreference();

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.CULL_FACE);
  gl.useProgram(program);

  bindControls();
  updateGlossControls();
  updateHud();
  requestAnimationFrame(frame);

  window.__rubikDebug = {
    getState: () => ({
      cubies: cubies.length,
      moves: moveCount,
      queue: queue.length,
      active: Boolean(activeTurn),
      solved: isSolved(),
      webgl: Boolean(gl),
      camera: {
        yaw: Math.atan2(orbitDir[0], orbitDir[2]),
        pitch: Math.asin(clamp(orbitDir[1], -1, 1)),
        distance,
        orbitDir: [...orbitDir],
        up: [...cameraUp],
      },
      lastMove,
      gloss: glossEnabled,
      touches: touchPointers.size,
    }),
    move: (notation) => playMove(notation),
    reset,
    setGloss: setGlossEnabled,
  };

  function bindControls() {
    scrambleButton.addEventListener("click", scramble);
    undoButton.addEventListener("click", undo);
    resetButton.addEventListener("click", reset);
    glossOnButton.addEventListener("click", () => setGlossEnabled(true));
    glossOffButton.addEventListener("click", () => setGlossEnabled(false));

    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("auxclick", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", endPointerDrag);
    canvas.addEventListener("pointercancel", endPointerDrag);

    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        distance = clamp(distance + event.deltaY * 0.006, 4.8, 12.8);
      },
      { passive: false },
    );
  }

  function loadGlossPreference() {
    try {
      return localStorage.getItem(GLOSS_STORAGE_KEY) === "on";
    } catch {
      return false;
    }
  }

  function setGlossEnabled(nextValue) {
    glossEnabled = Boolean(nextValue);

    try {
      localStorage.setItem(GLOSS_STORAGE_KEY, glossEnabled ? "on" : "off");
    } catch {
      // Ignore storage failures; the visual toggle still works for the current session.
    }

    updateGlossControls();
  }

  function updateGlossControls() {
    glossOnButton.setAttribute("aria-pressed", String(glossEnabled));
    glossOffButton.setAttribute("aria-pressed", String(!glossEnabled));
  }

  function handlePointerDown(event) {
    if (event.pointerType === "touch") {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      touchPointers.set(event.pointerId, [event.clientX, event.clientY]);

      if (touchPointers.size === 1) {
        dragMode = "touch-cube";
        touchCameraGesture = null;
        cubeGesture =
          activeTurn || queue.length || scramblingCount > 0
            ? null
            : {
                start: [event.clientX, event.clientY],
                pick: pickCubeFace(event.clientX, event.clientY),
                turned: false,
              };
        return;
      }

      dragMode = "touch-camera";
      cubeGesture = null;
      touchCameraGesture = createTouchCameraGesture();
      return;
    }

    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    lastPointer = [event.clientX, event.clientY];

    if (event.button === 1) {
      dragMode = "camera-roll";
      cubeGesture = null;
      cameraRollGesture = createCameraRollGesture(event.clientX, event.clientY);
      return;
    }

    if (event.button === 2) {
      dragMode = "camera";
      cubeGesture = null;
      cameraRollGesture = null;
      return;
    }

    dragMode = "cube";
    cameraRollGesture = null;
    cubeGesture =
      activeTurn || queue.length || scramblingCount > 0
        ? null
        : {
            start: [event.clientX, event.clientY],
            pick: pickCubeFace(event.clientX, event.clientY),
            turned: false,
          };
  }

  function handlePointerMove(event) {
    if (event.pointerType === "touch") {
      if (!touchPointers.has(event.pointerId)) return;
      event.preventDefault();
      touchPointers.set(event.pointerId, [event.clientX, event.clientY]);

      if (touchPointers.size >= 2) {
        if (dragMode !== "touch-camera" || !touchCameraGesture) {
          dragMode = "touch-camera";
          cubeGesture = null;
          touchCameraGesture = createTouchCameraGesture();
          return;
        }

        updateTouchCameraGesture();
        return;
      }

      if (dragMode === "touch-cube") updateCubeGesture(event);
      return;
    }

    if (!dragMode) return;
    event.preventDefault();

    if (dragMode === "camera") {
      const dx = event.clientX - lastPointer[0];
      const dy = event.clientY - lastPointer[1];
      lastPointer = [event.clientX, event.clientY];
      orbitCamera(dx, dy);
      return;
    }

    if (dragMode === "camera-roll") {
      updateCameraRollGesture(event.clientX, event.clientY);
      return;
    }

    updateCubeGesture(event);
  }

  function endPointerDrag(event) {
    if (event.pointerType === "touch") {
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }

      touchPointers.delete(event.pointerId);

      if (touchPointers.size >= 2) {
        dragMode = "touch-camera";
        cubeGesture = null;
        touchCameraGesture = createTouchCameraGesture();
        return;
      }

      if (touchPointers.size === 1) {
        dragMode = "touch-idle";
        cubeGesture = null;
        touchCameraGesture = null;
        return;
      }

      dragMode = null;
      cubeGesture = null;
      touchCameraGesture = null;
      return;
    }

    if (!dragMode) return;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    dragMode = null;
    cubeGesture = null;
    cameraRollGesture = null;
  }

  function createCameraRollGesture(clientX, clientY) {
    return {
      angle: pointerAngleFromCanvasCenter(clientX, clientY),
    };
  }

  function updateCameraRollGesture(clientX, clientY) {
    const current = createCameraRollGesture(clientX, clientY);
    if (!current || !cameraRollGesture) {
      cameraRollGesture = current;
      return;
    }

    if (current.angle === null || cameraRollGesture.angle === null) {
      cameraRollGesture = current;
      return;
    }

    rollCamera(wrapDeltaAngle(cameraRollGesture.angle - current.angle));
    cameraRollGesture = current;
  }

  function pointerAngleFromCanvasCenter(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - (rect.left + rect.width * 0.5);
    const y = clientY - (rect.top + rect.height * 0.5);
    if (Math.hypot(x, y) < 18) return null;
    return Math.atan2(y, x);
  }

  function createTouchCameraGesture() {
    const points = [...touchPointers.values()].slice(0, 2);
    if (points.length < 2) return null;
    const center = [
      (points[0][0] + points[1][0]) * 0.5,
      (points[0][1] + points[1][1]) * 0.5,
    ];
    return {
      center,
      angle: Math.atan2(points[1][1] - points[0][1], points[1][0] - points[0][0]),
      span: Math.max(1, Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1])),
    };
  }

  function updateTouchCameraGesture() {
    const current = createTouchCameraGesture();
    if (!current || !touchCameraGesture) {
      touchCameraGesture = current;
      return;
    }

    const dx = current.center[0] - touchCameraGesture.center[0];
    const dy = current.center[1] - touchCameraGesture.center[1];
    const dSpan = current.span - touchCameraGesture.span;
    const dAngle = wrapDeltaAngle(current.angle - touchCameraGesture.angle);
    orbitCamera(dx, dy);
    rollCamera(dAngle);
    distance = clamp(distance - dSpan * 0.012, 4.8, 12.8);
    touchCameraGesture = current;
  }

  function initialOrbitDirection() {
    return normalize([
      Math.cos(INITIAL_PITCH) * Math.sin(INITIAL_YAW),
      Math.sin(INITIAL_PITCH),
      Math.cos(INITIAL_PITCH) * Math.cos(INITIAL_YAW),
    ]);
  }

  function initialCameraUp() {
    return normalize([
      -Math.sin(INITIAL_PITCH) * Math.sin(INITIAL_YAW),
      Math.cos(INITIAL_PITCH),
      -Math.sin(INITIAL_PITCH) * Math.cos(INITIAL_YAW),
    ]);
  }

  function orbitCamera(dx, dy) {
    const frame = cameraFrame(orbitDir, cameraUp);

    if (dx) rotateCameraAroundAxis(frame.up, -dx * CAMERA_DRAG_X);

    if (dy) {
      rotateCameraAroundAxis(frame.right, -dy * CAMERA_DRAG_Y);
    }
  }

  function rotateCameraAroundAxis(axis, angle) {
    if (!Number.isFinite(angle) || Math.abs(angle) < 0.000001) return;
    orbitDir = normalize(rotateVectorAroundAxis(orbitDir, axis, angle));
    cameraUp = normalize(rotateVectorAroundAxis(cameraUp, axis, angle));
    const frame = cameraFrame(orbitDir, cameraUp);
    cameraUp = frame.up;
  }

  function rollCamera(angle) {
    if (!Number.isFinite(angle) || Math.abs(angle) < 0.000001) return;
    const frame = cameraFrame(orbitDir, cameraUp);
    cameraUp = rotateVectorAroundAxis(frame.up, frame.forward, angle);
    cameraUp = cameraFrame(orbitDir, cameraUp).up;
  }

  function playMove(notation) {
    const move = parseMove(notation);
    if (!move) return;
    playParsedMove(move);
  }

  function playParsedMove(move) {
    if (scramblingCount > 0) return;
    if (!timerRunning && !isSolved()) startTimer();
    lastMove = pickMoveFields(move);
    enqueueMove({ ...move, record: true, duration: TURN_DURATION });
  }

  function updateCubeGesture(event) {
    if (!cubeGesture?.pick || cubeGesture.turned || activeTurn || queue.length) return;
    const dx = event.clientX - cubeGesture.start[0];
    const dy = event.clientY - cubeGesture.start[1];
    if (Math.hypot(dx, dy) < 24) return;

    const move = moveFromDrag(cubeGesture.pick, [dx, dy]);
    if (!move) return;
    cubeGesture.turned = true;
    playParsedMove(move);
  }

  function pickCubeFace(clientX, clientY) {
    if (!lastCamera) return null;
    const ray = createPointerRay(clientX, clientY);
    let best = null;

    cubies.forEach((cubie) => {
      const hit = intersectRayBox(ray.origin, ray.dir, scaleVec(cubie.pos, SPACING), 0.47);
      if (!hit) return;

      const axisIndex = hit.normal.findIndex((value) => Math.abs(value) > 0.5);
      const normalSign = hit.normal[axisIndex];
      if (cubie.pos[axisIndex] !== normalSign) return;

      if (!best || hit.t < best.t) {
        best = {
          t: hit.t,
          point: hit.point,
          normal: hit.normal,
          cubiePos: [...cubie.pos],
        };
      }
    });

    return best;
  }

  function createPointerRay(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / Math.max(rect.height, 1)) * 2;
    const tanFov = Math.tan(lastCamera.fov * 0.5);
    const dir = normalize(
      addVec(
        addVec(
          lastCamera.forward,
          scaleVec(lastCamera.right, ndcX * tanFov * lastCamera.aspect),
        ),
        scaleVec(lastCamera.up, ndcY * tanFov),
      ),
    );
    return {
      origin: lastCamera.eye,
      dir,
    };
  }

  function intersectRayBox(origin, dir, center, half) {
    let tMin = -Infinity;
    let tMax = Infinity;
    let hitNormal = [0, 0, 0];

    for (let axis = 0; axis < 3; axis += 1) {
      const min = center[axis] - half;
      const max = center[axis] + half;

      if (Math.abs(dir[axis]) < 0.000001) {
        if (origin[axis] < min || origin[axis] > max) return null;
        continue;
      }

      let near = (min - origin[axis]) / dir[axis];
      let far = (max - origin[axis]) / dir[axis];
      let nearNormal = [0, 0, 0];
      let farNormal = [0, 0, 0];
      nearNormal[axis] = -1;
      farNormal[axis] = 1;

      if (near > far) {
        [near, far] = [far, near];
        [nearNormal, farNormal] = [farNormal, nearNormal];
      }

      if (near > tMin) {
        tMin = near;
        hitNormal = nearNormal;
      }

      tMax = Math.min(tMax, far);
      if (tMin > tMax) return null;
    }

    if (tMax < 0) return null;
    const t = tMin >= 0 ? tMin : tMax;
    return {
      t,
      point: addVec(origin, scaleVec(dir, t)),
      normal: hitNormal,
    };
  }

  function moveFromDrag(pick, drag) {
    const dragUnit = normalize2(drag);
    let best = null;

    for (const tangent of faceTangents(pick.normal)) {
      for (const signedTangent of [tangent, scaleVec(tangent, -1)]) {
        const screenVector = projectVectorToScreen(signedTangent);
        const magnitude = Math.hypot(screenVector[0], screenVector[1]);
        if (magnitude < 0.0001) continue;
        const score = dot2(scaleVec2(screenVector, 1 / magnitude), dragUnit);
        if (!best || score > best.score) best = { tangent: signedTangent, score };
      }
    }

    if (!best || best.score < 0.18) return null;
    const rotationVector = cross(pick.normal, best.tangent);
    const axisInfo = vectorToAxis(rotationVector);
    if (!axisInfo) return null;

    return {
      axis: axisInfo.axis,
      layer: pick.cubiePos[axisInfo.index],
      sign: axisInfo.sign,
    };
  }

  function faceTangents(normal) {
    const axis = normal.findIndex((value) => Math.abs(value) > 0.5);
    return [
      axis === 0 ? [0, 1, 0] : [1, 0, 0],
      axis === 2 ? [0, 1, 0] : [0, 0, 1],
    ];
  }

  function projectVectorToScreen(vector) {
    return [dot(vector, lastCamera.right), -dot(vector, lastCamera.up)];
  }

  function vectorToAxis(vector) {
    const abs = vector.map((value) => Math.abs(value));
    const index = abs.indexOf(Math.max(...abs));
    if (abs[index] < 0.5) return null;
    return {
      axis: ["x", "y", "z"][index],
      index,
      sign: vector[index] > 0 ? 1 : -1,
    };
  }

  function scramble() {
    if (activeTurn || queue.length) return;
    resetTimer();
    lastMove = null;
    setStatus("シャッフル中");
    const faces = Object.keys(MOVE_DEFS);
    let previous = "";
    const scrambleMoves = [];

    for (let i = 0; i < 24; i += 1) {
      let face = faces[Math.floor(Math.random() * faces.length)];
      while (face === previous) face = faces[Math.floor(Math.random() * faces.length)];
      previous = face;
      scrambleMoves.push({
        ...faceMove(face, Math.random() > 0.5 ? 1 : -1),
        record: false,
        duration: SCRAMBLE_DURATION,
        scramble: true,
      });
    }

    scramblingCount = scrambleMoves.length;
    scrambleMoves.forEach(enqueueMove);
  }

  function undo() {
    if (scramblingCount > 0 || activeTurn || queue.length || history.length === 0) return;
    const move = history.pop();
    moveCount = Math.max(0, moveCount - 1);
    enqueueMove({ ...move, record: false, duration: TURN_DURATION });
    updateHud();
  }

  function reset() {
    cubies = createSolvedCubies();
    queue = [];
    activeTurn = null;
    history = [];
    moveCount = 0;
    scramblingCount = 0;
    resetTimer();
    lastMove = null;
    setStatus("完成");
    updateHud();
  }

  function enqueueMove(move) {
    queue.push(move);
  }

  function faceMove(face, dir) {
    const def = MOVE_DEFS[face];
    return {
      axis: def.axis,
      layer: def.layer,
      sign: def.sign * dir,
    };
  }

  function pickMoveFields(move) {
    return {
      axis: move.axis,
      layer: move.layer,
      sign: move.sign,
    };
  }

  function parseMove(notation) {
    const face = notation.charAt(0).toUpperCase();
    if (!MOVE_DEFS[face]) return null;
    return faceMove(face, notation.includes("'") ? -1 : 1);
  }

  function frame(now) {
    const dt = Math.min(now - lastFrame, 48);
    lastFrame = now;
    updateTurn(dt);
    draw(now);
    updateHud();
    requestAnimationFrame(frame);
  }

  function updateTurn(dt) {
    if (!activeTurn && queue.length) {
      activeTurn = {
        ...queue.shift(),
        elapsed: 0,
      };
      if (activeTurn.record) startTimer();
    }

    if (!activeTurn) return;
    activeTurn.elapsed += dt;

    if (activeTurn.elapsed >= activeTurn.duration) {
      commitTurn(activeTurn);

      if (activeTurn.record) {
        moveCount += 1;
        history.push(invertMove(activeTurn));
      }

      if (activeTurn.scramble) {
        scramblingCount = Math.max(0, scramblingCount - 1);
        if (scramblingCount === 0) {
          history = [];
          moveCount = 0;
          setStatus("準備完了");
        }
      } else {
        setStatus(isSolved() ? "完成" : "プレイ中");
        if (isSolved()) stopTimer();
      }

      activeTurn = null;
    }
  }

  function commitTurn(turn) {
    const axisIndex = AXIS_INDEX[turn.axis];

    cubies.forEach((cubie) => {
      if (cubie.pos[axisIndex] !== turn.layer) return;
      cubie.pos = rotateVector90(cubie.pos, turn.axis, turn.sign);
      cubie.basis = rotateBasis90(cubie.basis, turn.axis, turn.sign);
    });
  }

  function invertMove(move) {
    return {
      axis: move.axis,
      layer: move.layer,
      sign: -move.sign,
      record: false,
      duration: TURN_DURATION,
    };
  }

  function draw(now) {
    resizeCanvasToDisplaySize();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const aspect = width / Math.max(1, height);
    const t = now * 0.001;

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const viewProj = createViewProjection(aspect, t);
    gl.uniformMatrix4fv(locations.viewProj, false, viewProj);
    gl.uniform3fv(locations.cameraPos, new Float32Array(lastCamera.eye));
    gl.uniform3fv(locations.cameraRight, new Float32Array(lastCamera.right));
    gl.uniform3fv(locations.cameraUp, new Float32Array(lastCamera.up));
    gl.uniform3fv(locations.cameraForward, new Float32Array(lastCamera.forward));
    gl.uniform3fv(locations.lightDir, new Float32Array(cameraRelativeLight(-0.34, 0.78, 0.52)));
    gl.uniform3fv(locations.fillLightDir, new Float32Array(cameraRelativeLight(0.7, 0.28, 0.36)));
    gl.uniform1f(locations.time, t);

    cubies.forEach((cubie) => {
      const modelParts = modelForCubie(cubie);
      const frameMaterial = glossEnabled ? MATERIALS.glossFrame : MATERIALS.matteFrame;
      const stickerMaterial = glossEnabled ? MATERIALS.glossSticker : MATERIALS.matteSticker;
      const frameColor = glossEnabled ? COLORS.plastic : COLORS.matteFrame;
      drawGeometry(
        cubeGeometry,
        modelParts.model,
        frameColor,
        frameMaterial.shade,
        frameMaterial.metallic,
        frameMaterial.roughness,
      );
      cubie.stickers.forEach((sticker) => {
        drawGeometry(
          stickerGeometries[sticker.key],
          modelParts.model,
          sticker.color,
          stickerMaterial.shade,
          stickerMaterial.metallic,
          stickerMaterial.roughness,
        );
      });
    });
  }

  function cameraRelativeLight(rightAmount, upAmount, cameraAmount) {
    return normalize(
      addVec(
        addVec(scaleVec(lastCamera.right, rightAmount), scaleVec(lastCamera.up, upAmount)),
        scaleVec(lastCamera.forward, -cameraAmount),
      ),
    );
  }

  function modelForCubie(cubie) {
    let pos = scaleVec(cubie.pos, SPACING);
    let basis = cubie.basis;

    if (activeTurn) {
      const axisIndex = AXIS_INDEX[activeTurn.axis];

      if (cubie.pos[axisIndex] === activeTurn.layer) {
        const turnAmount = easeInOutCubic(
          clamp(activeTurn.elapsed / activeTurn.duration, 0, 1),
        );
        const angle = activeTurn.sign * turnAmount * Math.PI * 0.5;
        pos = rotateVector(pos, activeTurn.axis, angle);
        basis = rotateBasis(basis, activeTurn.axis, angle);
      }
    }

    return {
      model: mat4FromBasisAndPosition(basis, pos),
    };
  }

  function drawGeometry(
    geometry,
    model,
    color,
    shade = 1,
    metallic = 0,
    roughness = 0.38,
  ) {
    gl.bindBuffer(gl.ARRAY_BUFFER, geometry.buffer);
    gl.enableVertexAttribArray(locations.position);
    gl.enableVertexAttribArray(locations.normal);
    gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(locations.normal, 3, gl.FLOAT, false, 24, 12);
    gl.uniformMatrix4fv(locations.model, false, model);
    gl.uniformMatrix3fv(locations.normalMat, false, mat3FromMat4(model));
    gl.uniform3fv(locations.color, new Float32Array(color));
    gl.uniform1f(locations.shade, shade);
    gl.uniform1f(locations.metallic, metallic);
    gl.uniform1f(locations.roughness, roughness);
    gl.drawArrays(gl.TRIANGLES, 0, geometry.count);
  }

  function createSolvedCubies() {
    const next = [];
    let id = 0;

    for (let x = -1; x <= 1; x += 1) {
      for (let y = -1; y <= 1; y += 1) {
        for (let z = -1; z <= 1; z += 1) {
          const home = [x, y, z];
          next.push({
            id: id += 1,
            home: [...home],
            pos: [...home],
            basis: identityBasis(),
            stickers: FACE_STICKERS.filter((face) => dot(face.normal, home) > 0.5).map(
              (face) => ({
                key: face.key,
                color: face.color,
              }),
            ),
          });
        }
      }
    }

    return next;
  }

  function isSolved() {
    return cubies.every((cubie) => {
      return (
        cubie.home.every((value, index) => value === cubie.pos[index]) &&
        basisEquals(cubie.basis, identityBasis())
      );
    });
  }

  function createProgram(vsSource, fsSource) {
    const vs = createShader(gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl.FRAGMENT_SHADER, fsSource);
    const nextProgram = gl.createProgram();
    gl.attachShader(nextProgram, vs);
    gl.attachShader(nextProgram, fs);
    gl.linkProgram(nextProgram);

    if (!gl.getProgramParameter(nextProgram, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(nextProgram) || "Unable to link WebGL program.");
    }

    return nextProgram;
  }

  function createShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "Unable to compile WebGL shader.");
    }

    return shader;
  }

  function createGeometry(vertices) {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    return {
      buffer,
      count: vertices.length / 6,
    };
  }

  function createBeveledBoxVertices(size, bevel) {
    const h = size * 0.5;
    const r = h - bevel;
    const vertices = [];
    const axes = [0, 1, 2];
    const mainFaces = [
      { n: [1, 0, 0], a: [0, 1, 0], b: [0, 0, 1] },
      { n: [-1, 0, 0], a: [0, 1, 0], b: [0, 0, -1] },
      { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, -1] },
      { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1] },
      { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] },
      { n: [0, 0, -1], a: [-1, 0, 0], b: [0, 1, 0] },
    ];

    mainFaces.forEach((face) => {
      vertices.push(...createQuad(face.n, face.a, face.b, r, r, h));
    });

    const point = (axisA, valueA, axisB, valueB, axisC, valueC) => {
      const next = [0, 0, 0];
      next[axisA] = valueA;
      next[axisB] = valueB;
      next[axisC] = valueC;
      return next;
    };

    const pushFacet = (corners, normal) => {
      const order = corners.length === 3 ? [0, 1, 2] : [0, 1, 2, 0, 2, 3];
      order.forEach((index) => {
        vertices.push(...corners[index], ...normal);
      });
    };

    for (let axisA = 0; axisA < 3; axisA += 1) {
      for (let axisB = axisA + 1; axisB < 3; axisB += 1) {
        const axisC = axes.find((axis) => axis !== axisA && axis !== axisB);

        for (const signA of [-1, 1]) {
          for (const signB of [-1, 1]) {
            const normal = normalize(
              axes.map((axis) =>
                axis === axisA ? signA : axis === axisB ? signB : 0,
              ),
            );
            pushFacet(
              [
                point(axisA, signA * h, axisB, signB * r, axisC, -r),
                point(axisA, signA * h, axisB, signB * r, axisC, r),
                point(axisA, signA * r, axisB, signB * h, axisC, r),
                point(axisA, signA * r, axisB, signB * h, axisC, -r),
              ],
              normal,
            );
          }
        }
      }
    }

    for (const signX of [-1, 1]) {
      for (const signY of [-1, 1]) {
        for (const signZ of [-1, 1]) {
          pushFacet(
            [
              [signX * h, signY * r, signZ * r],
              [signX * r, signY * h, signZ * r],
              [signX * r, signY * r, signZ * h],
            ],
            normalize([signX, signY, signZ]),
          );
        }
      }
    }

    return vertices;
  }

  function createBoxVertices(size) {
    const h = size * 0.5;
    const faces = [
      { n: [1, 0, 0], a: [0, 1, 0], b: [0, 0, 1] },
      { n: [-1, 0, 0], a: [0, 1, 0], b: [0, 0, -1] },
      { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, -1] },
      { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1] },
      { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] },
      { n: [0, 0, -1], a: [-1, 0, 0], b: [0, 1, 0] },
    ];
    return faces.flatMap((face) => createQuad(face.n, face.a, face.b, h, h, h));
  }

  function createStickerVertices(normal) {
    const axis = normal.findIndex((value) => value !== 0);
    const tangents = [
      axis === 0 ? [0, 1, 0] : [1, 0, 0],
      axis === 2 ? [0, 1, 0] : [0, 0, 1],
    ];

    if (axis === 1) {
      tangents[0] = [1, 0, 0];
      tangents[1] = [0, 0, -normal[1]];
    }

    if (axis === 0 && normal[0] < 0) tangents[1] = [0, 0, -1];
    if (axis === 2 && normal[2] < 0) tangents[0] = [-1, 0, 0];

    return createQuad(normal, tangents[0], tangents[1], 0.386, 0.386, 0.461);
  }

  function createQuad(normal, tangentA, tangentB, halfA, halfB, offset) {
    const center = scaleVec(normal, offset);
    const corners = [
      addVec(addVec(center, scaleVec(tangentA, -halfA)), scaleVec(tangentB, -halfB)),
      addVec(addVec(center, scaleVec(tangentA, halfA)), scaleVec(tangentB, -halfB)),
      addVec(addVec(center, scaleVec(tangentA, halfA)), scaleVec(tangentB, halfB)),
      addVec(addVec(center, scaleVec(tangentA, -halfA)), scaleVec(tangentB, halfB)),
    ];
    const order = [0, 1, 2, 0, 2, 3];
    return order.flatMap((index) => [...corners[index], ...normal]);
  }

  function resizeCanvasToDisplaySize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function createViewProjection(aspect, time) {
    const idleAngle = dragMode ? 0 : Math.sin(time * 0.22) * 0.035;
    const responsivePullback = aspect < 0.72 ? (0.72 - aspect) * 22 : 0;
    const cameraDistance = distance + responsivePullback;
    const baseFrame = cameraFrame(orbitDir, cameraUp);
    const renderOrbitDir = idleAngle
      ? rotateVectorAroundAxis(orbitDir, baseFrame.up, idleAngle)
      : orbitDir;
    const renderCameraUp = idleAngle
      ? rotateVectorAroundAxis(cameraUp, baseFrame.up, idleAngle)
      : cameraUp;
    const frame = cameraFrame(renderOrbitDir, renderCameraUp);
    const eye = scaleVec(renderOrbitDir, cameraDistance);
    const target = [0, 0, 0];
    const fov = (42 * Math.PI) / 180;
    const view = mat4LookAt(eye, target, frame.up);
    const projection = mat4Perspective(fov, aspect, 0.1, 100);
    lastCamera = {
      eye,
      forward: frame.forward,
      right: frame.right,
      up: frame.up,
      aspect,
      fov,
    };
    return mat4Multiply(projection, view);
  }

  function cameraFrame(nextOrbitDir, nextCameraUp) {
    const forward = normalize(scaleVec(nextOrbitDir, -1));
    let right = cross(forward, nextCameraUp);

    if (Math.hypot(right[0], right[1], right[2]) < 0.000001) {
      right = cross(forward, WORLD_UP);
    }

    if (Math.hypot(right[0], right[1], right[2]) < 0.000001) {
      right = [1, 0, 0];
    }

    right = normalize(right);
    const up = normalize(cross(right, forward));
    return { forward, right, up };
  }

  function startTimer() {
    if (timerRunning) return;
    timerRunning = true;
    timerStart = performance.now();
  }

  function stopTimer() {
    if (!timerRunning) return;
    elapsedBeforeStart += performance.now() - timerStart;
    timerRunning = false;
  }

  function resetTimer() {
    timerRunning = false;
    timerStart = 0;
    elapsedBeforeStart = 0;
  }

  function getElapsedMs() {
    return elapsedBeforeStart + (timerRunning ? performance.now() - timerStart : 0);
  }

  function setStatus(value) {
    statusEl.textContent = value;
  }

  function updateHud() {
    movesEl.textContent = String(moveCount);
    timerEl.textContent = formatTime(getElapsedMs());
    undoButton.disabled = history.length === 0 || activeTurn || queue.length || scramblingCount > 0;
    scrambleButton.disabled = Boolean(activeTurn || queue.length);
  }

  function formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function identityBasis() {
    return {
      x: [1, 0, 0],
      y: [0, 1, 0],
      z: [0, 0, 1],
    };
  }

  function basisEquals(a, b) {
    return (
      a.x.every((value, index) => value === b.x[index]) &&
      a.y.every((value, index) => value === b.y[index]) &&
      a.z.every((value, index) => value === b.z[index])
    );
  }

  function rotateBasis90(basis, axis, sign) {
    return {
      x: rotateVector90(basis.x, axis, sign),
      y: rotateVector90(basis.y, axis, sign),
      z: rotateVector90(basis.z, axis, sign),
    };
  }

  function rotateBasis(basis, axis, angle) {
    return {
      x: rotateVector(basis.x, axis, angle),
      y: rotateVector(basis.y, axis, angle),
      z: rotateVector(basis.z, axis, angle),
    };
  }

  function rotateVector90(v, axis, sign) {
    const [x, y, z] = v;

    if (axis === "x") {
      return sign > 0 ? [x, -z, y] : [x, z, -y];
    }

    if (axis === "y") {
      return sign > 0 ? [z, y, -x] : [-z, y, x];
    }

    return sign > 0 ? [-y, x, z] : [y, -x, z];
  }

  function rotateVector(v, axis, angle) {
    const [x, y, z] = v;
    const c = Math.cos(angle);
    const s = Math.sin(angle);

    if (axis === "x") return [x, y * c - z * s, y * s + z * c];
    if (axis === "y") return [x * c + z * s, y, -x * s + z * c];
    return [x * c - y * s, x * s + y * c, z];
  }

  function rotateVectorAroundAxis(v, axis, angle) {
    const unit = normalize(axis);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const projection = dot(unit, v);
    const perpendicular = cross(unit, v);

    return addVec(
      addVec(scaleVec(v, c), scaleVec(perpendicular, s)),
      scaleVec(unit, projection * (1 - c)),
    );
  }

  function mat4FromBasisAndPosition(basis, pos) {
    return new Float32Array([
      basis.x[0],
      basis.x[1],
      basis.x[2],
      0,
      basis.y[0],
      basis.y[1],
      basis.y[2],
      0,
      basis.z[0],
      basis.z[1],
      basis.z[2],
      0,
      pos[0],
      pos[1],
      pos[2],
      1,
    ]);
  }

  function mat3FromMat4(m) {
    return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
  }

  function mat4Perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const rangeInv = 1 / (near - far);
    return new Float32Array([
      f / aspect,
      0,
      0,
      0,
      0,
      f,
      0,
      0,
      0,
      0,
      (near + far) * rangeInv,
      -1,
      0,
      0,
      near * far * rangeInv * 2,
      0,
    ]);
  }

  function mat4LookAt(eye, target, up) {
    const zAxis = normalize(subVec(eye, target));
    const xAxis = normalize(cross(up, zAxis));
    const yAxis = cross(zAxis, xAxis);

    return new Float32Array([
      xAxis[0],
      yAxis[0],
      zAxis[0],
      0,
      xAxis[1],
      yAxis[1],
      zAxis[1],
      0,
      xAxis[2],
      yAxis[2],
      zAxis[2],
      0,
      -dot(xAxis, eye),
      -dot(yAxis, eye),
      -dot(zAxis, eye),
      1,
    ]);
  }

  function mat4Multiply(a, b) {
    const out = new Float32Array(16);

    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        out[column * 4 + row] =
          a[0 * 4 + row] * b[column * 4 + 0] +
          a[1 * 4 + row] * b[column * 4 + 1] +
          a[2 * 4 + row] * b[column * 4 + 2] +
          a[3 * 4 + row] * b[column * 4 + 3];
      }
    }

    return out;
  }

  function addVec(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  }

  function subVec(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  }

  function scaleVec(v, scale) {
    return [v[0] * scale, v[1] * scale, v[2] * scale];
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  function normalize(v) {
    const length = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / length, v[1] / length, v[2] / length];
  }

  function normalize2(v) {
    const length = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / length, v[1] / length];
  }

  function scaleVec2(v, scale) {
    return [v[0] * scale, v[1] * scale];
  }

  function dot2(a, b) {
    return a[0] * b[0] + a[1] * b[1];
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function wrapDeltaAngle(value) {
    return Math.atan2(Math.sin(value), Math.cos(value));
  }

  function easeInOutCubic(value) {
    return value < 0.5
      ? 4 * value * value * value
      : 1 - Math.pow(-2 * value + 2, 3) / 2;
  }
})();
