const startBtnEl = document.getElementById("startBtn");
const stopBtnEl = document.getElementById("stopBtn");
const cameraStatusEl = document.getElementById("cameraStatus");
const videoPreviewEl = document.getElementById("videoPreview");
const roiOverlayEl = document.getElementById("roiOverlay");
const resultEl = document.getElementById("result");
const metricsEl = document.getElementById("metrics");
const coverageThresholdEl = document.getElementById("coverageThreshold");
const edgeThresholdEl = document.getElementById("edgeThreshold");
const coverageThresholdTextEl = document.getElementById("coverageThresholdText");
const edgeThresholdTextEl = document.getElementById("edgeThresholdText");

let cameraStream = null;
let rafId = null;

const detectCanvas = document.createElement("canvas");
const detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true });

function updateThresholdLabels() {
  coverageThresholdTextEl.textContent = `coverage閾値: ${Number(coverageThresholdEl.value).toFixed(2)}`;
  edgeThresholdTextEl.textContent = `edge閾値: ${Number(edgeThresholdEl.value).toFixed(1)}`;
}

function updateRoiOverlay() {
  // analyze region: y in [68%, 96%]
  roiOverlayEl.style.left = "0%";
  roiOverlayEl.style.width = "100%";
  roiOverlayEl.style.top = "68%";
  roiOverlayEl.style.height = "28%";
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

  const yStart = Math.floor(targetHeight * 0.68);
  const yEnd = Math.floor(targetHeight * 0.96);
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
    coverage >= Number(coverageThresholdEl.value) &&
    edgeStrength >= Number(edgeThresholdEl.value);
  return { detected, coverage, edgeStrength };
}

function tick() {
  const result = estimateGroundPresence();
  if (!result) {
    resultEl.textContent = "地面推定: 評価中";
    metricsEl.textContent = "coverage: - / edge: -";
  } else {
    resultEl.textContent = `地面推定: ${result.detected ? "OK" : "未検出"}`;
    metricsEl.textContent =
      `coverage: ${result.coverage.toFixed(3)} / edge: ${result.edgeStrength.toFixed(3)}`;
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
  metricsEl.textContent = "coverage: - / edge: -";
}

coverageThresholdEl.addEventListener("input", updateThresholdLabels);
edgeThresholdEl.addEventListener("input", updateThresholdLabels);
startBtnEl.addEventListener("click", startCamera);
stopBtnEl.addEventListener("click", stopCamera);

updateThresholdLabels();
updateRoiOverlay();
