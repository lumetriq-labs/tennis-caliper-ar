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

const VERSION = "v0.2.2";
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

  const halfRangePercent = (Math.max(1, Math.min(5, toleranceCm)) / 8) * 20;
  toleranceBandEl.style.top = `${50 - halfRangePercent}%`;
  toleranceBandEl.style.height = `${halfRangePercent * 2}%`;
}

function adjustDeltaByReferenceConfidence(deltaCm) {
  if (referenceModeEl.value !== "auto" || inputSourceEl.value !== "video") {
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
  if (inputSourceEl.value === "simulation") return true;
  if (referenceModeEl.value === "auto") return autoReference.ready;
  return calibrationState === "ready";
}

function updateResult() {
  const toleranceCm = Number(toleranceModeEl.value);
  updateToleranceOverlay(toleranceCm);

  if (!isReferenceReady()) {
    if (referenceModeEl.value === "auto") {
      resultTextEl.textContent = "判定前に自動基準推定を待ってください。";
      guidanceTextEl.textContent = "動画を再生し、ネット上端のホワイトバンドが見える状態にしてください。";
    } else {
      resultTextEl.textContent = "判定前にキャリブレーションを完了してください。";
      guidanceTextEl.textContent = "「キャリブレーション開始」→「基準点を記録」を2回行ってください。";
    }
    updateGuideLine(0, "pending");
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
  const sourceLabel = usingVideoInput ? "動画入力（ダミーカメラ）" : "シミュレーション入力";
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
  if (!(referenceModeEl.value === "auto" && autoReference.ready && inputSourceEl.value === "video")) {
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

  renderAutoReference();
}

function updateCalibrationStatus() {
  if (referenceModeEl.value === "auto") {
    if (inputSourceEl.value !== "video") {
      calibrationStatusEl.textContent = "状態: 自動モード（シミュレーション入力では常時判定可能）";
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
}

function capturePointFromSurface(event) {
  if (inputSourceEl.value !== "video" || referenceModeEl.value !== "manual" || calibrationState !== "capturing") return;
  if (!videoPreviewEl.src) {
    guidanceTextEl.textContent = "先に動画ファイルを選択してください。";
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
  const whiteMask = new Uint8Array(targetWidth * targetHeight);
  const rowCounts = new Array(targetHeight).fill(0);
  const colCounts = new Array(targetWidth).fill(0);

  const yMin = Math.floor(targetHeight * 0.2);
  const yMax = Math.floor(targetHeight * 0.85);
  for (let y = yMin; y < yMax; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const idx = (y * targetWidth + x) * 4;
      const r = frame.data[idx];
      const g = frame.data[idx + 1];
      const b = frame.data[idx + 2];
      const bright = r + g + b > 640;
      const nearWhite = Math.abs(r - g) < 24 && Math.abs(g - b) < 24;
      if (bright && nearWhite) {
        whiteMask[y * targetWidth + x] = 1;
        rowCounts[y] += 1;
        colCounts[x] += 1;
      }
    }
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

inputSourceEl.addEventListener("change", () => {
  if (inputSourceEl.value !== "camera") {
    stopCamera();
  } else {
    startCamera();
  }
  setInputSourceUi();
  updateCalibrationStatus();
  updateResult();
});

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
