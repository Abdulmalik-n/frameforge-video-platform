(async function () {
  const id = location.pathname.split("/").filter(Boolean).pop();
  const response = await fetch(`/api/item/${encodeURIComponent(id)}`);
  if (!response.ok) {
    document.body.innerHTML = "<main style='padding:40px;color:white'>Video not found or expired.</main>";
    return;
  }
  const data = await response.json();
  const v = data.after.video;

  document.title = `${data.originalName} — FrameForge`;
  document.getElementById("title").textContent = data.originalName;
  document.getElementById("detail").textContent =
    `${v.width}×${v.height} · ${Number(v.fps || 0).toFixed(2)} FPS · ${String(v.codec || "").toUpperCase()} · ${data.mode === "preserve" ? "preserved stream" : "interpolated 120 FPS"}`;
  document.getElementById("player").src = `/media/${id}`;
  document.getElementById("download").href = `/download/${id}`;
  document.getElementById("hash").textContent =
    `Stored file SHA-256: ${data.verification.storedFileSha256}`;
})();
