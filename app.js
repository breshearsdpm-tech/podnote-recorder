/* PodNote iPad recorder
 * Records the visit, keeps every recording in IndexedDB on the iPad until it is
 * safely uploaded, then sends it to Google Drive (direct upload or Share sheet).
 */
(() => {
  "use strict";
  const CFG = window.PODNOTE_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  // ---------- small helpers ----------
  const pad = (n) => String(n).padStart(2, "0");
  const fmtTime = (s) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const safe = (s) => (s || "").trim().replace(/[^A-Za-z0-9 ,.'-]/g, "").replace(/\s+/g, " ").slice(0, 60);
  const slug = (s) => safe(s).replace(/[ ,.']+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "Unknown";
  let toastTimer;
  function toast(msg, ms = 3500) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  // ---------- IndexedDB queue ----------
  const DB_NAME = "podnote", STORE = "recordings";
  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    });
  }
  const putRec = (r) => tx("readwrite", (s) => s.put(r));
  const delRec = (id) => tx("readwrite", (s) => s.delete(id));
  const allRecs = () => tx("readonly", (s) => s.getAll());

  // ---------- form setup ----------
  (CFG.visitTypes || ["Follow-up"]).forEach((v) => {
    const o = document.createElement("option");
    o.textContent = v;
    $("visitType").appendChild(o);
  });
  $("dos").value = todayISO();

  // ---------- recording ----------
  let mediaRecorder = null, stream = null, chunks = [], startedAt = 0, elapsedBefore = 0;
  let tickTimer = null, audioCtx = null, analyser = null, rafId = null, wakeLock = null;

  function pickMime() {
    const options = ["audio/mp4", "audio/mp4;codecs=mp4a.40.2", "audio/webm;codecs=opus", "audio/webm"];
    for (const m of options) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    return "";
  }
  const extFor = (mime) => (mime.includes("mp4") ? "m4a" : mime.includes("webm") ? "webm" : "audio");

  function elapsed() {
    return elapsedBefore + (mediaRecorder && mediaRecorder.state === "recording" ? (Date.now() - startedAt) / 1000 : 0);
  }

  function drawMeter() {
    const c = $("meter"), g = c.getContext("2d");
    const data = new Uint8Array(analyser.fftSize);
    const color = getComputedStyle(document.documentElement).getPropertyValue("--brand").trim() || "#0f5c63";
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      g.clearRect(0, 0, c.width, c.height);
      g.lineWidth = 3;
      g.strokeStyle = color;
      g.beginPath();
      const step = c.width / data.length;
      for (let i = 0; i < data.length; i++) {
        const y = (data[i] / 255) * c.height;
        i ? g.lineTo(i * step, y) : g.moveTo(0, y);
      }
      g.stroke();
      rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  async function requestWakeLock() {
    try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (_) { /* optional */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && mediaRecorder && mediaRecorder.state !== "inactive") requestWakeLock();
  });

  async function startRecording() {
    if (!$("patient").value.trim()) { toast("Enter the patient name or MRN first."); $("patient").focus(); return; }
    if (!$("consent").checked) { toast("Confirm the patient consented to recording."); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
    } catch (e) {
      toast("Microphone blocked. Allow it in Settings › Safari › Microphone.", 6000);
      return;
    }
    const mime = pickMime();
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
    chunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = saveRecording;
    mediaRecorder.start(5000); // flush a chunk every 5s so little is lost if something goes wrong
    startedAt = Date.now();
    elapsedBefore = 0;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    drawMeter();
    requestWakeLock();

    tickTimer = setInterval(() => ($("timer").textContent = fmtTime(elapsed())), 250);
    setUI("recording");
  }

  function togglePause() {
    if (!mediaRecorder) return;
    if (mediaRecorder.state === "recording") {
      elapsedBefore = elapsed();
      mediaRecorder.pause();
      setUI("paused");
    } else if (mediaRecorder.state === "paused") {
      startedAt = Date.now();
      mediaRecorder.resume();
      setUI("recording");
    }
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === "inactive") return;
    elapsedBefore = elapsed();
    mediaRecorder.stop();
  }

  async function saveRecording() {
    clearInterval(tickTimer);
    cancelAnimationFrame(rafId);
    stream.getTracks().forEach((t) => t.stop());
    if (audioCtx) audioCtx.close();
    if (wakeLock) { try { await wakeLock.release(); } catch (_) {} wakeLock = null; }

    const mime = mediaRecorder.mimeType || (chunks[0] && chunks[0].type) || "audio/mp4";
    const blob = new Blob(chunks, { type: mime });
    const now = new Date();
    const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const dos = $("dos").value || todayISO();
    const base = `${dos}_${stamp}__${slug($("patient").value)}__${slug($("visitType").value)}`;
    const rec = {
      id: base,
      createdAt: now.toISOString(),
      fileName: `${base}.${extFor(mime)}`,
      mime,
      seconds: Math.round(elapsedBefore),
      status: "pending",
      error: "",
      meta: {
        patient: $("patient").value.trim(),
        visit_type: $("visitType").value,
        date_of_service: dos,
        quick_notes: $("quickNotes").value.trim(),
        consent: $("consent").checked,
        recorded_at: now.toISOString(),
        duration_seconds: Math.round(elapsedBefore),
        app: "PodNote iPad 1.0"
      },
      blob
    };
    try {
      await putRec(rec);
    } catch (e) {
      toast("Could not save on iPad: " + e.message, 8000);
    }
    mediaRecorder = null;
    setUI("idle");
    $("timer").textContent = "00:00";
    // reset per-visit fields, keep date & visit type
    $("patient").value = "";
    $("quickNotes").value = "";
    $("consent").checked = true; // you only open PodNote for patients who signed the AI waiver
    await renderQueue();
    // Google sign-in and the Share sheet both need a tap, so only auto-upload when
    // we already hold a valid Drive token.
    if (useDirect() && token && Date.now() < tokenExpires - 60000) {
      toast(`Saved ${fmtTime(rec.seconds)} recording. Uploading…`);
      uploadOne(rec.id);
    } else {
      toast(`Saved ${fmtTime(rec.seconds)} recording on iPad. Tap ${useDirect() ? "Upload" : "Share to Drive"} to send it.`, 5000);
    }
  }

  function setUI(state) {
    const rec = $("btnRecord"), pause = $("btnPause"), stop = $("btnStop");
    rec.disabled = state !== "idle";
    rec.classList.toggle("recording", state === "recording");
    pause.disabled = state === "idle";
    stop.disabled = state === "idle";
    pause.textContent = state === "paused" ? "Resume" : "Pause";
    $("recState").textContent = { idle: "Ready", recording: "Recording…", paused: "Paused" }[state];
    ["patient", "visitType", "dos", "consent"].forEach((id) => ($(id).disabled = state !== "idle"));
  }

  // ---------- Google Drive (direct upload) ----------
  let token = null, tokenExpires = 0, tokenClient = null, folderId = null;
  const useDirect = () => !!CFG.googleClientId;

  function loadGIS() {
    return new Promise((resolve, reject) => {
      if (window.google && google.accounts && google.accounts.oauth2) return resolve();
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load Google sign-in (offline?)"));
      document.head.appendChild(s);
    });
  }

  async function getToken() {
    if (token && Date.now() < tokenExpires - 60000) return token;
    await loadGIS();
    return new Promise((resolve, reject) => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CFG.googleClientId,
        scope: "https://www.googleapis.com/auth/drive.file",
        callback: (resp) => {
          if (resp.error) return reject(new Error(resp.error));
          token = resp.access_token;
          tokenExpires = Date.now() + (resp.expires_in || 3600) * 1000;
          $("driveStatus").textContent = "Drive: connected";
          $("driveStatus").classList.add("on");
          resolve(token);
        },
        error_callback: (err) => reject(new Error(err.message || err.type || "Sign-in cancelled"))
      });
      tokenClient.requestAccessToken({ prompt: "" });
    });
  }

  async function gfetch(url, opts = {}) {
    const t = await getToken();
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } });
    if (res.status === 401) { token = null; throw new Error("Google session expired, tap Upload again"); }
    if (!res.ok) throw new Error(`Drive error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  async function ensureFolder() {
    if (folderId) return folderId;
    const name = CFG.driveFolderName || "PodNote-Inbox";
    const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const list = await (await gfetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`)).json();
    if (list.files && list.files.length) return (folderId = list.files[0].id);
    const created = await (await gfetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" })
    })).json();
    return (folderId = created.id);
  }

  async function driveUpload(name, mime, body, parent) {
    const init = await gfetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mime },
      body: JSON.stringify({ name, parents: [parent] })
    });
    const session = init.headers.get("Location");
    if (!session) throw new Error("Drive did not return an upload URL");
    const put = await fetch(session, { method: "PUT", headers: { "Content-Type": mime }, body });
    if (!put.ok) throw new Error(`Upload failed ${put.status}`);
    return put.json();
  }

  // ---------- Share sheet fallback ----------
  async function shareUpload(rec) {
    const file = new File([rec.blob], rec.fileName, { type: rec.mime });
    const meta = new File([JSON.stringify(rec.meta, null, 2)], rec.id + ".json", { type: "application/json" });
    const files = [meta, file];
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title: rec.fileName });
      return;
    }
    // last resort: download the audio file
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = rec.fileName;
    a.click();
  }

  // ---------- upload orchestration ----------
  const busy = new Set();
  async function uploadOne(id) {
    if (busy.has(id)) return;
    const rec = (await allRecs()).find((r) => r.id === id);
    if (!rec || rec.status === "uploaded") return;
    busy.add(id);
    rec.status = "uploading"; rec.error = "";
    await putRec(rec); renderQueue();
    try {
      if (useDirect()) {
        const parent = await ensureFolder();
        // sidecar first so the PC always finds it when the audio arrives
        await driveUpload(rec.id + ".json", "application/json", JSON.stringify(rec.meta, null, 2), parent);
        await driveUpload(rec.fileName, rec.mime, rec.blob, parent);
      } else {
        await shareUpload(rec);
      }
      rec.status = "uploaded";
      rec.uploadedAt = new Date().toISOString();
      toast(`Uploaded ${rec.meta.patient}`);
    } catch (e) {
      rec.status = "error";
      rec.error = e.message || String(e);
      if (!useDirect() && e.name === "AbortError") { rec.status = "pending"; rec.error = ""; }
    }
    busy.delete(id);
    await putRec(rec);
    renderQueue();
  }

  async function renderQueue() {
    const recs = (await allRecs()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const ul = $("queue");
    ul.innerHTML = "";
    $("emptyQueue").hidden = recs.length > 0;
    for (const r of recs) {
      const li = document.createElement("li");
      const label = { pending: "Not uploaded", uploading: "Uploading…", uploaded: "Uploaded", error: "Failed" }[r.status] || r.status;
      li.innerHTML = `
        <div>
          <div class="who"></div>
          <div class="meta"></div>
          <div class="status ${r.status === "uploading" ? "pending" : r.status}"></div>
        </div>
        <div class="actions"></div>`;
      li.querySelector(".who").textContent = r.meta.patient;
      li.querySelector(".meta").textContent =
        `${r.meta.visit_type} · ${r.meta.date_of_service} · ${fmtTime(r.seconds)} · ${(r.blob.size / 1048576).toFixed(1)} MB`;
      li.querySelector(".status").textContent = label + (r.error ? ` – ${r.error}` : "");
      const actions = li.querySelector(".actions");
      if (r.status !== "uploaded") {
        const b = document.createElement("button");
        b.className = "small-btn primary";
        b.textContent = useDirect() ? "Upload" : "Share to Drive";
        b.disabled = r.status === "uploading";
        b.onclick = () => uploadOne(r.id);
        actions.appendChild(b);
      }
      const play = document.createElement("button");
      play.className = "small-btn";
      play.textContent = "Play";
      play.onclick = () => { const a = new Audio(URL.createObjectURL(r.blob)); a.play(); };
      actions.appendChild(play);
      const del = document.createElement("button");
      del.className = "small-btn";
      del.textContent = "Delete";
      del.onclick = async () => {
        const warn = r.status === "uploaded" ? "Remove from this iPad?" : "This recording has NOT been uploaded. Delete it permanently?";
        if (confirm(warn)) { await delRec(r.id); renderQueue(); }
      };
      actions.appendChild(del);
      ul.appendChild(li);
    }
  }

  // ---------- wire up ----------
  $("btnRecord").onclick = startRecording;
  $("btnPause").onclick = togglePause;
  $("btnStop").onclick = stopRecording;
  $("btnUploadAll").onclick = async () => {
    const recs = await allRecs();
    for (const r of recs) if (r.status !== "uploaded") await uploadOne(r.id);
  };
  $("btnClearDone").onclick = async () => {
    for (const r of await allRecs()) if (r.status === "uploaded") await delRec(r.id);
    renderQueue();
  };
  window.addEventListener("beforeunload", (e) => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") { e.preventDefault(); e.returnValue = ""; }
  });
  if (!useDirect()) {
    $("driveStatus").textContent = "Drive: via Share sheet";
  } else {
    $("driveStatus").textContent = "Drive: tap to connect";
    $("driveStatus").style.cursor = "pointer";
    $("driveStatus").onclick = () => getToken().then(ensureFolder).catch((e) => toast(e.message, 6000));
  }

  // anything left "uploading" from a closed session goes back to pending
  allRecs().then(async (recs) => {
    for (const r of recs) if (r.status === "uploading") { r.status = "pending"; await putRec(r); }
    renderQueue();
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  setUI("idle");
})();
