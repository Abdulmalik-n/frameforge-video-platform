const $ = id => document.getElementById(id);

const fileInput = $("fileInput");
const dropZone = $("dropZone");
const fileCard = $("fileCard");
const fileName = $("fileName");
const fileSize = $("fileSize");
const removeFile = $("removeFile");
const processBtn = $("processBtn");
const processing = $("processing");
const processingTitle = $("processingTitle");
const processingText = $("processingText");
const errorBox = $("errorBox");
const modeNotice = $("modeNotice");
const result = $("result");

let selectedFile = null;
let currentMode = "preserve";
let currentResult = null;

function bytes(n) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 2 : 0)} ${u[i]}`;
}

function updateMode(mode) {
  currentMode = mode;
  document.querySelectorAll(".modeCard").forEach(card => {
    card.classList.toggle("active", card.dataset.mode === mode);
  });

  if (mode === "preserve") {
    modeNotice.textContent =
      "Preserve Master keeps the encoded video stream identical. The MP4 container may change.";
    processBtn.textContent = "PRESERVE & VERIFY";
  } else {
    modeNotice.textContent =
      "120 FPS Creator generates synthetic intermediate frames and re-encodes the video at very high quality. It cannot remain bit-for-bit identical.";
    processBtn.textContent = "CREATE 120 FPS VERSION";
  }
}

document.querySelectorAll('input[name="mode"]').forEach(input => {
  input.addEventListener("change", () => updateMode(input.value));
});

function choose(file) {
  if (!file) return;
  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = bytes(file.size);
  fileCard.classList.remove("hidden");
  processBtn.classList.remove("hidden");
  result.classList.add("hidden");
  errorBox.classList.add("hidden");
}

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => choose(fileInput.files[0]));

["dragover", "dragenter"].forEach(name => {
  dropZone.addEventListener(name, e => {
    e.preventDefault();
    dropZone.classList.add("drag");
  });
});
["dragleave", "drop"].forEach(name => {
  dropZone.addEventListener(name, e => {
    e.preventDefault();
    dropZone.classList.remove("drag");
  });
});
dropZone.addEventListener("drop", e => choose(e.dataTransfer.files[0]));

removeFile.addEventListener("click", () => {
  selectedFile = null;
  fileInput.value = "";
  fileCard.classList.add("hidden");
  processBtn.classList.add("hidden");
  result.classList.add("hidden");
});

async function loadHealth() {
  try {
    const r = await fetch("/api/health");
    const data = await r.json();
    if (data.maxUploadGB) $("maxUpload").textContent = `${data.maxUploadGB} GB`;
  } catch {}
}
loadHealth();

$("form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!selectedFile) return;

  result.classList.add("hidden");
  errorBox.classList.add("hidden");
  processing.classList.remove("hidden");
  processBtn.disabled = true;

  if (currentMode === "preserve") {
    processingTitle.textContent = "Preserving master…";
    processingText.textContent = "Uploading, losslessly remuxing and SHA-256 verifying the encoded video stream.";
  } else {
    processingTitle.textContent = "Creating 120 FPS video…";
    processingText.textContent = "Motion interpolation is CPU-heavy, especially at 4K. This may take much longer than the video duration.";
  }

  const body = new FormData();
  body.append("video", selectedFile);
  body.append("mode", currentMode);

  try {
    const response = await fetch("/api/process", { method: "POST", body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "Processing failed.");

    currentResult = data;
    renderResult(data);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove("hidden");
  } finally {
    processing.classList.add("hidden");
    processBtn.disabled = false;
  }
});

function renderResult(data) {
  $("resultTitle").textContent = data.mode === "preserve"
    ? "Bit-exact video stream verified"
    : "120 FPS version created";

  $("verifiedBadge").textContent = data.mode === "preserve"
    ? "✓ STREAM VERIFIED"
    : "✓ OUTPUT CREATED";

  const v = data.after.video;
  $("statRes").textContent = `${v.width} × ${v.height}`;
  $("statFps").textContent = `${Number(v.fps || 0).toFixed(2)} FPS`;
  $("statCodec").textContent = String(v.codec || "unknown").toUpperCase();
  $("statMode").textContent = data.mode === "preserve" ? "PRESERVE" : "120 FPS";
  $("fileHash").textContent = data.verification.storedFileSha256;

  if (data.mode === "preserve") {
    $("losslessProof").innerHTML =
      `<strong>✓ Encoded video stream SHA-256 matches before and after.</strong>
       <span>FrameForge did not re-encode the source video frames.</span>`;
  } else {
    $("losslessProof").innerHTML =
      `<strong>120 FPS interpolation completed.</strong>
       <span>The additional frames are synthetic motion-interpolated frames. The video was re-encoded, so this mode is not bit-exact.</span>`;
  }

  $("watchLink").href = data.watchUrl;
  $("downloadLink").href = data.downloadUrl;
  result.classList.remove("hidden");
  result.scrollIntoView({ behavior: "smooth", block: "start" });
}

$("copyLink").addEventListener("click", async () => {
  if (!currentResult) return;
  await navigator.clipboard.writeText(currentResult.watchUrl);
  const btn = $("copyLink");
  const old = btn.textContent;
  btn.textContent = "COPIED";
  setTimeout(() => btn.textContent = old, 1300);
});

updateMode("preserve");
