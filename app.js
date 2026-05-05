const inputSourceEl = document.getElementById("inputSource");
const videoFileRowEl = document.getElementById("videoFileRow");
const videoScenarioRowEl = document.getElementById("videoScenarioRow");
const cameraControlsRowEl = document.getElementById("cameraControlsRow");
const startCameraBtnEl = document.getElementById("startCameraBtn");
const stopCameraBtnEl = document.getElementById("stopCameraBtn");
const videoFileEl = document.getElementById("videoFile");
const videoScenarioEl = document.getElementById("videoScenario");
const sourceNoticeEl = document.getElementById("sourceNotice");
const videoPreviewCardEl = document.getElementById("videoPreviewCard");
const calibrationSurfaceEl = document.getElementById("calibrationSurface");
const videoPreviewEl = document.getElementById("videoPreview");
const surfaceTapLayerEl = document.getElementById("surfaceTapLayer");
const autoReferenceLineEl = document.getElementById("autoReferenceLine");
const centerLineEl = document.getElementById("centerLine");
const toleranceBandEl = document.getElementById("toleranceBand");
const guideLineEl = document.getElementById("guideLine");
const guideStemEl = document.getElementById("guideStem");
const videoStatusEl = document.getElementById("videoStatus");
const groundDebugEl = document.getElementById("groundDebug");
const toleranceModeEl = document.getElementById("toleranceMode");
const environmentProfileEl = document.getElementById("environmentProfile");
const courtTypeEl = document.getElementById("courtType");
const deltaCmEl = document.getElementById("deltaCm");
const judgeBtnEl = document.getElementById("judgeBtn");
const resultTextEl = document.getElementById("resultText");
const guidanceTextEl = document.getElementById("guidanceText");
const referenceModeEl = document.getElementById("referenceMode");
const calibrationStatusEl = document.getElementById("calibrationStatus");
const startCalibrationBtnEl = document.getElementById("startCalibrationBtn");
const capturePointBtnEl = document.getElementById("capturePointBtn");
const resetCalibrationBtnEl = document.getElementById("resetCalibrationBtn");
const feedbackCategoryEl = document.getElementById("feedbackCategory");
const feedbackExpectedEl = document.getElementById("feedbackExpected");
const feedbackActualEl = document.getElementById("feedbackActual");
const feedbackStepsEl = document.getElementById("feedbackSteps");
const addFeedbackBtnEl = document.getElementById("addFeedbackBtn");
const exportFeedbackBtnEl = document.getElementById("exportFeedbackBtn");
const feedbackStatusEl = document.getElementById("feedbackStatus");
const versionEl = document.getElementById("version");

const VERSION = "v0.2.6";
if (versionEl) {
  versionEl.textContent = `Version: ${VERSION} / loaded: ${new Date().toLocaleString()}`;
}

let currentVideoUrl = null;
let cameraStream = null;
const feedbackEntries = [];
let calibrationState = "idle";
let calibrationPoints = 0;
let calibrationPointPositions = [];
let autoReference = { ready: false, confidence: 0, yPercent: 0, xStartPercent: 0, xEndPercent: 0 };
let groundDebug = { ready: false, detected: false, coverage: 0, edgeStrength: 0 };
let groundRoiStartRatio = 0.68;
let groundRoiEndRatio = 0.96;
let groundMissStreak = 0;
let groundEffectiveCoverageThreshold = 0.14;
let groundEffectiveEdgeThreshold = 5.5;
let groundStableDetected = false;
let groundConsecutiveOk = 0;
let groundConsecutiveMiss = 0;
const GROUND_OK_FRAMES_TO_LOCK = 3;
const GROUND_MISS_FRAMES_TO_DROP = 5;
const autoReferenceHistory = [];
const AUTO_REFERENCE_HISTORY_SIZE = 6;
let detectionDebug = {
  rowStrength: 0,
  colStrength: 0,
  tHorizontalScore: 0,
  tVerticalScoreSym: 0,
  tVerticalScoreDown: 0,
  tVerticalScoreUp: 0,
  tVerticalScoreFinal: 0,
  tScore: 0
};

const detectCanvas = document.createElement("canvas");
const detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true });
const gpuCanvas = document.createElement("canvas");
let gpuGl = null;
let gpuProgram = null;
let gpuVertexBuffer = null;
let gpuFrameTexture = null;
let gpuOutputTexture = null;
let gpuFramebuffer = null;
let gpuBufferWidth = 0;
let gpuBufferHeight = 0;
let cvReady = false;
let cvRuntimeInitStarted = false;

const gpuVertexShaderSource = `#version 300 es
  in vec2 a_position;
  out vec2 v_uv;
  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const gpuMaskFragmentShaderSource = `#version 300 es
  precision mediump float;
  in vec2 v_uv;
  out vec4 outColor;
  uniform sampler2D u_video;
  void main() {
    vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
    vec3 c = texture(u_video, uv).rgb;
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    float maxCh = max(c.r, max(c.g, c.b));
    float minCh = min(c.r, min(c.g, c.b));
    float sat = maxCh - minCh;
    float isWhite = step(0.72, luma) * (1.0 - step(0.11, sat));
    outColor = vec4(isWhite, isWhite, isWhite, 1.0);
  }
`;

function initCvRuntimeIfNeeded() {
  if (cvReady || cvRuntimeInitStarted) return;
  if (!("cv" in window)) return;
  cvRuntimeInitStarted = true;
  const cvGlobal = window.cv;
  if (cvGlobal?.Mat) {
    cvReady = true;
    return;
  }
  cvGlobal.onRuntimeInitialized = () => {
    cvReady = true;
  };
}

function createGpuShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`GPU shader compile error: ${info}`);
  }
  return shader;
}

function ensureGpuPreprocess(targetWidth, targetHeight) {
  if (!gpuGl) {
    gpuGl = gpuCanvas.getContext("webgl2", { premultipliedAlpha: false, antialias: false });
    if (!gpuGl) return false;

    const vs = createGpuShader(gpuGl, gpuGl.VERTEX_SHADER, gpuVertexShaderSource);
    const fs = createGpuShader(gpuGl, gpuGl.FRAGMENT_SHADER, gpuMaskFragmentShaderSource);
    gpuProgram = gpuGl.createProgram();
    gpuGl.attachShader(gpuProgram, vs);
    gpuGl.attachShader(gpuProgram, fs);
    gpuGl.bindAttribLocation(gpuProgram, 0, "a_position");
    gpuGl.linkProgram(gpuProgram);
    gpuGl.deleteShader(vs);
    gpuGl.deleteShader(fs);
    if (!gpuGl.getProgramParameter(gpuProgram, gpuGl.LINK_STATUS)) {
      throw new Error(`GPU program link error: ${gpuGl.getProgramInfoLog(gpuProgram)}`);
    }

    gpuVertexBuffer = gpuGl.createBuffer();
    gpuGl.bindBuffer(gpuGl.ARRAY_BUFFER, gpuVertexBuffer);
    gpuGl.bufferData(
      gpuGl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gpuGl.STATIC_DRAW
    );

    gpuFrameTexture = gpuGl.createTexture();
    gpuGl.bindTexture(gpuGl.TEXTURE_2D, gpuFrameTexture);
    gpuGl.texParameteri(gpuGl.TEXTURE_2D, gpuGl.TEXTURE_MIN_FILTER, gpuGl.LINEAR);
    gpuGl.texParameteri(gpuGl.TEXTURE_2D, gpuGl.TEXTURE_MAG_FILTER, gpuGl.LINEAR);
    gpuGl.texParameteri(gpuGl.TEXTURE_2D, gpuGl.TEXTURE_WRAP_S, gpuGl.CLAMP_TO_EDGE);
    gpuGl.texParameteri(gpuGl.TEXTURE_2D, gpuGl.TEXTURE_WRAP_T, gpuGl.CLAMP_TO_EDGE);
  }

  if (gpuBufferWidth !== targetWidth || gpuBufferHeight !== targetHeight) {
    gpuBufferWidth = targetWidth;
    gpuBufferHeight = targetHeight;
    gpuCanvas.width = targetWidth;
    gpuCanvas.height = targetHeight;

    if (gpuOutputTexture) gpuGl.deleteTexture(gpuOutputTexture);
    gpuOutputTexture = gpuGl.createTexture();
    gpuGl.bindTexture(gpuGl.TEXTURE_2D, gpuOutputTexture);
    gpuGl.texParameteri(gpuGl.TEXTURE_2D, gpuGl.TEXTURE_MIN_FILTER, gpuGl.NEAREST);
    gpuGl.texParameteri(gpuGl.TEXTURE_2D, gpuGl.TEXTURE_MAG_FILTER, gpuGl.NEAREST);
    gpuGl.texParameteri(gpuGl.TEXTURE_2D, gpuGl.TEXTURE_WRAP_S, gpuGl.CLAMP_TO_EDGE);
    gpuGl.texParameteri(gpuGl.TEXTURE_2D, gpuGl.TEXTURE_WRAP_T, gpuGl.CLAMP_TO_EDGE);
    gpuGl.texImage2D(
      gpuGl.TEXTURE_2D,
      0,
      gpuGl.RGBA,
      targetWidth,
      targetHeight,
      0,
      gpuGl.RGBA,
      gpuGl.UNSIGNED_BYTE,
      null
    );

    if (gpuFramebuffer) gpuGl.deleteFramebuffer(gpuFramebuffer);
    gpuFramebuffer = gpuGl.createFramebuffer();
    gpuGl.bindFramebuffer(gpuGl.FRAMEBUFFER, gpuFramebuffer);
    gpuGl.framebufferTexture2D(
      gpuGl.FRAMEBUFFER,
      gpuGl.COLOR_ATTACHMENT0,
      gpuGl.TEXTURE_2D,
      gpuOutputTexture,
      0
    );
    gpuGl.bindFramebuffer(gpuGl.FRAMEBUFFER, null);
  }

  return true;
}

function buildWhiteMaskWithGpuAndCv(targetWidth, targetHeight, yMin, yMax) {
  if (!cvReady) return null;
  if (!ensureGpuPreprocess(targetWidth, targetHeight)) return null;

  gpuGl.viewport(0, 0, targetWidth, targetHeight);
  gpuGl.useProgram(gpuProgram);
  gpuGl.bindFramebuffer(gpuGl.FRAMEBUFFER, gpuFramebuffer);
  gpuGl.bindBuffer(gpuGl.ARRAY_BUFFER, gpuVertexBuffer);
  gpuGl.enableVertexAttribArray(0);
  gpuGl.vertexAttribPointer(0, 2, gpuGl.FLOAT, false, 0, 0);

  gpuGl.activeTexture(gpuGl.TEXTURE0);
  gpuGl.bindTexture(gpuGl.TEXTURE_2D, gpuFrameTexture);
  gpuGl.pixelStorei(gpuGl.UNPACK_FLIP_Y_WEBGL, false);
  gpuGl.texImage2D(
    gpuGl.TEXTURE_2D,
    0,
    gpuGl.RGBA,
    gpuGl.RGBA,
    gpuGl.UNSIGNED_BYTE,
    videoPreviewEl
  );

  const videoLoc = gpuGl.getUniformLocation(gpuProgram, "u_video");
  gpuGl.uniform1i(videoLoc, 0);
  gpuGl.drawArrays(gpuGl.TRIANGLES, 0, 6);

  const rgba = new Uint8Array(targetWidth * targetHeight * 4);
  gpuGl.readPixels(0, 0, targetWidth, targetHeight, gpuGl.RGBA, gpuGl.UNSIGNED_BYTE, rgba);
  gpuGl.bindFramebuffer(gpuGl.FRAMEBUFFER, null);

  const binary = new Uint8Array(targetWidth * targetHeight);
  for (let y = yMin; y < yMax; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const srcIdx = ((targetHeight - 1 - y) * targetWidth + x) * 4;
      binary[y * targetWidth + x] = rgba[srcIdx] > 127 ? 255 : 0;
    }
  }

  const cvGlobal = window.cv;
  const mat = cvGlobal.matFromArray(targetHeight, targetWidth, cvGlobal.CV_8UC1, binary);
  const kernel = cvGlobal.Mat.ones(3, 3, cvGlobal.CV_8U);
  cvGlobal.morphologyEx(mat, mat, cvGlobal.MORPH_OPEN, kernel);
  cvGlobal.morphologyEx(mat, mat, cvGlobal.MORPH_CLOSE, kernel);
  const mask = new Uint8Array(targetWidth * targetHeight);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = mat.data[i] > 0 ? 1 : 0;
  }
  kernel.delete();
  mat.delete();
  return mask;
}

function evaluateEnvironmentRisk(toleranceCm, environmentProfile) {
  if (toleranceCm === 1 && (environmentProfile === "NIGHT_COURT" || environmentProfile === "INDOOR_LED")) {
    return { level: "warning", message: "この環境では ±1cm が不安定になる可能性があります。±3cm への切替を推奨します。" };
  }
  if (toleranceCm === 3 && environmentProfile === "NIGHT_COURT") {
    return { level: "notice", message: "ナイター環境です。基準点を丁寧に再キャリブレーションしてください。" };
  }
  return { level: "ok", message: "環境条件はこのモードで利用可能です。" };
}

function judgeDelta(deltaCm, toleranceCm) {
  if (Math.abs(deltaCm) <= toleranceCm) return "OK（許容範囲内）";
  if (deltaCm > 0) return "高い（調整が必要）";
  return "低い（調整が必要）";
}

function updateGuideLine(deltaCm, state) {
  if (!(inputSourceEl.value === "video" || inputSourceEl.value === "camera")) {
    guideLineEl.classList.add("hidden");
    guideStemEl.classList.add("hidden");
    centerLineEl.classList.add("hidden");
    toleranceBandEl.classList.add("hidden");
    return;
  }

  guideLineEl.classList.remove("hidden");
  guideStemEl.classList.remove("hidden");
  guideLineEl.classList.remove("ok", "high", "low", "pending");
  guideStemEl.classList.remove("ok", "high", "low", "pending");
  guideLineEl.classList.add(state);
  guideStemEl.classList.add(state);

  const clamped = Math.max(-8, Math.min(8, deltaCm));
  const y = 50 - (clamped / 8) * 20;
  guideLineEl.style.top = `${y}%`;
  guideStemEl.style.top = `${y}%`;

  const xCenter = autoReference.ready
    ? (autoReference.xStartPercent + autoReference.xEndPercent) / 2
    : 50;
  guideStemEl.style.left = `${xCenter}%`;
}

function updateToleranceOverlay(toleranceCm) {
  if (!(inputSourceEl.value === "video" || inputSourceEl.value === "camera")) {
    centerLineEl.classList.add("hidden");
    toleranceBandEl.classList.add("hidden");
    return;
  }
  centerLineEl.classList.remove("hidden");
  toleranceBandEl.classList.remove("hidden");

  const centerY = 50;
  const halfRangePercent = (Math.max(1, Math.min(5, toleranceCm)) / 8) * 20;
  toleranceBandEl.style.top = `${centerY - halfRangePercent}%`;
  toleranceBandEl.style.height = `${halfRangePercent * 2}%`;
  centerLineEl.style.top = `${centerY}%`;
}

function adjustDeltaByReferenceConfidence(deltaCm) {
  if (referenceModeEl.value !== "auto" || !(inputSourceEl.value === "video" || inputSourceEl.value === "camera")) {
    return { effectiveDelta: deltaCm, note: "" };
  }

  const c = autoReference.confidence;
  if (c >= 0.75) {
    return { effectiveDelta: deltaCm, note: "推定信頼度: 高" };
  }
  if (c >= 0.5) {
    return {
      effectiveDelta: deltaCm * 0.85,
      note: "推定信頼度: 中（判定を保守的に補正）"
    };
  }
  return {
    effectiveDelta: deltaCm * 0.65,
    note: "推定信頼度: 低（誤判定リスクあり。動画条件改善に加えて、任意で画面下部の地面にテニスボールを置くと安定する場合があります）"
  };
}

function isReferenceReady() {
  if (referenceModeEl.value === "auto") return autoReference.ready;
  return calibrationState === "ready";
}

function isGroundReadyForJudgement() {
  const usingCameraInput = inputSourceEl.value === "camera";
  const usingAutoMode = referenceModeEl.value === "auto";
  if (!usingCameraInput || !usingAutoMode) return true;
  return groundDebug.ready && groundStableDetected;
}

function updateResult() {
  const toleranceCm = Number(toleranceModeEl.value);

  if (!isReferenceReady()) {
    if (referenceModeEl.value === "auto") {
      resultTextEl.textContent = "判定前に自動基準推定を待ってください。";
      guidanceTextEl.textContent = "動画を再生し、ネット上端のホワイトバンドが見える状態にしてください。";
    } else {
      resultTextEl.textContent = "判定前にキャリブレーションを完了してください。";
      guidanceTextEl.textContent = "「キャリブレーション開始」→「基準点を記録」を2回行ってください。";
    }
    updateGuideLine(0, "pending");
    updateToleranceOverlay(toleranceCm);
    return;
  }
  if (!isGroundReadyForJudgement()) {
    resultTextEl.textContent = "地面基準を確認中のため、判定を保留しています。";
    guidanceTextEl.textContent = "カメラを少し下げて地面を画角下部に入れてください。";
    updateGuideLine(0, "pending");
    updateToleranceOverlay(toleranceCm);
    return;
  }

  const environmentProfile = environmentProfileEl.value;
  const courtType = courtTypeEl.value;
  const usingVideoInput = inputSourceEl.value === "video" || inputSourceEl.value === "camera";
  const rawDeltaCm = Number(deltaCmEl.value);
  if (!Number.isFinite(rawDeltaCm)) {
    resultTextEl.textContent = "差分値が不正です。数値を入力してください。";
    guidanceTextEl.textContent = "例: -2, 0, 3.5";
    return;
  }

  const adjusted = adjustDeltaByReferenceConfidence(rawDeltaCm);
  const deltaJudge = judgeDelta(adjusted.effectiveDelta, toleranceCm);
  const risk = evaluateEnvironmentRisk(toleranceCm, environmentProfile);
  const sourceLabel = inputSourceEl.value === "camera"
    ? "実カメラ入力"
    : usingVideoInput
      ? "動画入力（ダミーカメラ）"
      : "シミュレーション入力";
  resultTextEl.textContent =
    `判定: ${deltaJudge} / 差分: ${rawDeltaCm.toFixed(1)}cm` +
    `（評価値: ${adjusted.effectiveDelta.toFixed(1)}cm）` +
    ` / モード: ±${toleranceCm}cm / 入力: ${sourceLabel}`;
  guidanceTextEl.textContent =
    `[${environmentProfile} | ${courtType}] ${risk.message}` +
    (adjusted.note ? ` / ${adjusted.note}` : "");

  if (deltaJudge.startsWith("OK")) updateGuideLine(adjusted.effectiveDelta, "ok");
  else if (deltaJudge.startsWith("高い")) updateGuideLine(adjusted.effectiveDelta, "high");
  else updateGuideLine(adjusted.effectiveDelta, "low");

  updateToleranceOverlay(toleranceCm);
}

function clearCalibrationPoints() {
  calibrationSurfaceEl.querySelectorAll(".calibration-point").forEach((node) => node.remove());
}

function renderCalibrationPoints() {
  clearCalibrationPoints();
  calibrationPointPositions.forEach((pos) => {
    const marker = document.createElement("div");
    marker.className = "calibration-point";
    marker.style.left = `${pos.xPercent}%`;
    marker.style.top = `${pos.yPercent}%`;
    calibrationSurfaceEl.appendChild(marker);
  });
}

function renderAutoReference() {
  if (!(referenceModeEl.value === "auto" && autoReference.ready && (inputSourceEl.value === "video" || inputSourceEl.value === "camera"))) {
    autoReferenceLineEl.classList.add("hidden");
    return;
  }
  autoReferenceLineEl.classList.remove("hidden");
  autoReferenceLineEl.style.left = `${autoReference.xStartPercent}%`;
  autoReferenceLineEl.style.top = `${autoReference.yPercent}%`;
  autoReferenceLineEl.style.width = `${Math.max(2, autoReference.xEndPercent - autoReference.xStartPercent)}%`;
}

function resetAutoReferenceHistory() {
  autoReferenceHistory.length = 0;
}

function pushAutoReferenceSample(sample) {
  autoReferenceHistory.push(sample);
  if (autoReferenceHistory.length > AUTO_REFERENCE_HISTORY_SIZE) {
    autoReferenceHistory.shift();
  }
}

function applySmoothedAutoReference() {
  if (autoReferenceHistory.length === 0) {
    autoReference.ready = false;
    autoReference.confidence = 0;
    return;
  }

  const valid = autoReferenceHistory.filter((s) => s.ready);
  if (valid.length < 3) {
    autoReference.ready = false;
    autoReference.confidence = 0;
    return;
  }

  const avg = (arr, k) => arr.reduce((sum, item) => sum + item[k], 0) / arr.length;
  autoReference.ready = true;
  autoReference.confidence = Math.max(0, Math.min(1, avg(valid, "confidence")));
  autoReference.yPercent = avg(valid, "yPercent");
  autoReference.xStartPercent = avg(valid, "xStartPercent");
  autoReference.xEndPercent = avg(valid, "xEndPercent");
}

function syncJudgeAvailability() {
  judgeBtnEl.disabled = !isReferenceReady();
}

function setInputSourceUi() {
  const usingVideoInput = inputSourceEl.value === "video" || inputSourceEl.value === "camera";
  const usingCameraInput = inputSourceEl.value === "camera";
  const manualMode = referenceModeEl.value === "manual";

  videoFileRowEl.classList.toggle("hidden", !usingVideoInput || usingCameraInput);
  videoScenarioRowEl.classList.toggle("hidden", !usingVideoInput);
  cameraControlsRowEl.classList.toggle("hidden", !usingCameraInput);
  videoPreviewCardEl.classList.toggle("hidden", !usingVideoInput);
  deltaCmEl.disabled = usingVideoInput;
  startCalibrationBtnEl.disabled = !manualMode;
  capturePointBtnEl.disabled = !(manualMode && calibrationState === "capturing");
  const tapLayerActive = usingVideoInput && manualMode && calibrationState === "capturing";
  surfaceTapLayerEl.disabled = !tapLayerActive;
  surfaceTapLayerEl.classList.toggle("active", tapLayerActive);
  videoPreviewEl.controls = !usingCameraInput;

  if (inputSourceEl.value === "video") {
    sourceNoticeEl.textContent = "保存動画をダミーカメラ入力として使います。差分値は選択シナリオに応じて擬似生成されます。";
    if (!videoPreviewEl.srcObject && !videoPreviewEl.src) {
      deltaCmEl.value = "0";
      videoStatusEl.textContent = "動画未選択";
    }
  } else if (inputSourceEl.value === "camera") {
    sourceNoticeEl.textContent = "実カメラ映像にガイド線をオーバーレイします（iPhoneはHTTPSでアクセスしてください）。";
    if (!videoPreviewEl.srcObject) {
      deltaCmEl.value = "0";
      videoStatusEl.textContent = "カメラ未開始";
    }
  } else {
    sourceNoticeEl.textContent = "開発用モードです。本番ではカメラ計測値を自動入力します。";
    videoStatusEl.textContent = "シミュレーション入力モード";
  }

  if (groundDebugEl) {
    groundDebugEl.classList.toggle("hidden", !usingVideoInput);
  }

  renderAutoReference();
}

function updateGroundDebugUi() {
  if (!groundDebugEl) return;
  if (!(inputSourceEl.value === "video" || inputSourceEl.value === "camera")) {
    groundDebugEl.textContent = "地面推定: 未評価";
    return;
  }
  if (!videoPreviewEl.srcObject && !videoPreviewEl.src) {
    groundDebugEl.textContent = "地面推定: カメラ開始待ち";
    return;
  }
  if (!groundDebug.ready) {
    groundDebugEl.textContent = "地面推定: 評価中";
    return;
  }
  const state = groundStableDetected ? "OK" : "未検出";
  const rawState = groundDebug.detected ? "OK" : "未検出";
  const coverage = (groundDebug.coverage * 100).toFixed(0);
  const edge = groundDebug.edgeStrength.toFixed(1);
  const roi = `${(groundRoiStartRatio * 100).toFixed(0)}-${(groundRoiEndRatio * 100).toFixed(0)}%`;
  groundDebugEl.textContent = `地面推定: ${state} (raw ${rawState} / coverage ${coverage}% / edge ${edge} / roi ${roi})`;
}

function detectAdaptiveGroundRoi(frame, width, height) {
  const minY = Math.floor(height * 0.50);
  const maxY = Math.floor(height * 0.98);
  const stepX = 2;
  const rowScore = new Array(height).fill(0);

  for (let y = minY; y < maxY - 1; y += 1) {
    let edgeSum = 0;
    let valid = 0;
    for (let x = 0; x < width; x += stepX) {
      const idx = (y * width + x) * 4;
      const idx2 = ((y + 1) * width + x) * 4;
      const r = frame.data[idx];
      const g = frame.data[idx + 1];
      const b = frame.data[idx + 2];
      const r2 = frame.data[idx2];
      const g2 = frame.data[idx2 + 1];
      const b2 = frame.data[idx2 + 2];
      const luma = (0.299 * r) + (0.587 * g) + (0.114 * b);
      const luma2 = (0.299 * r2) + (0.587 * g2) + (0.114 * b2);
      edgeSum += Math.abs(luma2 - luma);
      valid += 1;
    }
    rowScore[y] = valid > 0 ? edgeSum / valid : 0;
  }

  const bandPx = Math.max(16, Math.round(height * 0.24));
  let bestStart = Math.floor(height * 0.68);
  let bestScore = -1;
  for (let y = minY; y <= maxY - bandPx; y += 1) {
    let sum = 0;
    for (let j = 0; j < bandPx; j += 1) {
      sum += rowScore[y + j];
    }
    const avg = sum / bandPx;
    if (avg > bestScore) {
      bestScore = avg;
      bestStart = y;
    }
  }

  const bestEnd = Math.min(height - 1, bestStart + bandPx);
  const targetStart = bestStart / height;
  const targetEnd = bestEnd / height;
  groundRoiStartRatio = (groundRoiStartRatio * 0.8) + (targetStart * 0.2);
  groundRoiEndRatio = (groundRoiEndRatio * 0.8) + (targetEnd * 0.2);
}

function updateGroundDynamicThresholds(detected) {
  const baseCoverage = 0.14;
  const baseEdge = 5.5;
  if (!detected) {
    groundMissStreak += 1;
    groundEffectiveCoverageThreshold = Math.max(0.06, baseCoverage - (0.008 * groundMissStreak));
    groundEffectiveEdgeThreshold = Math.max(2.0, baseEdge - (0.28 * groundMissStreak));
  } else {
    groundMissStreak = 0;
    groundEffectiveCoverageThreshold = (groundEffectiveCoverageThreshold * 0.65) + (baseCoverage * 0.35);
    groundEffectiveEdgeThreshold = (groundEffectiveEdgeThreshold * 0.65) + (baseEdge * 0.35);
  }
}

function updateGroundStableState(rawDetected) {
  if (rawDetected) {
    groundConsecutiveOk += 1;
    groundConsecutiveMiss = 0;
    if (!groundStableDetected && groundConsecutiveOk >= GROUND_OK_FRAMES_TO_LOCK) {
      groundStableDetected = true;
    }
    return;
  }
  groundConsecutiveMiss += 1;
  groundConsecutiveOk = 0;
  if (groundStableDetected && groundConsecutiveMiss >= GROUND_MISS_FRAMES_TO_DROP) {
    groundStableDetected = false;
  }
}

function estimateGroundPresenceFromVideo() {
  if (!detectCtx || !Number.isFinite(videoPreviewEl.videoWidth) || videoPreviewEl.videoWidth <= 0) {
    groundDebug = { ready: false, detected: false, coverage: 0, edgeStrength: 0 };
    updateGroundDebugUi();
    return;
  }

  const targetWidth = 192;
  const scale = targetWidth / videoPreviewEl.videoWidth;
  const targetHeight = Math.max(108, Math.round(videoPreviewEl.videoHeight * scale));
  detectCanvas.width = targetWidth;
  detectCanvas.height = targetHeight;
  detectCtx.drawImage(videoPreviewEl, 0, 0, targetWidth, targetHeight);
  const frame = detectCtx.getImageData(0, 0, targetWidth, targetHeight);

  detectAdaptiveGroundRoi(frame, targetWidth, targetHeight);
  const yStart = Math.max(0, Math.floor(targetHeight * groundRoiStartRatio));
  const yEnd = Math.min(targetHeight, Math.ceil(targetHeight * groundRoiEndRatio));
  let total = 0;
  let candidate = 0;
  let edgeAcc = 0;

  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = 0; x < targetWidth; x += 2) {
      const idx = (y * targetWidth + x) * 4;
      const r = frame.data[idx];
      const g = frame.data[idx + 1];
      const b = frame.data[idx + 2];
      const luma = (0.299 * r) + (0.587 * g) + (0.114 * b);
      const maxCh = Math.max(r, g, b);
      const minCh = Math.min(r, g, b);
      const sat = maxCh - minCh;
      if (luma > 24 && luma < 240 && sat > 16) {
        candidate += 1;
      }
      if (y + 1 < yEnd) {
        const idx2 = ((y + 1) * targetWidth + x) * 4;
        const r2 = frame.data[idx2];
        const g2 = frame.data[idx2 + 1];
        const b2 = frame.data[idx2 + 2];
        const luma2 = (0.299 * r2) + (0.587 * g2) + (0.114 * b2);
        edgeAcc += Math.abs(luma2 - luma);
      }
      total += 1;
    }
  }

  const coverage = total > 0 ? candidate / total : 0;
  const edgeStrength = total > 0 ? edgeAcc / total : 0;
  const detected =
    coverage >= groundEffectiveCoverageThreshold &&
    edgeStrength >= groundEffectiveEdgeThreshold;
  updateGroundDynamicThresholds(detected);
  updateGroundStableState(detected);
  groundDebug = { ready: true, detected, coverage, edgeStrength };
  detectionDebug.groundCoverage = Number(coverage.toFixed(3));
  detectionDebug.groundEdgeStrength = Number(edgeStrength.toFixed(3));
  detectionDebug.groundDetected = detected;
  detectionDebug.groundRoiStart = Number(groundRoiStartRatio.toFixed(3));
  detectionDebug.groundRoiEnd = Number(groundRoiEndRatio.toFixed(3));
  detectionDebug.groundEffectiveCoverageThreshold = Number(groundEffectiveCoverageThreshold.toFixed(3));
  detectionDebug.groundEffectiveEdgeThreshold = Number(groundEffectiveEdgeThreshold.toFixed(3));
  detectionDebug.groundMissStreak = groundMissStreak;
  detectionDebug.groundStableDetected = groundStableDetected;
  detectionDebug.groundConsecutiveOk = groundConsecutiveOk;
  detectionDebug.groundConsecutiveMiss = groundConsecutiveMiss;
  updateGroundDebugUi();
}

function updateCalibrationStatus() {
  if (referenceModeEl.value === "auto") {
    if (!(inputSourceEl.value === "video" || inputSourceEl.value === "camera")) {
      calibrationStatusEl.textContent = "状態: 自動モード";
    } else if (!autoReference.ready) {
      calibrationStatusEl.textContent = "状態: 自動推定中（基準ラインを検出中）";
    } else {
      calibrationStatusEl.textContent = `状態: 自動推定完了（信頼度 ${(autoReference.confidence * 100).toFixed(0)}%）`;
    }
    syncJudgeAvailability();
    setInputSourceUi();
    return;
  }

  if (calibrationState === "idle") {
    calibrationStatusEl.textContent = "状態: 未実施";
  } else if (calibrationState === "capturing") {
    calibrationStatusEl.textContent = `状態: 実施中（${calibrationPoints}/2点 記録済み）`;
  } else {
    calibrationStatusEl.textContent = "状態: 完了（2点記録済み）";
  }
  syncJudgeAvailability();
  setInputSourceUi();
}

function startCalibration() {
  calibrationState = "capturing";
  calibrationPoints = 0;
  calibrationPointPositions = [];
  clearCalibrationPoints();
  updateCalibrationStatus();
  resultTextEl.textContent = "キャリブレーションを開始しました。基準点を2点記録してください。";
  guidanceTextEl.textContent = inputSourceEl.value === "video"
    ? "動画プレビューをタップして1点目と2点目を記録してください。"
    : "1点目と2点目を順に記録してください。";
}

function captureCalibrationPoint() {
  if (calibrationState !== "capturing") return;
  calibrationPoints += 1;
  if (calibrationPoints >= 2) {
    calibrationState = "ready";
    calibrationPoints = 2;
    updateCalibrationStatus();
    resultTextEl.textContent = "キャリブレーション完了。判定可能です。";
    guidanceTextEl.textContent = "入力を調整して「判定する」を押してください。";
    return;
  }
  updateCalibrationStatus();
  guidanceTextEl.textContent = inputSourceEl.value === "video"
    ? "1点目を記録しました。動画プレビューをもう一度タップしてください。"
    : "1点目を記録しました。2点目を記録してください。";
}

function resetCalibration() {
  calibrationState = "idle";
  calibrationPoints = 0;
  calibrationPointPositions = [];
  autoReference = { ready: false, confidence: 0, yPercent: 0, xStartPercent: 0, xEndPercent: 0 };
  resetAutoReferenceHistory();
  clearCalibrationPoints();
  renderAutoReference();
  updateCalibrationStatus();
  resultTextEl.textContent = "キャリブレーションをリセットしました。";
  guidanceTextEl.textContent = "判定前に基準推定を行ってください。";
}

async function startCamera() {
  try {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    videoPreviewEl.pause();
    videoPreviewEl.removeAttribute("src");
    videoPreviewEl.srcObject = null;
    videoPreviewEl.muted = true;
    videoPreviewEl.autoplay = true;
    videoPreviewEl.playsInline = true;
    videoPreviewEl.setAttribute("playsinline", "");
    videoPreviewEl.setAttribute("webkit-playsinline", "");
    videoPreviewEl.srcObject = cameraStream;
    await new Promise((resolve) => {
      if (videoPreviewEl.readyState >= 1) {
        resolve();
        return;
      }
      videoPreviewEl.onloadedmetadata = () => resolve();
    });
    await videoPreviewEl.play();
    const width = videoPreviewEl.videoWidth;
    const height = videoPreviewEl.videoHeight;
    videoStatusEl.textContent = width > 0 && height > 0
      ? `カメラ入力中 (${width}x${height})`
      : "カメラ入力中";
    autoReference.ready = false;
    autoReference.confidence = 0;
    resetAutoReferenceHistory();
    updateCalibrationStatus();
  } catch (error) {
    videoStatusEl.textContent = `カメラ開始失敗: ${error?.message ?? String(error)}`;
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  videoPreviewEl.pause();
  videoPreviewEl.srcObject = null;
  videoStatusEl.textContent = "カメラ停止";
  groundDebug = { ready: false, detected: false, coverage: 0, edgeStrength: 0 };
  groundRoiStartRatio = 0.68;
  groundRoiEndRatio = 0.96;
  groundMissStreak = 0;
  groundEffectiveCoverageThreshold = 0.14;
  groundEffectiveEdgeThreshold = 5.5;
  groundStableDetected = false;
  groundConsecutiveOk = 0;
  groundConsecutiveMiss = 0;
  updateGroundDebugUi();
}

function capturePointFromSurface(event) {
  if (!(inputSourceEl.value === "video" || inputSourceEl.value === "camera") || referenceModeEl.value !== "manual" || calibrationState !== "capturing") return;
  if (!videoPreviewEl.src && !videoPreviewEl.srcObject) {
    guidanceTextEl.textContent = "先にカメラを開始してください。";
    return;
  }
  const rect = calibrationSurfaceEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const xPercent = ((event.clientX - rect.left) / rect.width) * 100;
  const yPercent = ((event.clientY - rect.top) / rect.height) * 100;
  calibrationPointPositions.push({ xPercent, yPercent });
  renderCalibrationPoints();
  captureCalibrationPoint();
}

function detectAutoReferenceFromVideo() {
  initCvRuntimeIfNeeded();
  const sample = { ready: false, confidence: 0, yPercent: 0, xStartPercent: 0, xEndPercent: 0 };
  if (!detectCtx || !Number.isFinite(videoPreviewEl.videoWidth) || videoPreviewEl.videoWidth <= 0) {
    pushAutoReferenceSample(sample);
    applySmoothedAutoReference();
    return;
  }
  const targetWidth = 320;
  const scale = targetWidth / videoPreviewEl.videoWidth;
  const targetHeight = Math.max(120, Math.round(videoPreviewEl.videoHeight * scale));
  detectCanvas.width = targetWidth;
  detectCanvas.height = targetHeight;
  detectCtx.drawImage(videoPreviewEl, 0, 0, targetWidth, targetHeight);
  const frame = detectCtx.getImageData(0, 0, targetWidth, targetHeight);
  const whiteMaskFallback = new Uint8Array(targetWidth * targetHeight);
  const rowCounts = new Array(targetHeight).fill(0);
  const colCounts = new Array(targetWidth).fill(0);

  const yMin = Math.floor(targetHeight * 0.2);
  const yMax = Math.floor(targetHeight * 0.85);
  let whiteMask = buildWhiteMaskWithGpuAndCv(targetWidth, targetHeight, yMin, yMax);

  for (let y = yMin; y < yMax; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const id = y * targetWidth + x;
      if (!whiteMask) {
        const idx = id * 4;
        const r = frame.data[idx];
        const g = frame.data[idx + 1];
        const b = frame.data[idx + 2];
        const bright = r + g + b > 640;
        const nearWhite = Math.abs(r - g) < 24 && Math.abs(g - b) < 24;
        if (bright && nearWhite) {
          whiteMaskFallback[id] = 1;
          rowCounts[y] += 1;
          colCounts[x] += 1;
        }
      } else if (whiteMask[id] === 1) {
        rowCounts[y] += 1;
        colCounts[x] += 1;
      }
    }
  }
  if (!whiteMask) {
    whiteMask = whiteMaskFallback;
  }

  let bestY = -1;
  let bestRowCount = 0;
  for (let y = yMin; y < yMax; y += 1) {
    if (rowCounts[y] > bestRowCount) {
      bestRowCount = rowCounts[y];
      bestY = y;
    }
  }
  if (bestY < 0 || bestRowCount < targetWidth * 0.08) {
    pushAutoReferenceSample(sample);
    applySmoothedAutoReference();
    return;
  }

  let bestX = -1;
  let bestColCount = 0;
  for (let x = Math.floor(targetWidth * 0.1); x < Math.floor(targetWidth * 0.9); x += 1) {
    if (colCounts[x] > bestColCount) {
      bestColCount = colCounts[x];
      bestX = x;
    }
  }
  if (bestX < 0 || bestColCount < targetHeight * 0.08) {
    pushAutoReferenceSample(sample);
    applySmoothedAutoReference();
    return;
  }

  // 局所平面近似: ホワイトバンドの傾きを線形近似して、斜め撮影時のT字判定を安定化する。
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const sampleBandY = (x, yCenter, range) => {
    const xClamped = clamp(x, 0, targetWidth - 1);
    let best = -1;
    let bestYLocal = yCenter;
    for (let dy = -range; dy <= range; dy += 1) {
      const y = yCenter + dy;
      if (y < yMin || y >= yMax) continue;
      if (whiteMask[y * targetWidth + xClamped] === 1) {
        const score = range - Math.abs(dy);
        if (score > best) {
          best = score;
          bestYLocal = y;
        }
      }
    }
    return best >= 0 ? bestYLocal : null;
  };

  const fitPoints = [];
  const xStartFit = Math.floor(targetWidth * 0.12);
  const xEndFit = Math.floor(targetWidth * 0.88);
  const xStep = Math.max(8, Math.round(targetWidth * 0.06));
  const searchRange = Math.max(6, Math.round(targetHeight * 0.06));
  for (let x = xStartFit; x <= xEndFit; x += xStep) {
    const yHit = sampleBandY(x, bestY, searchRange);
    if (yHit !== null) fitPoints.push({ x, y: yHit });
  }

  let bandSlope = 0;
  let bandOffset = bestY;
  if (fitPoints.length >= 4) {
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    fitPoints.forEach((p) => {
      sx += p.x;
      sy += p.y;
      sxx += p.x * p.x;
      sxy += p.x * p.y;
    });
    const n = fitPoints.length;
    const den = (n * sxx) - (sx * sx);
    if (Math.abs(den) > 1e-6) {
      bandSlope = ((n * sxy) - (sx * sy)) / den;
      bandOffset = (sy - (bandSlope * sx)) / n;
    }
  }
  const yOnBandAt = (x) => clamp(Math.round((bandSlope * x) + bandOffset), yMin, yMax - 1);
  const bandYAtX = yOnBandAt(bestX);

  // T字近傍（交点周辺）で横線・縦線の白画素密度を評価する
  // 公式ネットは中央が少し下がるため、縦線は「交点より下側」をやや重視する。
  const hHalf = Math.max(8, Math.round(targetWidth * 0.08));
  const vHalf = Math.max(8, Math.round(targetHeight * 0.08));
  let horizontalHits = 0;
  let verticalHitsSym = 0;
  let verticalHitsDown = 0;
  let verticalHitsUp = 0;
  for (let dx = -hHalf; dx <= hHalf; dx += 1) {
    const x = bestX + dx;
    if (x >= 0 && x < targetWidth) {
      const y = yOnBandAt(x);
      if (whiteMask[y * targetWidth + x] === 1) horizontalHits += 1;
    }
  }
  for (let dy = -vHalf; dy <= vHalf; dy += 1) {
    const y = bandYAtX + dy;
    if (y >= 0 && y < targetHeight) {
      if (whiteMask[y * targetWidth + bestX] === 1) {
        verticalHitsSym += 1;
        if (dy >= 0) verticalHitsDown += 1;
        if (dy <= 0) verticalHitsUp += 1;
      }
    }
  }
  const tHorizontalScore = horizontalHits / (hHalf * 2 + 1);
  const tVerticalScoreSym = verticalHitsSym / (vHalf * 2 + 1);
  const tVerticalScoreDown = verticalHitsDown / (vHalf + 1);
  const tVerticalScoreUp = verticalHitsUp / (vHalf + 1);
  const tVerticalScore = Math.max(tVerticalScoreSym, (tVerticalScoreDown * 0.75) + (tVerticalScoreUp * 0.25));
  const tScore = Math.min(tHorizontalScore, tVerticalScore);

  let xStart = -1;
  let xEnd = -1;
  for (let x = 0; x < targetWidth; x += 1) {
    const y = yOnBandAt(x);
    if (whiteMask[y * targetWidth + x] === 1) {
      if (xStart < 0) xStart = x;
      xEnd = x;
    }
  }
  if (xStart < 0 || xEnd <= xStart || tScore < 0.2) {
    sample.confidence = tScore;
    pushAutoReferenceSample(sample);
    applySmoothedAutoReference();
    return;
  }

  const rowStrength = Math.min(1, bestRowCount / (targetWidth * 0.6));
  const colStrength = Math.min(1, bestColCount / (targetHeight * 0.6));
  detectionDebug = {
    rowStrength,
    colStrength,
    bandSlope,
    tHorizontalScore,
    tVerticalScoreSym,
    tVerticalScoreDown,
    tVerticalScoreUp,
    tVerticalScoreFinal: tVerticalScore,
    tScore
  };
  sample.ready = true;
  sample.confidence = Math.min(1, (rowStrength * 0.35) + (colStrength * 0.35) + (tScore * 0.3));
  sample.yPercent = (bandYAtX / targetHeight) * 100;
  sample.xStartPercent = (xStart / targetWidth) * 100;
  sample.xEndPercent = (xEnd / targetWidth) * 100;
  pushAutoReferenceSample(sample);
  applySmoothedAutoReference();
}

function simulatedDeltaFromVideo(videoEl) {
  if (!Number.isFinite(videoEl.duration) || videoEl.duration <= 0) return 0;
  const progress = videoEl.currentTime / videoEl.duration;
  const scenario = videoScenarioEl.value;
  if (scenario === "stable") return Number((Math.sin(progress * Math.PI * 2) * 1.2).toFixed(1));
  if (scenario === "wobble") return Number((Math.sin(progress * Math.PI * 8) * 4).toFixed(1));
  if (scenario === "drift") return Number((progress * 8 - 4).toFixed(1));
  return Number((Math.sin(progress * Math.PI * 6) * 3 + Math.sin(progress * Math.PI * 38) * 1.4).toFixed(1));
}

function attachVideo(file) {
  if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
  currentVideoUrl = URL.createObjectURL(file);
  videoPreviewEl.src = currentVideoUrl;
  videoPreviewEl.load();
  videoStatusEl.textContent = `読み込み済み: ${file.name}`;
}

function handleVideoProgress() {
  if (!(inputSourceEl.value === "video" || inputSourceEl.value === "camera")) return;
  estimateGroundPresenceFromVideo();
  if (referenceModeEl.value === "auto") {
    detectAutoReferenceFromVideo();
    renderAutoReference();
    updateCalibrationStatus();
  }
  const simulatedDelta =
    inputSourceEl.value === "camera"
      ? Number((((50 - autoReference.yPercent) / 20) * 8).toFixed(1))
      : simulatedDeltaFromVideo(videoPreviewEl);
  deltaCmEl.value = String(simulatedDelta);
  if (inputSourceEl.value === "video") {
    videoStatusEl.textContent = `再生中シナリオ: ${videoScenarioEl.value} / 擬似差分: ${simulatedDelta.toFixed(1)}cm`;
  } else {
    videoStatusEl.textContent = `カメラ入力中 / 推定差分: ${simulatedDelta.toFixed(1)}cm`;
  }
  updateResult();
}

function captureCurrentContext() {
  return {
    inputSource: inputSourceEl.value,
    referenceMode: referenceModeEl.value,
    toleranceModeCm: Number(toleranceModeEl.value),
    environmentProfile: environmentProfileEl.value,
    courtType: courtTypeEl.value,
    simulatedDeltaCm: Number(deltaCmEl.value),
    calibrationState,
    calibrationPoints,
    autoReferenceReady: autoReference.ready,
    autoReferenceConfidence: autoReference.confidence,
    detectionDebug,
    videoScenario: videoScenarioEl.value,
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString()
  };
}

function updateFeedbackStatus(message) {
  feedbackStatusEl.textContent = `${message} / 記録件数: ${feedbackEntries.length}`;
}

function addFeedbackEntry() {
  const expected = feedbackExpectedEl.value.trim();
  const actual = feedbackActualEl.value.trim();
  const steps = feedbackStepsEl.value.trim();
  if (!expected || !actual) {
    updateFeedbackStatus("期待した動作と実際の結果を入力してください");
    return;
  }
  feedbackEntries.push({
    id: `fb-${Date.now()}`,
    category: feedbackCategoryEl.value,
    expected,
    actual,
    steps,
    context: captureCurrentContext()
  });
  feedbackExpectedEl.value = "";
  feedbackActualEl.value = "";
  feedbackStepsEl.value = "";
  updateFeedbackStatus("フィードバックを追加しました");
}

function exportFeedbackJson() {
  if (feedbackEntries.length === 0) {
    updateFeedbackStatus("書き出すフィードバックがありません");
    return;
  }
  const payload = { project: "tennis-caliper-ar", exportedAt: new Date().toISOString(), entries: feedbackEntries };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tennis-caliper-ar-feedback-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  updateFeedbackStatus("JSONを書き出しました");
}

if (inputSourceEl) {
  inputSourceEl.value = "camera";
}

referenceModeEl.addEventListener("change", () => {
  calibrationState = "idle";
  calibrationPoints = 0;
  calibrationPointPositions = [];
  autoReference = { ready: false, confidence: 0, yPercent: 0, xStartPercent: 0, xEndPercent: 0 };
  resetAutoReferenceHistory();
  clearCalibrationPoints();
  renderAutoReference();
  setInputSourceUi();
  updateCalibrationStatus();
  updateResult();
});

videoFileEl.addEventListener("change", () => {
  const file = videoFileEl.files && videoFileEl.files[0];
  if (!file) return;
  attachVideo(file);
  autoReference.ready = false;
  autoReference.confidence = 0;
  resetAutoReferenceHistory();
  renderAutoReference();
  updateCalibrationStatus();
});

videoPreviewEl.addEventListener("timeupdate", handleVideoProgress);
videoPreviewEl.addEventListener("loadedmetadata", handleVideoProgress);
videoScenarioEl.addEventListener("change", handleVideoProgress);
videoPreviewEl.addEventListener("playing", handleVideoProgress);
surfaceTapLayerEl.addEventListener("click", capturePointFromSurface);
startCalibrationBtnEl.addEventListener("click", startCalibration);
capturePointBtnEl.addEventListener("click", captureCalibrationPoint);
resetCalibrationBtnEl.addEventListener("click", resetCalibration);
judgeBtnEl.addEventListener("click", updateResult);
startCameraBtnEl.addEventListener("click", startCamera);
stopCameraBtnEl.addEventListener("click", stopCamera);
addFeedbackBtnEl.addEventListener("click", addFeedbackEntry);
exportFeedbackBtnEl.addEventListener("click", exportFeedbackJson);

setInputSourceUi();
updateCalibrationStatus();
updateFeedbackStatus("未記録");
updateResult();
