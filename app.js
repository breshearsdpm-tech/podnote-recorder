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

  // Safari can lose access to a Blob saved in IndexedDB (after the app is reloaded or
  // sits in the background), so the audio is saved as plain bytes (ArrayBuffer) instead.
  // Older recordings still hold a Blob; audioBlob() reads it and keeps the bytes.
  const audioSize = (r) => (r.audio ? r.audio.byteLength : r.blob ? r.blob.size : 0);
  async function audioBlob(rec) {
    if (rec.audio) return new Blob([rec.audio], { type: rec.mime });
    if (!rec.blob) throw new Error("This recording has no audio saved");
    let buf;
    try {
      buf = await rec.blob.arrayBuffer();
    } catch (e) {
      throw new Error("Safari can't read this recording's audio any more (" + (e.message || e.name) + ")");
    }
    if (!buf.byteLength) throw new Error("This recording's audio is empty");
    rec.audio = buf;
    delete rec.blob;
    await putRec(rec);
    return new Blob([buf], { type: rec.mime });
  }

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
  // "Hold": stop for now, see another patient, then continue the same visit later.
  // resumeRec = the held visit being continued; saveMode = "hold" when Hold was tapped.
  let resumeRec = null, saveMode = "save", heldRecs = [];

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

  const heldFor = (name) => heldRecs.find((r) => r.meta.patient.trim().toLowerCase() === name.trim().toLowerCase());

  async function startRecording(arg) {
    if (mediaRecorder) return;
    let held = arg && arg.parts ? arg : null;
    if (!held) held = heldFor($("patient").value) || null;   // Record on a held patient = continue it
    if (held) {
      $("patient").value = held.meta.patient;
      $("visitType").value = held.meta.visit_type;
      $("dos").value = held.meta.date_of_service;
      if (!$("quickNotes").value.trim()) $("quickNotes").value = held.meta.quick_notes || "";
      $("consent").checked = true;
    }
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
    resumeRec = held;
    saveMode = "save";
    elapsedBefore = held ? held.seconds : 0;
    if (held) toast(`Continuing ${held.meta.patient}'s recording.`);

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

  // Google access lasts about an hour, and Safari only lets PodNote renew it during a tap.
  // So taps on Stop and on a patient renew it when it is close to running out; the
  // recording then uploads by itself instead of waiting on the iPad as "Not uploaded".
  function renewSignInDuringTap() {
    if (useDirect() && tokenClient && !(token && Date.now() < tokenExpires - 10 * 60000)) {
      getToken(10 * 60000).catch((e) => toast(e.message, 6000));
    }
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === "inactive") return;
    renewSignInDuringTap();
    saveMode = "save";
    elapsedBefore = elapsed();
    mediaRecorder.stop();
  }

  // Hold: keep what was recorded on the iPad (not uploaded) and free the recorder for
  // the next patient. Tapping Resume (or the patient again, then Record) continues it.
  function holdRecording() {
    if (!mediaRecorder || mediaRecorder.state === "inactive") return;
    saveMode = "hold";
    elapsedBefore = elapsed();
    mediaRecorder.stop();
  }

  // Join the parts of a held visit into one WAV file (16 kHz mono, plenty for speech).
  async function mergeToWav(parts) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const OCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx();
    let rate = 16000;
    const pcm = [];
    try {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const bytes = p.audio ? p.audio.slice(0) : await p.blob.arrayBuffer();
        const buf = await new Promise((res, rej) => {
          const r = ctx.decodeAudioData(bytes, res, rej);
          if (r && r.then) r.then(res, rej);
        });
        let off;
        try { off = new OCtx(1, Math.max(1, Math.ceil(buf.duration * rate)), rate); }
        catch (_) { rate = 22050; off = new OCtx(1, Math.max(1, Math.ceil(buf.duration * rate)), rate); }
        const src = off.createBufferSource();
        src.buffer = buf;
        src.connect(off.destination);
        src.start(0);
        const out = await new Promise((res, rej) => {
          off.oncomplete = (e) => res(e.renderedBuffer);
          const r = off.startRendering();
          if (r && r.then) r.then(res, rej);
        });
        if (i) pcm.push(new Float32Array(Math.round(rate * 0.7)));  // short gap between parts
        pcm.push(out.getChannelData(0).slice());
      }
    } finally {
      try { ctx.close(); } catch (_) {}
    }
    const n = pcm.reduce((s, a) => s + a.length, 0);
    const wav = new ArrayBuffer(44 + n * 2), v = new DataView(wav);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
    let o = 44;
    for (const a of pcm) for (let i = 0; i < a.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, a[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return wav;
  }

  // Turn a visit's parts into the recording that gets uploaded (one part: as recorded;
  // several: joined into one WAV). Returns the saved recording.
  async function finishVisit(id, parts, meta, seconds, createdAt) {
    let rec;
    if (parts.length === 1) {
      const p = parts[0];
      rec = { mime: p.mime, fileName: `${id}.${extFor(p.mime)}`, ...(p.audio ? { audio: p.audio } : { blob: p.blob }) };
    } else {
      try {
        rec = { mime: "audio/wav", fileName: `${id}.wav`, audio: await mergeToWav(parts) };
      } catch (e) {
        // Couldn't join: keep it on hold so nothing is lost, and say why.
        const held = { id, createdAt, fileName: "", mime: parts[0].mime, seconds, status: "held",
          error: "Couldn't join the parts (" + (e.message || e.name) + ")", meta, parts };
        await putRec(held);
        toast(held.error, 8000);
        return held;
      }
    }
    Object.assign(rec, { id, createdAt, seconds, status: "pending", error: "",
      meta: { ...meta, duration_seconds: seconds, parts: parts.length } });
    await putRec(rec);
    return rec;
  }

  async function saveRecording() {
    clearInterval(tickTimer);
    cancelAnimationFrame(rafId);
    stream.getTracks().forEach((t) => t.stop());
    if (audioCtx) audioCtx.close();
    if (wakeLock) { try { await wakeLock.release(); } catch (_) {} wakeLock = null; }

    const mime = mediaRecorder.mimeType || (chunks[0] && chunks[0].type) || "audio/mp4";
    const blob = new Blob(chunks, { type: mime });
    let audio = null;
    try { audio = await blob.arrayBuffer(); } catch (_) {}
    const now = new Date();
    const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const dos = $("dos").value || todayISO();
    const prev = resumeRec;
    const base = prev ? prev.id : `${dos}_${stamp}__${slug($("patient").value)}__${slug($("visitType").value)}`;
    const createdAt = prev ? prev.createdAt : now.toISOString();
    const seconds = Math.round(elapsedBefore);
    const parts = [...(prev ? prev.parts : []), audio ? { audio, mime } : { blob, mime }];
    const meta = {
      patient: $("patient").value.trim(),
      visit_type: $("visitType").value,
      date_of_service: dos,
      quick_notes: $("quickNotes").value.trim(),
      consent: $("consent").checked,
      recorded_at: createdAt,
      duration_seconds: seconds,
      app: "PodNote iPad 1.1"
    };
    const hold = saveMode === "hold";
    let rec;
    try {
      if (hold) {
        rec = { id: base, createdAt, fileName: "", mime, seconds, status: "held", error: "", meta, parts };
        await putRec(rec);
      } else {
        rec = await finishVisit(base, parts, meta, seconds, createdAt);
      }
    } catch (e) {
      toast("Could not save on iPad: " + e.message, 8000);
    }
    mediaRecorder = null;
    resumeRec = null;
    saveMode = "save";
    setUI("idle");
    $("timer").textContent = "00:00";
    // reset per-visit fields, keep date & visit type
    $("patient").value = "";
    $("quickNotes").value = "";
    $("consent").checked = true; // you only open PodNote for patients who signed the AI waiver
    await renderQueue();
    renderSchedule();
    if (!rec) return;
    if (rec.status === "held") {
      if (hold) toast(`${meta.patient} is on hold (${fmtTime(seconds)}). Tap Resume on it when you go back.`, 6000);
      return;
    }
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
    $("btnHold").disabled = state === "idle";
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

  // Safari blocks the Google sign-in popup unless it opens synchronously inside the tap.
  // So the sign-in library and token client are prepared at page load, and getToken()
  // calls requestAccessToken() without any await in between.
  let pendingToken = null;
  function prepareTokenClient() {
    if (!useDirect()) return Promise.resolve();
    return loadGIS().then(() => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CFG.googleClientId,
        // drive.file: upload recordings. drive.readonly: read the checked-in list
        // that Chart Prep writes to My Drive/PodNote/Schedule on the office PC.
        scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly",
        callback: (resp) => {
          const p = pendingToken; pendingToken = null;
          if (resp.error) return p && p.reject(new Error(resp.error_description || resp.error));
          token = resp.access_token;
          tokenExpires = Date.now() + (resp.expires_in || 3600) * 1000;
          $("driveStatus").textContent = "Drive: connected";
          $("driveStatus").classList.add("on");
          $("btnSched").textContent = "Refresh";
          if (p) p.resolve(token);
          setTimeout(loadSchedule, 0);
          setTimeout(uploadPending, 0);
        },
        error_callback: (err) => {
          const p = pendingToken; pendingToken = null;
          if (p) p.reject(new Error(err.type === "popup_failed_to_open"
            ? "Safari blocked the Google sign-in window. Allow pop-ups for this site, then tap Connect again."
            : (err.message || err.type || "Sign-in cancelled")));
        }
      });
    });
  }
  const tokenClientReady = prepareTokenClient().catch(() => {});

  // minLeftMs: get a fresh token if the current one runs out sooner than this.
  function getToken(minLeftMs = 60000) {
    if (token && Date.now() < tokenExpires - minLeftMs) return Promise.resolve(token);
    if (!tokenClient) {
      return tokenClientReady.then(() => {
        throw new Error(tokenClient ? "Google sign-in is ready. Tap Connect again." : "Could not load Google sign-in (offline?)");
      });
    }
    return new Promise((resolve, reject) => {
      pendingToken = { resolve, reject };
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

  // ---------- checked-in patients (from Chart Prep via Drive) ----------
  let schedule = [], schedTimer = null;
  const tokenValid = () => token && Date.now() < tokenExpires - 60000;

  async function loadSchedule() {
    if (!useDirect()) {
      $("schedNote").textContent = "Add the Google sign-in Client ID in config.js to see checked-in patients here.";
      return;
    }
    if (!tokenValid()) {
      $("btnSched").textContent = "Connect Google";
      $("schedNote").textContent = "Tap Connect Google (once each time you open PodNote) to load today's checked-in patients.";
      return;
    }
    try {
      const q = encodeURIComponent("name='checked_in.json' and trashed=false");
      const list = await (await gfetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=1&fields=files(id,modifiedTime)`
      )).json();
      if (!list.files || !list.files.length) {
        schedule = [];
        $("schedNote").textContent = "No check-ins yet today. Chart Prep adds patients as they're roomed.";
      } else {
        const data = await (await gfetch(`https://www.googleapis.com/drive/v3/files/${list.files[0].id}?alt=media`)).json();
        const all = data.date === todayISO() ? data.patients || [] : [];
        // Hide patients whose note is already in ModMed (the push bot moves it to PodNote/Signed).
        let pushed = new Set();
        try { pushed = await loadPushed(); } catch (_) {}
        schedule = all.filter((p) => !pushed.has(slug(p.name).toLowerCase()));
        const hidden = all.length - schedule.length;
        const t = new Date(data.updated || list.files[0].modifiedTime);
        $("schedNote").textContent = (schedule.length
          ? `Updated ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Tap a patient, then Record.`
          : "No patients waiting.") + (hidden ? ` ${hidden} with notes already in ModMed are hidden.` : "");
      }
    } catch (e) {
      $("schedNote").textContent = "Couldn't load the checked-in list: " + e.message;
    }
    renderSchedule();
  }

  // Today's notes in My Drive/PodNote/Signed, as lowercase name slugs ("leon-luna").
  let signedFolderId = null;
  async function loadPushed() {
    if (!signedFolderId) {
      const fq = (n) => encodeURIComponent(`name='${n}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
      const podnote = (await (await gfetch(`https://www.googleapis.com/drive/v3/files?q=${fq("PodNote")}&fields=files(id)`)).json()).files || [];
      const signed = (await (await gfetch(`https://www.googleapis.com/drive/v3/files?q=${fq("Signed")}&fields=files(id,parents)`)).json()).files || [];
      const ids = new Set(podnote.map((f) => f.id));
      const hit = signed.find((f) => (f.parents || []).some((p) => ids.has(p)));
      if (!hit) return new Set();
      signedFolderId = hit.id;
    }
    const q = encodeURIComponent(`'${signedFolderId}' in parents and trashed=false`);
    const files = (await (await gfetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=300&fields=files(name)`
    )).json()).files || [];
    const today = todayISO() + "__";
    return new Set(files.filter((f) => f.name.startsWith(today)).map((f) => (f.name.split("__")[1] || "").toLowerCase()));
  }

  async function renderSchedule() {
    const todays = (await allRecs()).filter((r) => r.meta.date_of_service === todayISO());
    const done = new Set(todays.filter((r) => r.status !== "held").map((r) => r.meta.patient));
    const onHold = new Set(todays.filter((r) => r.status === "held").map((r) => r.meta.patient));
    const box = $("schedList");
    box.innerHTML = "";
    for (const p of schedule) {
      const b = document.createElement("button");
      b.className = "chip" + (done.has(p.name) ? " done" : "") + ($("patient").value === p.name ? " selected" : "");
      b.innerHTML = `<span></span>${p.new_patient ? '<span class="badge">NEW</span>' : ""}<small></small>`;
      b.querySelector("span").textContent = p.name;
      b.querySelector("small").textContent =
        [p.room, onHold.has(p.name) ? "on hold" : done.has(p.name) ? "recorded" : ""].filter(Boolean).join(" · ");
      b.onclick = () => {
        if (mediaRecorder) return;
        renewSignInDuringTap();
        $("patient").value = p.name;
        $("visitType").value = p.new_patient ? "New patient" : "Follow-up";
        $("consent").checked = true;
        renderSchedule();
        $("btnRecord").scrollIntoView({ behavior: "smooth", block: "center" });
      };
      box.appendChild(b);
    }
  }

  $("btnSched").onclick = () => {
    if (useDirect() && !tokenValid()) getToken().catch((e) => toast(e.message, 6000));
    else loadSchedule();
  };
  schedTimer = setInterval(() => {
    if (!mediaRecorder && tokenValid()) loadSchedule();
    // Show when Google access has run out, so it's obvious uploads need a tap.
    if (useDirect() && token && !tokenValid()) {
      $("driveStatus").textContent = "Drive: tap to reconnect";
      $("driveStatus").classList.remove("on");
      $("btnSched").textContent = "Connect Google";
    }
  }, 60000);

  // ---------- Share sheet fallback ----------
  async function shareUpload(rec) {
    const file = new File([await audioBlob(rec)], rec.fileName, { type: rec.mime });
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
  async function uploadPending() {
    if (!tokenValid()) return;
    for (const r of await allRecs()) if ((r.status === "pending" || r.status === "error") && !r.parts) await uploadOne(r.id);
  }

  async function uploadOne(id) {
    if (busy.has(id)) return;
    busy.add(id);
    // Start Google sign-in before any await so Safari treats the popup as part of the tap.
    const signIn = useDirect() && !tokenValid() ? getToken() : null;
    if (signIn) signIn.catch(() => {});
    const rec = (await allRecs()).find((r) => r.id === id);
    if (!rec || rec.status === "uploaded" || rec.status === "held") { busy.delete(id); return; }
    rec.status = "uploading"; rec.error = "";
    await putRec(rec); renderQueue();
    try {
      if (useDirect()) {
        // Read the audio first: if Safari can't read it, send nothing (no lone info file).
        const body = await audioBlob(rec);
        if (signIn) await signIn;
        const parent = await ensureFolder();
        // sidecar first so the PC always finds it when the audio arrives
        await driveUpload(rec.id + ".json", "application/json", JSON.stringify(rec.meta, null, 2), parent);
        await driveUpload(rec.fileName, rec.mime, body, parent);
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
    heldRecs = recs.filter((r) => r.status === "held");
    $("emptyQueue").hidden = recs.length > 0;
    const waiting = recs.filter((r) => r.status !== "uploaded" && r.status !== "held").length;
    $("btnUploadAll").textContent = waiting ? `Upload all (${waiting})` : "Upload all";
    // On-hold visits first, so they're easy to find when you go back to the patient.
    recs.sort((a, b) => (b.status === "held") - (a.status === "held"));
    for (const r of recs) {
      const li = document.createElement("li");
      const label = { pending: "Not uploaded", uploading: "Uploading…", uploaded: "Uploaded", error: "Failed",
        held: "On hold – tap Resume to continue" }[r.status] || r.status;
      if (r.status === "held") {
        li.innerHTML = `<div><div class="who"></div><div class="meta"></div><div class="status pending"></div></div>
          <div class="actions"></div>`;
        li.querySelector(".who").textContent = r.meta.patient;
        li.querySelector(".meta").textContent =
          `${r.meta.visit_type} · ${r.meta.date_of_service} · ${fmtTime(r.seconds)} so far · ${r.parts.length} part${r.parts.length > 1 ? "s" : ""}`;
        li.querySelector(".status").textContent = label + (r.error ? ` – ${r.error}` : "");
        const actions = li.querySelector(".actions");
        const res = document.createElement("button");
        res.className = "small-btn primary";
        res.textContent = "Resume";
        res.disabled = !!mediaRecorder;
        res.onclick = () => startRecording(r);
        const fin = document.createElement("button");
        fin.className = "small-btn";
        fin.textContent = "Finish";
        fin.disabled = !!mediaRecorder;
        fin.onclick = async () => {
          renewSignInDuringTap();
          const saved = await finishVisit(r.id, r.parts, r.meta, r.seconds, r.createdAt);
          await renderQueue();
          renderSchedule();
          if (saved.status === "pending") {
            if (tokenValid()) uploadOne(saved.id);
            else toast(`Saved ${r.meta.patient}. Tap ${useDirect() ? "Upload" : "Share to Drive"} to send it.`, 5000);
          }
        };
        const del = document.createElement("button");
        del.className = "small-btn";
        del.textContent = "Delete";
        del.onclick = async () => {
          if (confirm("This visit is on hold and NOT uploaded. Delete it permanently?")) { await delRec(r.id); renderQueue(); renderSchedule(); }
        };
        actions.append(res, fin, del);
        ul.appendChild(li);
        continue;
      }
      li.innerHTML = `
        <div>
          <div class="who"></div>
          <div class="meta"></div>
          <div class="status ${r.status === "uploading" ? "pending" : r.status}"></div>
        </div>
        <div class="actions"></div>`;
      li.querySelector(".who").textContent = r.meta.patient;
      li.querySelector(".meta").textContent =
        `${r.meta.visit_type} · ${r.meta.date_of_service} · ${fmtTime(r.seconds)} · ${(audioSize(r) / 1048576).toFixed(1)} MB`;
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
      play.onclick = async () => {
        try { new Audio(URL.createObjectURL(await audioBlob(r))).play(); }
        catch (e) { toast(e.message, 8000); }
      };
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
  $("btnHold").onclick = holdRecording;
  $("btnUploadAll").onclick = async () => {
    const recs = await allRecs();
    for (const r of recs) if (r.status !== "uploaded" && r.status !== "held") await uploadOne(r.id);
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
    // Start each day clean: recordings from earlier days that are safely uploaded are
    // removed. Anything NOT uploaded stays, so no visit is ever lost.
    const today = todayISO();
    for (const r of recs) {
      const day = (r.meta && r.meta.date_of_service) || (r.createdAt || "").slice(0, 10);
      if (r.status === "uploaded" && day < today) await delRec(r.id);
    }
    recs = await allRecs();
    for (const r of recs) if (r.status === "uploading") { r.status = "pending"; await putRec(r); }
    // Convert older recordings to plain bytes right away, while Safari can still read them.
    for (const r of recs) {
      if (r.status !== "uploaded" && r.blob && !r.audio) {
        try { await audioBlob(r); }
        catch (e) { r.status = "error"; r.error = e.message; await putRec(r); }
      }
    }
    renderQueue();
    loadSchedule();
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  setUI("idle");
})();
