const startBtnEl = document.getElementById("startBtn");
const stopBtnEl = document.getElementById("stopBtn");
const cameraStatusEl = document.getElementById("cameraStatus");
const videoPreviewEl = document.getElementById("videoPreview");
const roiOverlayEl = document.getElementById("roiOverlay");
const debugLayerEl = document.getElementById("debugLayer");
const resultEl = document.getElementById("result");
const metricsEl = document.getElementById("metrics");
const coverageThresholdEl = document.getElementById("coverageThreshold");
const edgeThresholdEl = document.getElementById("edgeThreshold");
const coverageThresholdTextEl = document.getElementById("coverageThresholdText");
const edgeThresholdTextEl = document.getElementById("edgeThresholdText");
const showCandidatesEl = document.getElementById("showCandidates");

let cameraStream = null;
let rafId = null;
let smoothedRoiStart = 0.68;
let smoothedRoiEnd = 0.96;

const detectCanvas = document.createElement("canvas");
const detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true });
const debugCtx = debugLayerEl.getContext("2d");

function updateDebugLayerSize() {
  if (!videoPreviewEl.videoWidth || !videoPreviewEl.videoHeight) return;
  debugLayerEl.width = videoPreviewEl.videoWidth;
  debugLayerEl.height = videoPreviewEl.videoHeight;
}

function clearDebugLayer() {
  debugCtx.clearRect(0, 0, debugLayerEl.width, debugLayerEl.height);
}

function updateThresholdLabels() {
  coverageThresholdTextEl.textContent = `coverage閾値: ${Number(coverageThresholdEl.value).toFixed(2)}`;
  edgeThresholdTextEl.textContent = `edge閾値: ${Number(edgeThresholdEl.value).toFixed(1)}`;
}

function updateRoiOverlay(roiStartRatio = 0.68, roiEndRatio = 0.96) {
  roiOverlayEl.style.left = "0%";
  roiOverlayEl.style.width = "100%";
  roiOverlayEl.style.top = `${(roiStartRatio * 100).toFixed(1)}%`;
  roiOverlayEl.style.height = `${((roiEndRatio - roiStartRatio) * 100).toFixed(1)}%`;
}

function detectAdaptiveRoiRange(frame, width, height) {
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
  smoothedRoiStart = (smoothedRoiStart * 0.8) + (targetStart * 0.2);
  smoothedRoiEnd = (smoothedRoiEnd * 0.8) + (targetEnd * 0.2);
  return {
    startRatio: smoothedRoiStart,
    endRatio: smoothedRoiEnd
  };
}

function estimateGroundPresence() {
  if (!detectCtx || !videoPreviewEl.videoWidth || !videoPreviewEl.videoHeight) {
    return null;
  }

  const targetWidth = 192;
  const scale = targetWidth / videoPreviewEl.videoWidth;
  const targetHeight = Math.max(108, Math.round(videoPreviewEl.videoHeight * scale));
  detectCanvas.width = targetWidth;
  detectCanvas.height = targetHeight;
  detectCtx.drawImage(videoPreviewEl, 0, 0, targetWidth, targetHeight);
  const frame = detectCtx.getImageData(0, 0, targetWidth, targetHeight);

  const roi = detectAdaptiveRoiRange(frame, targetWidth, targetHeight);
  const yStart = Math.max(0, Math.floor(targetHeight * roi.startRatio));
  const yEnd = Math.min(targetHeight, Math.ceil(targetHeight * roi.endRatio));
  updateRoiOverlay(roi.startRatio, roi.endRatio);
  let total = 0;
  let candidate = 0;
  let edgeAcc = 0;
  const candidatePoints = [];

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
        if (x % 6 === 0 && y % 4 === 0) {
          candidatePoints.push({ x, y });
        }
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
    coverage >= Number(coverageThresholdEl.value) &&
    edgeStrength >= Number(edgeThresholdEl.value);
  return {
    detected,
    coverage,
    edgeStrength,
    roiStart: roi.startRatio,
    roiEnd: roi.endRatio,
    points: candidatePoints,
    sampleWidth: targetWidth,
    sampleHeight: targetHeight
  };
}

function drawCandidatePoints(result) {
  clearDebugLayer();
  if (!showCandidatesEl.checked || !result) return;
  const scaleX = debugLayerEl.width / result.sampleWidth;
  const scaleY = debugLayerEl.height / result.sampleHeight;
  debugCtx.fillStyle = "rgba(34, 197, 94, 0.9)";
  for (const p of result.points) {
    debugCtx.fillRect(p.x * scaleX, p.y * scaleY, 2, 2);
  }
}

function tick() {
  const result = estimateGroundPresence();
  if (!result) {
    resultEl.textContent = "地面推定: 評価中";
    metricsEl.textContent = "coverage: - / edge: - / roi: -";
    clearDebugLayer();
  } else {
    resultEl.textContent = `地面推定: ${result.detected ? "OK" : "未検出"}`;
    metricsEl.textContent =
      `coverage: ${result.coverage.toFixed(3)} / edge: ${result.edgeStrength.toFixed(3)} / roi: ${(result.roiStart * 100).toFixed(1)}%-${(result.roiEnd * 100).toFixed(1)}%`;
    drawCandidatePoints(result);
  }
  rafId = requestAnimationFrame(tick);
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
    videoPreviewEl.srcObject = cameraStream;
    await videoPreviewEl.play();
    updateDebugLayerSize();
    cameraStatusEl.textContent = "カメラ入力中";
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  } catch (error) {
    cameraStatusEl.textContent = `カメラ開始失敗: ${error?.message ?? String(error)}`;
  }
}

function stopCamera() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  videoPreviewEl.pause();
  videoPreviewEl.srcObject = null;
  cameraStatusEl.textContent = "カメラ停止";
  resultEl.textContent = "地面推定: 停止中";
  metricsEl.textContent = "coverage: - / edge: - / roi: -";
  clearDebugLayer();
}

coverageThresholdEl.addEventListener("input", updateThresholdLabels);
edgeThresholdEl.addEventListener("input", updateThresholdLabels);
showCandidatesEl.addEventListener("change", () => {
  if (!showCandidatesEl.checked) clearDebugLayer();
});
startBtnEl.addEventListener("click", startCamera);
stopBtnEl.addEventListener("click", stopCamera);

updateThresholdLabels();
updateRoiOverlay();
