// ==================== HELPER & TOAST ====================
const $ = (id) => document.getElementById(id);

function tampilToast(pesan, jenis = 'info') {
  const toast = document.createElement('div');
  toast.className = 'toast ' + jenis;
  toast.innerHTML = '<i class="fa-solid fa-circle-info"></i><span></span>';
  toast.querySelector('span').textContent = pesan;
  $('toast-container').appendChild(toast);
  setTimeout(() => {
    toast.classList.add('keluar');
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

// Hash sederhana untuk menyamakan sandi antara Monitor dan perintah ke Edge
function simpleHash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// ==================== STATE PERAN TERKUNCI & SANDI MASTER ====================
const ROLE_STORAGE_KEY = "sts_locked_role_v2";
const MONITOR_CFG_KEY = "sts_monitor_cfg_v2";
const EDGE_CFG_KEY = "sts_edge_cfg_v2";

let lockedRole = null; // 'monitor' atau 'edge'
let masterPasswordHash = ""; // Disimpan di Monitor & dikirim via beacon terenkripsi untuk validasi
let pendingPasswordCallback = null;

function pindahTab(nama) {
  // Cegah pindah ke tab terlarang sesuai kunci peran
  if (lockedRole === 'monitor' && nama === 'edge') {
    tampilToast("Perangkat ini dikunci sebagai Monitor dan tidak dapat menjadi Edge Device.", "error");
    return;
  }
  if (lockedRole === 'edge' && nama === 'monitor') {
    tampilToast("Perangkat ini dikunci sebagai Edge Device dan tidak dapat membuka Monitor.", "error");
    return;
  }

  document.querySelectorAll('.tab-view').forEach((v) => v.classList.add('hidden'));
  $('view-' + nama).classList.remove('hidden');

  document.querySelectorAll('.tab').forEach((t) => {
    t.className = 'tab';
    if (lockedRole === 'monitor' && t.dataset.tab === 'edge') t.classList.add('hidden');
    if (lockedRole === 'edge' && t.dataset.tab === 'monitor') t.classList.add('hidden');
    if (t.dataset.tab === nama) t.classList.add('aktif-' + nama);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ==================== GERBANG AWAL (ONBOARDING ROLE GATE) ====================
function pilihSetupPeran(peran) {
  $('gateRoleSelection').classList.add('hidden');
  if (peran === 'monitor') {
    $('formSetupMonitor').classList.remove('hidden');
  } else {
    $('formSetupEdge').classList.remove('hidden');
  }
}

function kembaliKePilihanPeran() {
  $('formSetupMonitor').classList.add('hidden');
  $('formSetupEdge').classList.add('hidden');
  $('edgeHandshakeStatus').classList.add('hidden');
  $('gateRoleSelection').classList.remove('hidden');
}

function submitSetupMonitor(e) {
  e.preventDefault();
  const broker = $('setupMonBroker').value.trim();
  const project = $('setupMonProject').value.trim();
  const pwd = $('setupMonPassword').value;
  const threshold = parseFloat($('setupMonThreshold').value) || 2.5;
  const radius = Math.min(10, Math.max(1, parseFloat($('setupMonRadius').value) || 10));

  if (!broker || !project || pwd.length < 4) {
    tampilToast("Mohon lengkapi Broker, Project ID, dan Sandi minimal 4 karakter.", "error");
    return;
  }

  masterPasswordHash = simpleHash(pwd);
  lockedRole = 'monitor';

  $('brokerUrl').value = broker;
  $('projectId').value = project;
  $('thresholdInput').value = threshold;
  $('safezoneRadiusInput').value = radius;

  localStorage.setItem(ROLE_STORAGE_KEY, 'monitor');
  localStorage.setItem(MONITOR_CFG_KEY, JSON.stringify({
    broker, project, pwdHash: masterPasswordHash, threshold, radius
  }));

  applyRoleLockUI('monitor');
  $('roleGateOverlay').classList.add('hidden');
  startMonitorMode();
}

// Saat HP ingin masuk sebagai Edge: Wajib cek apakah ada Monitor Aktif di Broker & Project ID tersebut
function submitSetupEdge(e) {
  e.preventDefault();
  const broker = $('setupEdgeBroker').value.trim();
  const project = $('setupEdgeProject').value.trim();
  const name = $('setupEdgeName').value.trim();

  if (!broker || !project || !name) {
    tampilToast("Alamat MQTT, Project ID, dan Nama HP wajib diisi semua!", "error");
    return;
  }

  const statusBox = $('edgeHandshakeStatus');
  const btn = $('btnVerifyAndEnterEdge');
  statusBox.classList.remove('hidden');
  statusBox.style.color = "#fbbf24";
  statusBox.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Menghubungi ${broker} &amp; memeriksa Monitor aktif pada Project ID "${project}"...`;
  btn.disabled = true;

  const tempClientId = "sts_probe_" + Math.random().toString(16).substring(2, 8);
  const probeClient = mqtt.connect(broker, { clientId: tempClientId, clean: true, connectTimeout: 5000 });
  const beaconTopic = `sts/${project}/monitor_status`;
  let monitorFound = false;

  const timer = setTimeout(() => {
    if (!monitorFound) {
      try { probeClient.end(true); } catch (err) {}
      btn.disabled = false;
      statusBox.style.color = "#f87171";
      statusBox.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Gagal Masuk: Tidak ditemukan Monitor yang aktif pada Project ID "<strong>${project}</strong>"! Pastikan pengawas sudah mengaktifkan Monitor terlebih dahulu.`;
      tampilToast("Ditolak: Server/Project ID tidak memiliki Monitor aktif!", "error");
    }
  }, 4500);

  probeClient.on('connect', () => {
    probeClient.subscribe(beaconTopic, { qos: 1 });
  });

  probeClient.on('message', (topic, message) => {
    if (topic === beaconTopic) {
      try {
        const data = JSON.parse(message.toString());
        if (data && data.active === true) {
          monitorFound = true;
          clearTimeout(timer);
          masterPasswordHash = data.pwd_hash || "";
          if (data.threshold !== undefined) $('thresholdInput').value = data.threshold;
          if (data.radius !== undefined) $('safezoneRadiusInput').value = data.radius;

          try { probeClient.end(true); } catch (err) {}
          btn.disabled = false;

          // Kunci peran sebagai Edge Device
          lockedRole = 'edge';
          phoneCustomName = name;
          $('brokerUrl').value = broker;
          $('projectId').value = project;
          $('customPhoneName').value = name;
          $('eDisplayName').textContent = name;
          $('edgeBoundProjectLbl').textContent = project;

          localStorage.setItem(ROLE_STORAGE_KEY, 'edge');
          localStorage.setItem(EDGE_CFG_KEY, JSON.stringify({
            broker, project, name, pwdHash: masterPasswordHash
          }));

          applyRoleLockUI('edge');
          $('roleGateOverlay').classList.add('hidden');
          startEdgeNode();
        }
      } catch (err) {}
    }
  });

  probeClient.on('error', () => {
    clearTimeout(timer);
    try { probeClient.end(true); } catch (err) {}
    btn.disabled = false;
    statusBox.style.color = "#f87171";
    statusBox.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Tidak dapat terhubung ke alamat MQTT Broker tersebut. Periksa kembali URL WSS.`;
  });
}

function applyRoleLockUI(role) {
  if (role === 'monitor') {
    $('roleNavbarSub').textContent = "Locked: Master Monitor";
    $('navTabMonitor').classList.remove('hidden');
    $('mobTabMonitor').classList.remove('hidden');
    $('navTabEdge').classList.add('hidden');
    $('mobTabEdge').classList.add('hidden');
    $('configEditBtnWrap').style.display = 'flex';
    pindahTab('monitor');
  } else if (role === 'edge') {
    $('roleNavbarSub').textContent = "Locked: Protected Edge HP";
    $('navTabMonitor').classList.add('hidden');
    $('mobTabMonitor').classList.add('hidden');
    $('navTabEdge').classList.remove('hidden');
    $('mobTabEdge').classList.remove('hidden');
    // Di HP Edge, sembunyikan tombol ubah parameter global agar pencuri tidak bisa mengutak-atik
    $('configEditBtnWrap').style.display = 'none';
    pindahTab('edge');
  }
}

// ==================== MODAL VERIFIKASI SANDI MASTER MONITOR ====================
function requireMonitorPassword(descText, onVerified, newValueConfig = null) {
  $('pwdModalDesc').textContent = descText;
  $('pwdVerifyInput').value = "";

  const wrap = $('pwdNewValueWrap');
  const valInput = $('pwdNewValueInput');
  if (newValueConfig) {
    wrap.style.display = 'block';
    $('pwdNewValueLabel').textContent = newValueConfig.label;
    valInput.type = newValueConfig.type || 'text';
    valInput.value = newValueConfig.defaultValue || '';
    valInput.placeholder = newValueConfig.placeholder || '';
    valInput.required = true;
  } else {
    wrap.style.display = 'none';
    valInput.required = false;
  }

  pendingPasswordCallback = onVerified;
  $('passwordModalOverlay').classList.remove('hidden');
  setTimeout(() => $('pwdVerifyInput').focus(), 80);
}

function closePasswordModal() {
  $('passwordModalOverlay').classList.add('hidden');
  pendingPasswordCallback = null;
}

function confirmPasswordAction(e) {
  e.preventDefault();
  const inputPwd = $('pwdVerifyInput').value;
  if (simpleHash(inputPwd) !== masterPasswordHash) {
    tampilToast("Sandi Master Monitor SALAH! Tindakan ditolak.", "error");
    return;
  }
  const newVal = $('pwdNewValueInput').value.trim();
  const cb = pendingPasswordCallback;
  closePasswordModal();
  if (cb) cb(newVal);
}

// Ganti Peran Perangkat (Monitor <-> Edge) setelah mendapat izin & verifikasi Sandi Monitor
function requestSwitchRoleWithAuth() {
  if (lockedRole === 'edge' && !canPhoneSwitchRole) {
    tampilToast("Ditolak: HP ini belum mendapat izin Ganti Peran dari Monitor!", "error");
    return;
  }
  requireMonitorPassword(
    "Masukkan Sandi Master Monitor untuk membuka kunci peran dan kembali ke Gerbang Pemilihan Peran (Monitor / Edge):",
    () => {
      if (lockedRole === 'monitor' && isMonitorActive) {
        stopMonitorModeInternal();
      } else if (lockedRole === 'edge') {
        stopEdgeNodeInternal(true);
      }
      localStorage.removeItem(ROLE_STORAGE_KEY);
      localStorage.removeItem(MONITOR_CFG_KEY);
      localStorage.removeItem(EDGE_CFG_KEY);
      lockedRole = null;
      kembaliKePilihanPeran();
      $('roleGateOverlay').classList.remove('hidden');
      tampilToast("Kunci peran berhasil dibuka. Silakan pilih peran baru.", "sukses");
    }
  );
}

// Buka Kunci Edit Parameter Global (Broker, Project ID, Batas Kecepatan, Radius Safezone)
let isConfigUnlocked = false;
function openConfigEditWithAuth() {
  if (lockedRole !== 'monitor') return;
  if (!isConfigUnlocked) {
    requireMonitorPassword(
      "Masukkan Sandi Master Monitor untuk membuka kunci pengelolaan MQTT Broker, Project ID, Batas Kecepatan, dan ukuran Safezone:",
      () => {
        isConfigUnlocked = true;
        ['brokerUrl', 'projectId', 'thresholdInput', 'safezoneRadiusInput', 'intervalInput'].forEach(id => {
          $(id).removeAttribute('readonly');
          $(id).classList.remove('locked-input');
        });
        $('configEditBtnWrap').innerHTML = `
          <button class="btn btn-hijau" style="width:100%; justify-content:center; padding:8px;" onclick="saveAndLockConfig()">
            <i class="fa-solid fa-floppy-disk"></i> Simpan &amp; Kunci
          </button>
        `;
        tampilToast("Parameter dibuka! Silakan ubah lalu klik Simpan & Kunci.", "sukses");
      }
    );
  }
}

function saveAndLockConfig() {
  isConfigUnlocked = false;
  enforceMaxSafezone($('safezoneRadiusInput'));
  ['brokerUrl', 'projectId', 'thresholdInput', 'safezoneRadiusInput', 'intervalInput'].forEach(id => {
    $(id).setAttribute('readonly', 'true');
    $(id).classList.add('locked-input');
  });
  $('configEditBtnWrap').innerHTML = `
    <button class="btn btn-hitam" style="width:100%; justify-content:center; padding:8px;" onclick="openConfigEditWithAuth()">
      <i class="fa-solid fa-key" style="color:#fbbf24"></i> Ubah Parameter
    </button>
  `;

  // Simpan perubahan ke localStorage & siarkan ke seluruh HP
  const saved = JSON.parse(localStorage.getItem(MONITOR_CFG_KEY) || "{}");
  saved.broker = $('brokerUrl').value.trim();
  saved.project = $('projectId').value.trim();
  saved.threshold = parseFloat($('thresholdInput').value) || 2.5;
  saved.radius = parseFloat($('safezoneRadiusInput').value) || 10;
  localStorage.setItem(MONITOR_CFG_KEY, JSON.stringify(saved));

  publishMonitorBeacon(true);
  broadcastConfigUpdate();
  if (isMonitorActive) renderDevicesGrid();
  tampilToast("Parameter berhasil disimpan, disiarkan ke HP, dan dikunci kembali.", "sukses");
}

// ==================== FITUR NOTIFIKASI OS & FLOATING MINI-MONITOR (BEBAS TANPA SANDI) ====================
let osNotifEnabled = false;
const lastNotifTimestamp = {};

async function requestOsNotificationPermission() {
  if (!("Notification" in window)) {
    tampilToast("Browser ini tidak mendukung Web Notifications API.", "error");
    return;
  }
  if (Notification.permission === "granted") {
    osNotifEnabled = !osNotifEnabled;
    updateOsNotifButtonUI();
    if (osNotifEnabled) {
      sendSystemNotification("STS Radar Aktif", "Notifikasi Sistem Operasi siap memberikan peringatan anomali & status perangkat.", "sts_init");
    }
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      osNotifEnabled = true;
      updateOsNotifButtonUI();
      sendSystemNotification("Notifikasi OS Diaktifkan", "Anda akan menerima banner peringatan meskipun sedang membuka aplikasi lain.", "sts_init");
      tampilToast("Notifikasi Sistem Operasi berhasil diaktifkan!", "sukses");
    } else {
      tampilToast("Izin Notifikasi ditolak oleh browser.", "error");
    }
  } catch (e) {}
}

function updateOsNotifButtonUI() {
  const btn = $('btnOsNotif');
  if (osNotifEnabled && Notification.permission === "granted") {
    btn.className = "btn btn-hijau";
    btn.innerHTML = `<i class="fa-solid fa-bell"></i> Notifikasi OS: ON`;
  } else {
    btn.className = "btn btn-biru";
    btn.innerHTML = `<i class="fa-solid fa-bell-slash"></i> Notifikasi OS: OFF`;
  }
}

function sendSystemNotification(title, bodyText, tagKey = "sts_general", cooldownMs = 8000) {
  if (!osNotifEnabled || !("Notification" in window) || Notification.permission !== "granted") return;
  const now = Date.now();
  if (lastNotifTimestamp[tagKey] && (now - lastNotifTimestamp[tagKey] < cooldownMs)) return;
  lastNotifTimestamp[tagKey] = now;
  try {
    const notif = new Notification(title, {
      body: bodyText,
      tag: tagKey,
      renotify: true,
      requireInteraction: tagKey.includes("breach")
    });
    notif.onclick = () => { window.focus(); notif.close(); };
  } catch (e) {}
}

let floatingWindowRef = null;

async function toggleFloatingMiniMonitor() {
  if (floatingWindowRef && !floatingWindowRef.closed) {
    floatingWindowRef.close();
    floatingWindowRef = null;
    updateFloatingButtonUI(false);
    return;
  }
  try {
    if ("documentPictureInPicture" in window) {
      floatingWindowRef = await window.documentPictureInPicture.requestWindow({ width: 360, height: 460 });
    } else {
      floatingWindowRef = window.open("", "STS_Mini_Monitor", "width=360,height=470,menubar=no,toolbar=no,location=no,status=no,resizable=yes");
    }
    if (!floatingWindowRef) {
      tampilToast("Pop-up diblokir browser. Izinkan pop-up untuk membuka Mini-Monitor.", "error");
      return;
    }
    setupFloatingWindowDocument(floatingWindowRef);
    updateFloatingButtonUI(true);
    renderFloatingMiniMonitor();
    tampilToast("Floating Mini-Monitor aktif!", "sukses");
    floatingWindowRef.addEventListener("pagehide", () => {
      floatingWindowRef = null;
      updateFloatingButtonUI(false);
    });
  } catch (err) {
    tampilToast("Gagal membuka Floating Mini-Monitor: " + err.message, "error");
  }
}

function updateFloatingButtonUI(isOpen) {
  const btn = $('btnFloatingPip');
  if (isOpen) {
    btn.className = "btn btn-hijau";
    btn.innerHTML = `<i class="fa-solid fa-window-restore"></i> Floating Aktif`;
  } else {
    btn.className = "btn btn-ungu";
    btn.innerHTML = `<i class="fa-solid fa-window-restore"></i> Mode Floating`;
  }
}

function setupFloatingWindowDocument(win) {
  const doc = win.document;
  doc.open();
  doc.write(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <title>STS · Floating Mini-Monitor</title>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800&display=swap" rel="stylesheet">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Plus Jakarta Sans', system-ui, sans-serif; background: #0b0f19; color: #f8fafc; padding: 12px; font-size: 12px; }
        .pip-head { background: linear-gradient(90deg, #111827, #450a0a); border: 1px solid #7f1d1d; padding: 10px 12px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .pip-title { font-weight: 800; font-size: 13px; color: #fbbf24; }
        .pip-sub { font-size: 10px; color: #9ca3af; }
        .pip-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 10px; text-align: center; }
        .pip-stat-box { background: #161f33; border: 1px solid #283548; padding: 6px; border-radius: 8px; }
        .pip-stat-box .num { font-size: 15px; font-weight: 800; }
        .pip-stat-box .lbl { font-size: 9.5px; color: #9ca3af; }
        .pip-list { display: flex; flex-direction: column; gap: 8px; }
        .pip-card { background: #141b2d; border: 1px solid #283548; border-left: 4px solid #10b981; border-radius: 10px; padding: 9px 10px; }
        .pip-card.breach { border-left-color: #ef4444; background: linear-gradient(145deg, #241118, #141b2d); box-shadow: 0 0 15px rgba(239, 68, 68, 0.25); }
        .pip-card.wait { border-left-color: #f59e0b; }
        .pip-row-top { display: flex; justify-content: space-between; align-items: center; font-weight: 800; margin-bottom: 4px; }
        .pip-badge { padding: 2px 7px; border-radius: 999px; font-size: 9.5px; font-weight: 800; }
        .pip-badge.safe { background: rgba(16,185,129,0.2); color: #34d399; }
        .pip-badge.alert { background: #dc2626; color: #fff; }
        .pip-badge.wait { background: rgba(245,158,11,0.2); color: #fbbf24; }
        .pip-meta { font-size: 11px; color: #cbd5e1; display: flex; justify-content: space-between; margin-top: 3px; }
        .pip-coord { margin-top: 6px; padding-top: 5px; border-top: 1px dashed #374151; color: #fde047; font-family: monospace; font-size: 11px; display: flex; justify-content: space-between; align-items: center; }
        .pip-btn { background: #f59e0b; color: #111827; border: 0; border-radius: 5px; padding: 2px 7px; font-size: 10px; font-weight: 800; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="pip-head">
        <div>
          <div class="pip-title">⚡ STS Mini-Monitor</div>
          <div class="pip-sub" id="pipClock">Live Radar Always-on-Top</div>
        </div>
        <button class="pip-btn" onclick="window.opener ? window.opener.focus() : null">Buka Web</button>
      </div>
      <div class="pip-stats">
        <div class="pip-stat-box"><div class="num" id="pipTotal" style="color:#38bdf8">0</div><div class="lbl">HP Aktif</div></div>
        <div class="pip-stat-box"><div class="num" id="pipSafe" style="color:#34d399">0</div><div class="lbl">Aman</div></div>
        <div class="pip-stat-box"><div class="num" id="pipBreach" style="color:#ef4444">0</div><div class="lbl">Bergerak!</div></div>
      </div>
      <div id="pipDevicesList" class="pip-list"></div>
    </body>
    </html>
  `);
  doc.close();
}

function renderFloatingMiniMonitor() {
  if (!floatingWindowRef || floatingWindowRef.closed) return;
  const doc = floatingWindowRef.document;
  const listEl = doc.getElementById("pipDevicesList");
  if (!listEl) return;

  const list = Object.values(devicesRegistry);
  const breachCount = list.filter(d => d.lastData && d.lastData.is_outside_safezone).length;
  const safeCount = list.filter(d => d.safezone && d.lastData && !d.lastData.is_outside_safezone).length;

  doc.getElementById("pipClock").textContent = "Update: " + new Date().toLocaleTimeString('id-ID');
  doc.getElementById("pipTotal").textContent = list.length;
  doc.getElementById("pipSafe").textContent = safeCount;
  doc.getElementById("pipBreach").textContent = breachCount;

  if (!list.length) {
    listEl.innerHTML = `<div style="text-align:center; color:#9ca3af; padding:18px;">Belum ada HP aktif terhubung.</div>`;
    return;
  }

  listEl.innerHTML = list.map(dev => {
    const d = dev.lastData || {};
    const hasSz = !!dev.safezone;
    const isBreach = d.is_outside_safezone;
    const stateCls = !hasSz ? "wait" : (isBreach ? "breach" : "");
    const badgeHtml = !hasSz
      ? `<span class="pip-badge wait">Tunggu Safezone</span>`
      : isBreach
        ? `<span class="pip-badge alert">🔴 HP BERGERAK!</span>`
        : `<span class="pip-badge safe">🟢 AMAN</span>`;

    const durStr = dev.breachStartMs ? formatDurationMs(Date.now() - dev.breachStartMs) : "00:00:00";
    const coordStr = d.location ? `${d.location.latitude.toFixed(5)}, ${d.location.longitude.toFixed(5)}` : "-";

    return `
      <div class="pip-card ${stateCls}">
        <div class="pip-row-top">
          <span>${dev.displayName}</span>
          ${badgeHtml}
        </div>
        <div class="pip-meta">
          <span>🚀 ${(d.speed_kmh || 0).toFixed(1)} km/j</span>
          <span>📏 ${(d.distance_m || 0).toFixed(1)} m</span>
          <span>🔋 ${d.battery_pct ?? '--'}%</span>
        </div>
        ${isBreach ? `
          <div class="pip-coord">
            <span>⏱️ ${durStr} | 📍 ${coordStr}</span>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// ==================== ALARM WEB AUDIO API (BEBAS DIAKSES TANPA SANDI) ====================
let alarmAudioEnabled = true;
let audioCtx = null;

function toggleAlarmAudio() {
  alarmAudioEnabled = !alarmAudioEnabled;
  const btn = $('btnToggleAudio');
  btn.innerHTML = alarmAudioEnabled
    ? `<i class="fa-solid fa-volume-high"></i> Alarm: ON`
    : `<i class="fa-solid fa-volume-xmark"></i> Alarm: MUTE`;
  btn.style.borderColor = alarmAudioEnabled ? "#10b981" : "#4b5563";
  tampilToast(alarmAudioEnabled ? 'Suara Alarm Peringatan Aktif' : 'Suara Alarm Dibisukan (Mute)', 'info');
}

function playBreachBeep() {
  if (!alarmAudioEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.22);
  } catch (e) {}
}

// ==================== GENERATOR SVG SPEEDOMETER DINAMIS ====================
function buildSpeedometerSvg(speedKmh, thresholdKmh) {
  const spd = Math.max(0, parseFloat(speedKmh) || 0);
  const limit = Math.max(0, parseFloat(thresholdKmh) || 2.5);
  const maxScale = Math.max(15, Math.ceil((Math.max(spd, limit) + 3) / 5) * 5);

  const ratio = Math.min(1, spd / maxScale);
  const limitRatio = Math.min(1, limit / maxScale);

  const angleDeg = -90 + (ratio * 180);
  const limitAngleRad = Math.PI * (1 - limitRatio);

  const cx = 75, cy = 72, r = 52;
  const limX = (cx + r * Math.cos(limitAngleRad)).toFixed(1);
  const limY = (cy - r * Math.sin(limitAngleRad)).toFixed(1);

  const isOver = spd > limit && spd > 0;
  const arcColor = isOver ? "#ef4444" : (spd > limit * 0.75 ? "#f59e0b" : "#10b981");
  const dashArray = 163.36;
  const dashOffset = (dashArray * (1 - ratio)).toFixed(1);

  return `
    <div class="speedo-wrap">
      <svg viewBox="0 0 150 86" class="speedo-svg">
        <path d="M 23 72 A 52 52 0 0 1 127 72" fill="none" stroke="#1f2937" stroke-width="11" stroke-linecap="round"/>
        <path d="M 23 72 A 52 52 0 0 1 127 72" fill="none" stroke="${arcColor}" stroke-width="11"
              stroke-linecap="round" stroke-dasharray="${dashArray}" stroke-dashoffset="${dashOffset}"
              style="transition: stroke-dashoffset 0.35s ease, stroke 0.25s ease;"/>
        <circle cx="${limX}" cy="${limY}" r="4.5" fill="#fbbf24" stroke="#111827" stroke-width="1.5">
          <title>Batas Kecepatan: ${limit} km/j</title>
        </circle>
        <text x="16" y="84" fill="#6b7280" font-size="8.5" font-weight="700">0</text>
        <text x="75" y="13" fill="#6b7280" font-size="8.5" font-weight="700" text-anchor="middle">${(maxScale/2).toFixed(0)}</text>
        <text x="134" y="84" fill="#6b7280" font-size="8.5" font-weight="700" text-anchor="end">${maxScale}</text>
        <g transform="translate(75, 72) rotate(${angleDeg.toFixed(1)})" style="transition: transform 0.35s ease;">
          <polygon points="-2.5,0 0,-46 2.5,0" fill="${isOver ? '#f87171' : '#f8fafc'}"/>
          <circle cx="0" cy="0" r="5.5" fill="#f59e0b" stroke="#111827" stroke-width="1.5"/>
        </g>
      </svg>
      <div class="speedo-value-num" style="color:${isOver ? '#f87171' : '#38bdf8'}">${spd.toFixed(1)}</div>
      <div class="speedo-unit-lbl">km/jam</div>
      <span class="speedo-limit-tag">Batas: ${limit} km/j</span>
    </div>
  `;
}

// ==================== STATE GLOBAL STS & CACHE HISTORY ====================
const DISCONNECT_TIMEOUT_MS = 10000;
const STORAGE_CACHE_KEY = "sts_history_cache_v1";

let mqttClient = null;
let currentMode = null;
let isMonitorActive = false;
let publishTimer = null;

let sessionDeviceId = localStorage.getItem("sts_my_device_id");
if (!sessionDeviceId) {
  sessionDeviceId = "dev_" + Math.random().toString(36).substring(2, 8);
  localStorage.setItem("sts_my_device_id", sessionDeviceId);
}
let phoneCustomName = "";
let assignedAutoName = "";

let latestLat = -7.257745;
let latestLon = 110.416302;
let gpsSpeedKmh = 0.0;
let accelWindow = [];
let latestRms = 0.0;
let batteryPct = 88;

let mySafezone = null;
let canPhoneSetSafezone = false;
let canPhoneSwitchRole = false;

const devicesRegistry = {};
let historyCache = {};
const blockedDevices = new Set();

let deviceCounter = 0;
let alertLogCount = 0;
const palette = ['#38bdf8', '#f97316', '#10b981', '#a855f7', '#ec4899', '#eab308', '#14b8a6', '#f43f5e'];

function loadHistoryFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_CACHE_KEY);
    if (raw) historyCache = JSON.parse(raw) || {};
  } catch (e) { historyCache = {}; }
}

function saveHistoryToStorage() {
  try {
    localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(historyCache));
  } catch (e) {}
}

setInterval(() => {
  const nowStr = new Date().toLocaleTimeString('id-ID');
  $('clockBadge').innerHTML = `<i class="fa-regular fa-clock"></i> ${nowStr}`;
  if (isMonitorActive) {
    updateMonitorStopwatches();
    checkDisconnectedDevicesTimeout();
    renderFloatingMiniMonitor();
  }
}, 1000);

function enforceMaxSafezone(el) {
  let val = parseFloat(el.value) || 10;
  if (val > 10) val = 10;
  if (val < 1) val = 1;
  el.value = val;
}

function getTopicBase() {
  const pid = $('projectId').value.trim() || 'STS_Firdaus_999';
  return `sts/${pid}`;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDurationMs(ms) {
  if (!ms || ms < 0) return "00:00:00";
  const totalSec = Math.floor(ms / 1000);
  const hrs = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  return `${hrs}:${mins}:${secs}`;
}

// ==================== CHART.JS (3 GRAFIK KOMPARASI) ====================
let speedChart, rmsChart, distChart;

function initAppAndCharts() {
  loadHistoryFromStorage();

  if ("Notification" in window && Notification.permission === "granted") {
    osNotifEnabled = true;
    updateOsNotifButtonUI();
  }

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      x: { ticks: { color: '#9ca3af', maxTicksLimit: 6 }, grid: { color: '#1f2937' } },
      y: { beginAtZero: true, ticks: { color: '#9ca3af' }, grid: { color: '#1f2937' } }
    },
    plugins: { legend: { labels: { color: '#f3f4f6', boxWidth: 12 } } }
  };

  speedChart = new Chart($('speedChart'), { type: 'line', data: { labels: [], datasets: [] }, options: commonOptions });
  rmsChart = new Chart($('rmsChart'), { type: 'line', data: { labels: [], datasets: [] }, options: commonOptions });
  distChart = new Chart($('distChart'), { type: 'line', data: { labels: [], datasets: [] }, options: commonOptions });

  $('edgeLocalSpeedo').innerHTML = buildSpeedometerSvg(0, parseFloat($('thresholdInput').value) || 2.5);
  updateMonitorSummaryStats();
  renderHistoryGrid();

  // Pulihkan kunci peran jika sebelumnya sudah pernah setup
  const savedRole = localStorage.getItem(ROLE_STORAGE_KEY);
  if (savedRole === 'monitor') {
    try {
      const cfg = JSON.parse(localStorage.getItem(MONITOR_CFG_KEY) || "{}");
      if (cfg.broker && cfg.project && cfg.pwdHash) {
        lockedRole = 'monitor';
        masterPasswordHash = cfg.pwdHash;
        $('brokerUrl').value = cfg.broker;
        $('projectId').value = cfg.project;
        $('thresholdInput').value = cfg.threshold ?? 2.5;
        $('safezoneRadiusInput').value = cfg.radius ?? 10;
        applyRoleLockUI('monitor');
        $('roleGateOverlay').classList.add('hidden');
        startMonitorMode();
      }
    } catch (e) {}
  } else if (savedRole === 'edge') {
    try {
      const cfg = JSON.parse(localStorage.getItem(EDGE_CFG_KEY) || "{}");
      if (cfg.broker && cfg.project && cfg.name) {
        lockedRole = 'edge';
        masterPasswordHash = cfg.pwdHash || "";
        phoneCustomName = cfg.name;
        $('brokerUrl').value = cfg.broker;
        $('projectId').value = cfg.project;
        $('customPhoneName').value = cfg.name;
        $('eDisplayName').textContent = cfg.name;
        $('edgeBoundProjectLbl').textContent = cfg.project;
        applyRoleLockUI('edge');
        $('roleGateOverlay').classList.add('hidden');
        startEdgeNode();
      }
    } catch (e) {}
  }
}
window.addEventListener('DOMContentLoaded', initAppAndCharts);

function removeDatasetFromCharts(nameKey) {
  [speedChart, rmsChart, distChart].forEach(chart => {
    chart.data.datasets = chart.data.datasets.filter(ds => ds.userKey !== nameKey);
    chart.update();
  });
}

function pushDataToCharts(timeLabel) {
  const charts = [
    { chart: speedChart, key: 'speed_kmh', histKey: 'speed' },
    { chart: rmsChart, key: 'accel_rms', histKey: 'rms' },
    { chart: distChart, key: 'distance_m', histKey: 'dist' }
  ];
  charts.forEach(({ chart, key, histKey }) => {
    chart.data.labels.push(timeLabel);
    if (chart.data.labels.length > 20) chart.data.labels.shift();

    Object.values(devicesRegistry).forEach((dev) => {
      const uKey = dev.displayName.toLowerCase();
      let ds = chart.data.datasets.find(d => d.userKey === uKey);
      if (!ds) {
        const restoredData = (dev.chartHistory && dev.chartHistory[histKey]) ? [...dev.chartHistory[histKey]] : [];
        ds = {
          userKey: uKey,
          deviceId: dev.deviceId,
          label: dev.displayName,
          data: restoredData,
          borderColor: dev.color,
          backgroundColor: dev.color,
          tension: 0.3,
          borderWidth: 2,
          pointRadius: 2
        };
        chart.data.datasets.push(ds);
      } else {
        ds.label = dev.displayName;
        ds.borderColor = dev.color;
      }
      const val = dev.lastData ? (dev.lastData[key] || 0) : 0;
      ds.data.push(val);
      if (ds.data.length > 20) ds.data.shift();

      if (!dev.chartHistory) dev.chartHistory = { speed: [], rms: [], dist: [] };
      dev.chartHistory[histKey] = [...ds.data];
    });
    chart.update();
  });
}

// ==================== KONEKSI MQTT & BEACON MONITOR AKTIF ====================
function connectMqtt(onConnected, willConfig = null) {
  if (mqttClient) { try { mqttClient.end(true); } catch(e){} mqttClient = null; }
  const brokerUrl = $('brokerUrl').value.trim();
  const clientId = `sts_${currentMode || 'node'}_${Math.random().toString(16).substring(2, 9)}`;

  const badge = $('mqttGlobalBadge');
  badge.className = "chip-mqtt wait";
  badge.textContent = "MQTT: Connecting...";

  const opts = { clientId, clean: true, connectTimeout: 5000 };
  if (willConfig) opts.will = willConfig;

  mqttClient = mqtt.connect(brokerUrl, opts);

  mqttClient.on('connect', () => {
    badge.className = "chip-mqtt ok";
    badge.textContent = `MQTT: Connected`;
    if (onConnected) onConnected();
  });

  mqttClient.on('error', () => {
    badge.className = "chip-mqtt err";
    badge.textContent = "MQTT: Error";
  });
}

function publishMonitorBeacon(isActive) {
  if (!mqttClient || !mqttClient.connected) return;
  const beaconTopic = `${getTopicBase()}/monitor_status`;
  const payload = {
    active: isActive,
    pwd_hash: masterPasswordHash,
    threshold: parseFloat($('thresholdInput').value) || 2.5,
    radius: Math.min(10, parseFloat($('safezoneRadiusInput').value) || 10),
    timestamp: Date.now()
  };
  mqttClient.publish(beaconTopic, JSON.stringify(payload), { qos: 1, retain: true });
}

// ==================== TOGGLE AKTIFKAN / MATIKAN MONITOR (DILINDUNGI SANDI) ====================
function requestToggleMonitorWithAuth() {
  requireMonitorPassword(
    isMonitorActive
      ? "Masukkan Sandi Master Monitor untuk MEMATIKAN Monitor dan menghentikan server pemantauan:"
      : "Masukkan Sandi Master Monitor untuk MENGAKTIFKAN kembali Monitor:",
    () => {
      if (isMonitorActive) {
        stopMonitorModeInternal();
      } else {
        startMonitorMode();
      }
    }
  );
}

function startMonitorMode() {
  currentMode = 'monitor';
  const beaconTopic = `${getTopicBase()}/monitor_status`;
  const lwt = {
    topic: beaconTopic,
    payload: JSON.stringify({ active: false, timestamp: Date.now() }),
    qos: 1,
    retain: true
  };

  connectMqtt(() => {
    isMonitorActive = true;
    const base = getTopicBase();
    mqttClient.subscribe([`${base}/edge/+/telemetry`, `${base}/edge/+/offline`], { qos: 1 });

    // Pancarkan Retained Beacon bahwa Monitor Aktif di Project ID ini
    publishMonitorBeacon(true);

    const btn = $('btnToggleMonitor');
    btn.className = "btn btn-hitam";
    btn.innerHTML = `<i class="fa-solid fa-power-off" style="color:#ef4444"></i> Matikan Monitor <i class="fa-solid fa-lock" style="font-size:10px"></i>`;
    tampilToast('Monitor AKTIF & memancarkan sinyal server ke perangkat Edge.', 'sukses');
    renderDevicesGrid();

    mqttClient.on('message', (topic, message) => {
      if (!isMonitorActive) return;
      try {
        const payload = JSON.parse(message.toString());
        if (topic.endsWith('/telemetry')) {
          handleIncomingTelemetryOnMonitor(payload);
        } else if (topic.endsWith('/offline')) {
          if (payload.device_id && devicesRegistry[payload.device_id]) {
            moveDeviceToHistory(payload.device_id, "Memutuskan koneksi (Stop)");
          }
        }
      } catch (e) {}
    });
  }, lwt);
}

function stopMonitorModeInternal() {
  isMonitorActive = false;
  if (mqttClient && mqttClient.connected) {
    try { publishMonitorBeacon(false); } catch (e) {}
  }
  setTimeout(() => {
    if (mqttClient) {
      try { mqttClient.end(true); } catch (e) {}
      mqttClient = null;
    }
    $('mqttGlobalBadge').className = "chip-mqtt";
    $('mqttGlobalBadge').textContent = "MQTT: Disconnected";

    const btn = $('btnToggleMonitor');
    btn.className = "btn btn-merah";
    btn.innerHTML = `<i class="fa-solid fa-satellite-dish"></i> Aktifkan Monitor <i class="fa-solid fa-lock" style="font-size:10px"></i>`;
    tampilToast('Monitor telah DIMATIKAN.', 'info');
  }, 200);
}

// ==================== PEMROSESAN TELEMETRI & KONTROL BERPASSWORD ====================
function handleIncomingTelemetryOnMonitor(data) {
  const devId = data.device_id;
  if (!devId) return;

  const incomingName = (data.custom_name || "").trim();
  const nameKey = incomingName.toLowerCase();

  // 1. Cek Daftar Blokir
  if (blockedDevices.has(devId) || (nameKey && blockedDevices.has(nameKey))) {
    sendControlToPhone(devId, { action: "FORCE_DISCONNECT", reason: "Perangkat Anda diblokir oleh Monitor." });
    return;
  }

  // 2. Registrasi HP Baru atau Auto-Restore dari History Cache
  if (!devicesRegistry[devId]) {
    if (nameKey) {
      Object.keys(devicesRegistry).forEach(oldId => {
        if (oldId !== devId && devicesRegistry[oldId].displayName.toLowerCase() === nameKey) {
          moveDeviceToHistory(oldId, "Sesi diperbarui");
        }
      });
    }

    const cached = nameKey && historyCache[nameKey] ? historyCache[nameKey] : null;

    if (cached) {
      devicesRegistry[devId] = {
        deviceId: devId,
        orderIndex: cached.orderIndex || (++deviceCounter),
        displayName: cached.displayName,
        lastData: data,
        safezone: cached.safezone || null,
        canPhoneEditSafezone: !!cached.canPhoneEditSafezone,
        canPhoneSwitchRole: !!cached.canPhoneSwitchRole,
        breachStartMs: null,
        color: cached.color || palette[(deviceCounter - 1) % palette.length],
        coordHistory: cached.coordHistory || [],
        chartHistory: cached.chartHistory || { speed: [], rms: [], dist: [] },
        lastSeenMs: Date.now()
      };
      delete historyCache[nameKey];
      saveHistoryToStorage();
      renderHistoryGrid();

      if (devicesRegistry[devId].safezone) {
        sendControlToPhone(devId, { action: "SET_SAFEZONE", safezone: devicesRegistry[devId].safezone });
      }
      sendControlToPhone(devId, {
        action: "SAFEZONE_PERMISSION",
        allowed: devicesRegistry[devId].canPhoneEditSafezone,
        can_switch_role: devicesRegistry[devId].canPhoneSwitchRole,
        radius: Math.min(10, parseFloat($('safezoneRadiusInput').value) || 10)
      });
      tampilToast(`Selamat datang kembali, ${cached.displayName}! Data dipulihkan dari History.`, 'sukses');
      sendSystemNotification(
        `🔄 ${cached.displayName} Terhubung Kembali`,
        `Data grafik dan titik Safezone berhasil dipulihkan dari History Cache.`,
        `sts_conn_${devId}`,
        5000
      );
    } else {
      deviceCounter++;
      const defaultName = incomingName !== "" ? incomingName : `HP ${deviceCounter}`;
      const fallbackCache = historyCache[defaultName.toLowerCase()];
      devicesRegistry[devId] = {
        deviceId: devId,
        orderIndex: deviceCounter,
        displayName: defaultName,
        lastData: data,
        safezone: fallbackCache ? fallbackCache.safezone : null,
        canPhoneEditSafezone: fallbackCache ? !!fallbackCache.canPhoneEditSafezone : false,
        canPhoneSwitchRole: false,
        breachStartMs: null,
        color: fallbackCache ? fallbackCache.color : palette[(deviceCounter - 1) % palette.length],
        coordHistory: fallbackCache ? (fallbackCache.coordHistory || []) : [],
        chartHistory: fallbackCache ? (fallbackCache.chartHistory || { speed: [], rms: [], dist: [] }) : { speed: [], rms: [], dist: [] },
        lastSeenMs: Date.now()
      };
      if (fallbackCache) {
        delete historyCache[defaultName.toLowerCase()];
        saveHistoryToStorage();
        renderHistoryGrid();
      }
      sendControlToPhone(devId, { action: "ASSIGN_AUTO_NAME", auto_name: defaultName });
      tampilToast(`Perangkat baru terhubung: ${devicesRegistry[devId].displayName}`, 'info');
      sendSystemNotification(
        `📱 Perangkat Baru: ${devicesRegistry[devId].displayName}`,
        `Terhubung ke STS Radar. Silakan kunci titik Safezone (<=10m).`,
        `sts_conn_${devId}`,
        5000
      );
    }
  }

  const dev = devicesRegistry[devId];
  dev.lastSeenMs = Date.now();

  if (data.phone_safezone && dev.canPhoneEditSafezone) {
    dev.safezone = {
      lat: data.phone_safezone.lat,
      lon: data.phone_safezone.lon,
      radius: Math.min(10, parseFloat($('safezoneRadiusInput').value) || 10)
    };
    tampilToast(`${dev.displayName} memperbarui titik Safezone.`, 'sukses');
  }

  if (data.location) {
    const coordStr = `${data.location.latitude.toFixed(6)}, ${data.location.longitude.toFixed(6)}`;
    if (!dev.coordHistory) dev.coordHistory = [];
    if (dev.coordHistory[0]?.coord !== coordStr) {
      dev.coordHistory.unshift({
        coord: coordStr,
        time: new Date().toLocaleTimeString('id-ID'),
        speed: (data.speed_kmh || 0).toFixed(1)
      });
      if (dev.coordHistory.length > 12) dev.coordHistory.pop();
    }
  }

  const maxRad = Math.min(10, parseFloat($('safezoneRadiusInput').value) || 10);
  const speedLimit = parseFloat($('thresholdInput').value) || 2.5;
  let distM = 0;
  let isOutsideSafezone = false;

  if (dev.safezone && data.location) {
    dev.safezone.radius = maxRad;
    distM = haversineMeters(dev.safezone.lat, dev.safezone.lon, data.location.latitude, data.location.longitude);
    isOutsideSafezone = distM > maxRad;
  }

  data.distance_m = parseFloat(distM.toFixed(2));
  data.is_outside_safezone = isOutsideSafezone;

  if (isOutsideSafezone) {
    if (!dev.breachStartMs) dev.breachStartMs = Date.now();
    playBreachBeep();
    const coordNotif = data.location ? `${data.location.latitude.toFixed(5)}, ${data.location.longitude.toFixed(5)}` : "-";
    sendSystemNotification(
      `🚨 ANOMALI: ${dev.displayName} Keluar Safezone!`,
      `Jarak: ${data.distance_m}m (> ${maxRad}m) | Speed: ${(data.speed_kmh || 0).toFixed(1)} km/j | Lokasi: ${coordNotif}`,
      `sts_breach_${devId}`,
      9000
    );
  } else {
    if (dev.breachStartMs) {
      sendSystemNotification(
        `🟢 ${dev.displayName} Kembali Aman`,
        `Perangkat telah kembali masuk ke dalam radius Safezone (${data.distance_m}m).`,
        `sts_safe_${devId}`,
        5000
      );
    }
    dev.breachStartMs = null;
  }

  if ((data.speed_kmh || 0) > speedLimit && (data.speed_kmh || 0) > 0) {
    sendSystemNotification(
      `⚠️ Overspeed: ${dev.displayName} (${(data.speed_kmh || 0).toFixed(1)} km/j)`,
      `Melebihi batas kecepatan ${speedLimit} km/j! Getaran: ${(data.accel_rms || 0).toFixed(2)} m/s²`,
      `sts_speed_${devId}`,
      10000
    );
  }

  dev.lastData = data;
  updateMonitorSummaryStats();
  renderDevicesGrid();
  renderFloatingMiniMonitor();
  pushDataToCharts(new Date().toLocaleTimeString('id-ID'));

  if (isOutsideSafezone) appendAlertLog(dev, data);
}

function checkDisconnectedDevicesTimeout() {
  const now = Date.now();
  Object.keys(devicesRegistry).forEach(devId => {
    const dev = devicesRegistry[devId];
    if (now - dev.lastSeenMs >= DISCONNECT_TIMEOUT_MS) {
      moveDeviceToHistory(devId, "Tidak ada data selama 10 detik (Timeout)");
    }
  });
}

function moveDeviceToHistory(devId, reason = "Terputus") {
  const dev = devicesRegistry[devId];
  if (!dev) return;

  const key = dev.displayName.toLowerCase();
  historyCache[key] = {
    displayName: dev.displayName,
    lastDeviceId: dev.deviceId,
    orderIndex: dev.orderIndex,
    color: dev.color,
    safezone: dev.safezone,
    canPhoneEditSafezone: dev.canPhoneEditSafezone,
    canPhoneSwitchRole: dev.canPhoneSwitchRole,
    lastData: dev.lastData,
    coordHistory: dev.coordHistory || [],
    chartHistory: dev.chartHistory || { speed: [], rms: [], dist: [] },
    disconnectedAt: new Date().toLocaleTimeString('id-ID'),
    reason: reason
  };

  delete devicesRegistry[devId];
  removeDatasetFromCharts(key);
  saveHistoryToStorage();

  updateMonitorSummaryStats();
  renderDevicesGrid();
  renderHistoryGrid();
  renderFloatingMiniMonitor();
  tampilToast(`${dev.displayName} dipindahkan ke History (${reason}).`, 'info');
  sendSystemNotification(
    `🔌 ${dev.displayName} Terputus (Offline)`,
    `${reason}. Riwayat koordinat & grafik disimpan di History Cache.`,
    `sts_off_${devId}`,
    5000
  );
}

// Semua aksi berdampak ke HP di bawah ini WAJIB menggunakan Sandi Master Monitor
function kickDeviceFromMonitor(devId) {
  const dev = devicesRegistry[devId];
  if (!dev) return;
  requireMonitorPassword(
    `Masukkan Sandi Master Monitor untuk MEMUTUSKAN KONEKSI (Kick) perangkat "${dev.displayName}":`,
    () => {
      sendControlToPhone(devId, {
        action: "FORCE_DISCONNECT",
        reason: "Koneksi diputuskan oleh Pengawas Monitor."
      });
      moveDeviceToHistory(devId, "Diputus oleh Monitor (Kick)");
    }
  );
}

function blockDeviceFromMonitor(devId) {
  const dev = devicesRegistry[devId];
  if (!dev) return;
  requireMonitorPassword(
    `Masukkan Sandi Master Monitor untuk MEMBLOKIR (Blacklist) perangkat "${dev.displayName}":`,
    () => {
      const nameKey = dev.displayName.toLowerCase();
      blockedDevices.add(devId);
      blockedDevices.add(nameKey);

      sendControlToPhone(devId, {
        action: "FORCE_DISCONNECT",
        reason: "Perangkat Anda telah DIBLOKIR oleh Monitor."
      });

      delete devicesRegistry[devId];
      delete historyCache[nameKey];
      removeDatasetFromCharts(nameKey);
      saveHistoryToStorage();

      renderBlacklistBar();
      updateMonitorSummaryStats();
      renderDevicesGrid();
      renderHistoryGrid();
      renderFloatingMiniMonitor();
      tampilToast(`Perangkat "${dev.displayName}" berhasil diblokir & dihapus!`, 'error');
    }
  );
}

function unblockEntity(item) {
  requireMonitorPassword(
    `Masukkan Sandi Master Monitor untuk membuka blokir perangkat "${item}":`,
    () => {
      blockedDevices.delete(item);
      renderBlacklistBar();
      tampilToast(`Blokir untuk "${item}" telah dibuka.`, 'sukses');
    }
  );
}

function renderBlacklistBar() {
  const bar = $('blacklistBar');
  const container = $('blacklistChips');
  if (blockedDevices.size === 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  container.innerHTML = Array.from(blockedDevices).map(item => `
    <button class="blacklist-chip" onclick="unblockEntity('${item}')">
      <i class="fa-solid fa-lock-open"></i> ${item} <i class="fa-solid fa-xmark"></i>
    </button>
  `).join('');
}

function updateMonitorSummaryStats() {
  const list = Object.values(devicesRegistry);
  const breachCount = list.filter(d => d.lastData && d.lastData.is_outside_safezone).length;
  const safeCount = list.filter(d => d.safezone && d.lastData && !d.lastData.is_outside_safezone).length;
  const histCount = Object.keys(historyCache).length;

  $('statTotalHp').textContent = list.length + " Unit";
  $('statSafeHp').textContent = safeCount + " Unit";
  $('statBreachHp').textContent = breachCount + " Unit";
  $('statHistoryCount').textContent = histCount + " Profil";
}

function renderDevicesGrid() {
  const grid = $('devicesGrid');
  const list = Object.values(devicesRegistry);
  if (!list.length) {
    grid.innerHTML = `
      <div class="hp-card menunggu" style="grid-column: 1 / -1; text-align:center; padding: 28px;">
        <p style="color:#9ca3af; font-size:13.5px;">
          ${isMonitorActive
            ? 'Menunggu sinyal HP yang aktif... (HP yang terputus >10 detik otomatis berada di bagian History di bawah).'
            : 'Monitor sedang Nonaktif. Klik tombol <strong>"Aktifkan Monitor"</strong> di kanan atas untuk mulai membaca.'}
        </p>
      </div>`;
    return;
  }
  grid.innerHTML = "";

  const speedLimit = parseFloat($('thresholdInput').value) || 0;

  list.forEach((dev) => {
    const d = dev.lastData || {};
    const hasSafezone = !!dev.safezone;
    const isBreach = d.is_outside_safezone;

    const cardStateClass = !hasSafezone ? "menunggu" : (isBreach ? "bergerak" : "aman");
    const statusPillHtml = !hasSafezone
      ? `<span class="status-pill kuning"><i class="fa-solid fa-hourglass-half"></i> Menunggu Safezone</span>`
      : isBreach
        ? `<span class="status-pill merah"><i class="fa-solid fa-circle"></i> HP Bergerak (Keluar Safezone!)</span>`
        : `<span class="status-pill hijau"><i class="fa-solid fa-shield-check"></i> Aman</span>`;

    const coordStr = d.location ? `${d.location.latitude.toFixed(6)}, ${d.location.longitude.toFixed(6)}` : "-";
    const mapsUrl = d.location ? `https://www.google.com/maps?q=${d.location.latitude.toFixed(6)},${d.location.longitude.toFixed(6)}` : "#";
    const breachDuration = dev.breachStartMs ? formatDurationMs(Date.now() - dev.breachStartMs) : "00:00:00";
    const nowClock = new Date().toLocaleTimeString('id-ID');
    const updateClock = new Date(d.timestamp || Date.now()).toLocaleTimeString('id-ID');

    const zoneBoxHtml = !hasSafezone
      ? `<div class="wait-box">
           <i class="fa-solid fa-bell"></i> <strong>Perangkat Terhubung!</strong> Klik tombol <em>"Set Safezone (&le;10m)"</em> di bawah untuk mengunci posisi awal.
         </div>`
      : !isBreach
        ? `<div class="safe-box">
             <div><i class="fa-solid fa-shield-halved"></i> <strong>Status: Aman</strong> &middot; Jarak: <strong>${(d.distance_m || 0).toFixed(1)} m</strong> (Batas &le; ${dev.safezone.radius}m)</div>
             <div style="font-size:11px; opacity:0.8; margin-top:3px;">Koordinat disembunyikan otomatis selama berada di dalam Safezone.</div>
           </div>`
        : `<div class="breach-box">
             <div class="breach-title">🚨 PERINGATAN: HP Meninggalkan Safezone (${(d.distance_m || 0).toFixed(1)} m &gt; ${dev.safezone.radius} m)</div>
             <div class="breach-row">
               <span>⏱️ Durasi Meninggalkan Safezone:</span>
               <strong class="mono" style="color:#fbbf24" id="timer_${dev.deviceId}">${breachDuration}</strong>
             </div>
             <div class="breach-row">
               <span>🕒 Jam Sekarang:</span>
               <strong class="mono" id="clock_${dev.deviceId}">${nowClock}</strong>
             </div>
             <div class="breach-coord-bar">
               <span>📍 Koordinat: <strong class="mono" style="color:#fbbf24">${coordStr}</strong></span>
               <div style="display:flex; gap:5px;">
                 <button class="btn-outline-xs" onclick="salinKoordinat('${coordStr}')">Copy</button>
                 <a href="${mapsUrl}" target="_blank" class="btn-outline-xs light">Maps</a>
               </div>
             </div>
           </div>`;

    const speedoHtml = buildSpeedometerSvg(d.speed_kmh || 0, speedLimit);

    const card = document.createElement('div');
    card.className = `hp-card ${cardStateClass}`;
    card.innerHTML = `
      <div>
        <div class="hp-card-top">
          <div class="hp-identity">
            <span class="hp-dot" style="background:${dev.color}"></span>
            <span>${dev.displayName}</span>
            <span class="hp-devid">(${dev.deviceId})</span>
          </div>
          ${statusPillHtml}
        </div>

        ${zoneBoxHtml}

        <div class="telemetry-showcase">
          ${speedoHtml}
          <div class="mini-metrics-grid">
            <div class="mini-metric">
              <span class="lbl">Getaran</span>
              <span class="val" style="color:#fbbf24">${(d.accel_rms || 0).toFixed(2)} m/s²</span>
            </div>
            <div class="mini-metric">
              <span class="lbl">Baterai HP</span>
              <span class="val" style="color:#34d399">🔋 ${d.battery_pct !== undefined ? d.battery_pct + '%' : '--'}</span>
            </div>
            <div class="mini-metric">
              <span class="lbl">Jarak Safezone</span>
              <span class="val" style="color:${isBreach ? '#f87171' : '#e5e7eb'}">${(d.distance_m || 0).toFixed(1)} m</span>
            </div>
            <div class="mini-metric">
              <span class="lbl">Jam Update</span>
              <span class="val mono" style="color:#f3f4f6">${updateClock}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="hp-card-actions">
        <button class="btn-set-sz" onclick="lockSafezoneFromMonitor('${dev.deviceId}')">
          🎯 Set Safezone <i class="fa-solid fa-lock" style="font-size:9px"></i>
        </button>
        <button class="btn-perm-sz ${dev.canPhoneEditSafezone ? 'aktif' : ''}" onclick="togglePhoneSafezonePermission('${dev.deviceId}')">
          ${dev.canPhoneEditSafezone ? '🔓 Izin SZ & Peran: ON' : '🔒 Beri Izin HP'}
        </button>
        <button class="btn-rename" onclick="promptRenameDeviceOnMonitor('${dev.deviceId}')" title="Ganti Nama (Butuh Sandi)">
          ✏️ Nama
        </button>
        <button class="btn-kick" onclick="kickDeviceFromMonitor('${dev.deviceId}')" title="Putuskan koneksi (Butuh Sandi)">
          ⚡ Kick
        </button>
        <button class="btn-block" onclick="blockDeviceFromMonitor('${dev.deviceId}')" title="Blokir perangkat (Butuh Sandi)">
          🚫 Blokir
        </button>
      </div>
    `;
    grid.appendChild(card);
  });
}

function renderHistoryGrid() {
  const grid = $('historyGrid');
  const items = Object.entries(historyCache);
  if (!items.length) {
    grid.innerHTML = `
      <div class="hp-card history-card" style="grid-column: 1 / -1; text-align:center; padding: 22px;">
        <p style="color:#9ca3af; font-size:13px;">Belum ada riwayat perangkat yang terputus di dalam cache.</p>
      </div>`;
    return;
  }

  grid.innerHTML = items.map(([key, item]) => {
    const lastLoc = item.lastData && item.lastData.location
      ? `${item.lastData.location.latitude.toFixed(6)}, ${item.lastData.location.longitude.toFixed(6)}`
      : "Tidak ada koordinat";
    const szText = item.safezone
      ? `${item.safezone.lat.toFixed(5)}, ${item.safezone.lon.toFixed(5)} (&le;${item.safezone.radius}m)`
      : "Belum diset";

    const recentCoordsHtml = (item.coordHistory || []).slice(0, 3).map(c => `
      <div style="display:flex; justify-content:space-between; font-size:11px; padding:3px 0; border-bottom:1px dashed #1f2937;">
        <span class="mono" style="color:#fde047">${c.coord}</span>
        <span style="color:#9ca3af">${c.speed} km/j &middot; ${c.time}</span>
      </div>
    `).join('') || `<div style="font-size:11px; color:#6b7280;">Belum ada riwayat titik lokasi.</div>`;

    return `
      <div class="hp-card history-card">
        <div>
          <div class="hp-card-top">
            <div class="hp-identity">
              <span class="hp-dot" style="background:${item.color || '#9ca3af'}"></span>
              <span>${item.displayName}</span>
              <span class="hp-devid">(${item.lastDeviceId})</span>
            </div>
            <span class="status-pill abu"><i class="fa-solid fa-plug-circle-xmark"></i> Offline (${item.disconnectedAt})</span>
          </div>

          <div style="background:#0b0f19; border:1px solid #1f2937; border-radius:9px; padding:10px; margin-bottom:10px; font-size:11.5px;">
            <div style="color:#9ca3af; margin-bottom:4px;"><strong>Alasan:</strong> ${item.reason || 'Timeout 10s'}</div>
            <div style="color:#a7f3d0; margin-bottom:4px;"><strong>Safezone Tersimpan:</strong> <span class="mono">${szText}</span></div>
            <div style="color:#e5e7eb; margin-bottom:6px;">
              <strong>Koordinat Terakhir:</strong> <span class="mono" style="color:#fbbf24">${lastLoc}</span>
              <button class="btn-outline-xs" style="margin-left:6px;" onclick="salinKoordinat('${lastLoc}')">Copy</button>
            </div>
            <div style="color:#38bdf8; font-weight:700; margin-bottom:3px;">Riwayat Koordinat di Cache (${(item.coordHistory || []).length} titik):</div>
            ${recentCoordsHtml}
          </div>
        </div>

        <div class="hp-card-actions">
          <span style="font-size:11px; color:#9ca3af;"><i class="fa-solid fa-rotate"></i> Auto-Restore saat <strong>${item.displayName}</strong> terhubung lagi</span>
          <button class="btn-block" style="margin-left:auto;" onclick="deleteSingleHistoryCache('${key}')">
            <i class="fa-solid fa-trash"></i> Hapus Cache
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Fitur receh / lokal (Bersihkan History & Log) tidak membutuhkan sandi
function deleteSingleHistoryCache(key) {
  delete historyCache[key];
  saveHistoryToStorage();
  updateMonitorSummaryStats();
  renderHistoryGrid();
  tampilToast('Cache riwayat perangkat dihapus.', 'info');
}

function clearAllHistoryCache() {
  historyCache = {};
  saveHistoryToStorage();
  updateMonitorSummaryStats();
  renderHistoryGrid();
  tampilToast('Seluruh History Cache berhasil dibersihkan.', 'sukses');
}

function salinKoordinat(teks) {
  const temp = document.createElement('textarea');
  temp.value = teks;
  document.body.appendChild(temp);
  temp.select();
  document.execCommand('copy');
  document.body.removeChild(temp);
  tampilToast('Koordinat disalin: ' + teks, 'sukses');
}

function updateMonitorStopwatches() {
  const nowStr = new Date().toLocaleTimeString('id-ID');
  Object.values(devicesRegistry).forEach((dev) => {
    if (dev.breachStartMs) {
      const tEl = $(`timer_${dev.deviceId}`);
      const cEl = $(`clock_${dev.deviceId}`);
      if (tEl) tEl.textContent = formatDurationMs(Date.now() - dev.breachStartMs);
      if (cEl) cEl.textContent = nowStr;
    }
  });
}

function lockSafezoneFromMonitorInternal(devId) {
  const dev = devicesRegistry[devId];
  if (!dev || !dev.lastData || !dev.lastData.location) return;
  const maxRad = Math.min(10, parseFloat($('safezoneRadiusInput').value) || 10);
  dev.safezone = {
    lat: dev.lastData.location.latitude,
    lon: dev.lastData.location.longitude,
    radius: maxRad
  };
  dev.breachStartMs = null;
  dev.lastData.distance_m = 0;
  dev.lastData.is_outside_safezone = false;
  sendControlToPhone(devId, { action: "SET_SAFEZONE", safezone: dev.safezone });
  updateMonitorSummaryStats();
  renderDevicesGrid();
  renderFloatingMiniMonitor();
  tampilToast(`Safezone ${dev.displayName} dikunci (Radius maks ${maxRad}m).`, 'sukses');
}

function lockSafezoneFromMonitor(devId) {
  const dev = devicesRegistry[devId];
  if (!dev) return;
  requireMonitorPassword(
    `Masukkan Sandi Master Monitor untuk menetapkan/mereset titik Safezone "${dev.displayName}":`,
    () => lockSafezoneFromMonitorInternal(devId)
  );
}

function requestResetAllSafezonesWithAuth() {
  requireMonitorPassword(
    "Masukkan Sandi Master Monitor untuk mengunci ulang seluruh titik Safezone perangkat HP:",
    () => {
      Object.keys(devicesRegistry).forEach(devId => lockSafezoneFromMonitorInternal(devId));
    }
  );
}

function togglePhoneSafezonePermission(devId) {
  const dev = devicesRegistry[devId];
  if (!dev) return;
  requireMonitorPassword(
    `Masukkan Sandi Master Monitor untuk mengubah hak akses Safezone & Ganti Peran pada "${dev.displayName}":`,
    () => {
      dev.canPhoneEditSafezone = !dev.canPhoneEditSafezone;
      dev.canPhoneSwitchRole = dev.canPhoneEditSafezone;
      sendControlToPhone(devId, {
        action: "SAFEZONE_PERMISSION",
        allowed: dev.canPhoneEditSafezone,
        can_switch_role: dev.canPhoneSwitchRole,
        radius: Math.min(10, parseFloat($('safezoneRadiusInput').value) || 10)
      });
      renderDevicesGrid();
      tampilToast(
        dev.canPhoneEditSafezone
          ? `Akses ubah Safezone & Ganti Peran diberikan ke ${dev.displayName}`
          : `Akses dicabut dari ${dev.displayName}`,
        'info'
      );
    }
  );
}

function promptRenameDeviceOnMonitor(devId) {
  const dev = devicesRegistry[devId];
  if (!dev) return;
  requireMonitorPassword(
    `Masukkan Nama Baru dan Sandi Master Monitor untuk mengganti identitas "${dev.displayName}":`,
    (newName) => {
      if (!newName) return;
      const oldKey = dev.displayName.toLowerCase();
      dev.displayName = newName;
      removeDatasetFromCharts(oldKey);
      sendControlToPhone(devId, { action: "RENAME_DEVICE", new_name: dev.displayName });
      renderDevicesGrid();
      renderFloatingMiniMonitor();
      tampilToast(`Nama perangkat berhasil diubah menjadi ${dev.displayName}`, 'sukses');
    },
    {
      label: "Nama Identitas HP Baru",
      defaultValue: dev.displayName,
      placeholder: "Contoh: HP Kurir 01"
    }
  );
}

function broadcastConfigUpdate() {
  if (!mqttClient || !mqttClient.connected) return;
  const maxRad = Math.min(10, parseFloat($('safezoneRadiusInput').value) || 10);
  const speedLim = parseFloat($('thresholdInput').value) || 2.5;
  Object.keys(devicesRegistry).forEach(devId => {
    if (devicesRegistry[devId].safezone) devicesRegistry[devId].safezone.radius = maxRad;
    sendControlToPhone(devId, { action: "UPDATE_RADIUS", radius: maxRad, threshold: speedLim });
  });
}

function sendControlToPhone(devId, payload) {
  if (!mqttClient || !mqttClient.connected) return;
  mqttClient.publish(`${getTopicBase()}/edge/${devId}/control`, JSON.stringify(payload), { qos: 1 });
}

function appendAlertLog(dev, data) {
  alertLogCount++;
  $('logCountBadge').textContent = `${alertLogCount} Kejadian`;
  const tbody = $('alertLogBody');
  if (alertLogCount === 1) tbody.innerHTML = "";

  const coordStr = `${data.location.latitude.toFixed(6)}, ${data.location.longitude.toFixed(6)}`;
  const mapsUrl = `https://www.google.com/maps?q=${data.location.latitude.toFixed(6)},${data.location.longitude.toFixed(6)}`;
  const durationStr = dev.breachStartMs ? formatDurationMs(Date.now() - dev.breachStartMs) : "00:00:00";

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="mono">${new Date().toLocaleTimeString('id-ID')}</td>
    <td><strong style="color:${dev.color}">${dev.displayName}</strong></td>
    <td><span class="status-pill merah">HP Bergerak</span></td>
    <td><strong style="color:#f87171">${data.distance_m.toFixed(1)} m</strong></td>
    <td class="mono" style="color:#fbbf24">${durationStr}</td>
    <td><strong style="color:#38bdf8">${(data.speed_kmh || 0).toFixed(1)} km/j</strong></td>
    <td>${(data.accel_rms || 0).toFixed(2)} m/s²</td>
    <td style="color:#34d399">🔋 ${data.battery_pct}%</td>
    <td class="mono" style="color:#fde047">${coordStr}</td>
    <td>
      <button class="btn-outline-xs" onclick="salinKoordinat('${coordStr}')">Copy</button>
      <a href="${mapsUrl}" target="_blank" class="btn-outline-xs light">Maps</a>
    </td>
  `;
  tbody.prepend(tr);
}

// Fitur Bersihkan Log bebas diakses tanpa sandi
function resetMonitorLogsAndCharts() {
  alertLogCount = 0;
  $('logCountBadge').textContent = "0 Kejadian";
  $('alertLogBody').innerHTML = `<tr><td colspan="10" style="text-align:center; color:#9ca3af; padding:20px;">Log dan grafik berhasil dibersihkan.</td></tr>`;
  [speedChart, rmsChart, distChart].forEach(c => {
    c.data.labels = [];
    c.data.datasets.forEach(ds => ds.data = []);
    c.update();
  });
  tampilToast('Log peringatan dan grafik telah dibersihkan.', 'info');
}

// ==================== MODE 2: HP EDGE SENSOR (TERKUNCI ANTI-THEFT) ====================
async function initBatteryReader() {
  if (navigator.getBattery) {
    try {
      const bat = await navigator.getBattery();
      batteryPct = Math.round(bat.level * 100);
      $('eBattery').textContent = batteryPct + "%";
      bat.addEventListener('levelchange', () => {
        batteryPct = Math.round(bat.level * 100);
        $('eBattery').textContent = batteryPct + "%";
      });
    } catch (e) {}
  } else {
    $('eBattery').textContent = batteryPct + "%";
  }
}

function requestStopEdgeWithAuth() {
  requireMonitorPassword(
    "Masukkan Sandi Master Monitor untuk MEMUTUSKAN transmisi pelacakan pada HP ini:",
    () => stopEdgeNodeInternal(true)
  );
}

function requestReconnectEdgeWithAuth() {
  requireMonitorPassword(
    "Masukkan Sandi Master Monitor untuk MENGHUBUNGKAN ULANG sensor HP ini ke Monitor:",
    () => startEdgeNode()
  );
}

async function startEdgeNode() {
  stopEdgeNodeInternal(false);
  currentMode = 'edge';
  if (phoneCustomName) $('eDisplayName').textContent = phoneCustomName;

  await initBatteryReader();

  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    try { await DeviceMotionEvent.requestPermission(); } catch (e) {}
  }
  window.addEventListener('devicemotion', onPhoneMotion);

  if (navigator.geolocation) {
    navigator.geolocation.watchPosition((pos) => {
      latestLat = pos.coords.latitude;
      latestLon = pos.coords.longitude;
      if (pos.coords.speed !== null && !isNaN(pos.coords.speed)) {
        gpsSpeedKmh = pos.coords.speed * 3.6;
      }
      $('eCoords').textContent = `${latestLat.toFixed(6)}, ${latestLon.toFixed(6)}`;
    }, () => {
      $('eCoords').textContent = `${latestLat.toFixed(6)}, ${latestLon.toFixed(6)}`;
    }, { enableHighAccuracy: true, maximumAge: 0 });
  }

  connectMqtt(() => {
    const controlTopic = `${getTopicBase()}/edge/${sessionDeviceId}/control`;
    const beaconTopic = `${getTopicBase()}/monitor_status`;
    mqttClient.subscribe([controlTopic, beaconTopic], { qos: 1 });

    mqttClient.on('message', (topic, message) => {
      try {
        const data = JSON.parse(message.toString());
        if (topic === controlTopic) {
          handleControlFromMonitorOnPhone(data);
        } else if (topic === beaconTopic && data.pwd_hash) {
          masterPasswordHash = data.pwd_hash;
        }
      } catch (e) {}
    });

    publishEdgeTelemetry();
    const intervalSec = Math.max(1, parseInt($('intervalInput').value) || 2);
    publishTimer = setInterval(publishEdgeTelemetry, intervalSec * 1000);

    $('btnStartEdge').disabled = true;
    $('btnStopEdge').disabled = false;
    $('edgeStatusBadge').textContent = "TERHUBUNG & TERKUNCI";
    $('edgeStatusBadge').style.background = "#10b981";
    $('edgeStatusBadge').style.color = "#fff";
    tampilToast('Sensor HP aktif & terkunci ke Monitor.', 'sukses');
  });
}

function handleControlFromMonitorOnPhone(cmd) {
  if (cmd.action === "FORCE_DISCONNECT") {
    stopEdgeNodeInternal(false);
    $('edgeStatusBadge').textContent = "DIPUTUS MONITOR";
    $('edgeStatusBadge').style.background = "#dc2626";
    $('edgeStatusBadge').style.color = "#fff";
    tampilToast(cmd.reason || "Koneksi diputus oleh Monitor.", 'error');
    return;
  }
  if (cmd.action === "ASSIGN_AUTO_NAME" && !phoneCustomName) {
    assignedAutoName = cmd.auto_name;
    $('eDisplayName').textContent = assignedAutoName;
  }
  if (cmd.action === "RENAME_DEVICE") {
    phoneCustomName = cmd.new_name;
    $('customPhoneName').value = phoneCustomName;
    $('eDisplayName').textContent = phoneCustomName;
    const saved = JSON.parse(localStorage.getItem(EDGE_CFG_KEY) || "{}");
    saved.name = phoneCustomName;
    localStorage.setItem(EDGE_CFG_KEY, JSON.stringify(saved));
    tampilToast(`Identitas HP diubah oleh Monitor menjadi: ${phoneCustomName}`, 'info');
  }
  if (cmd.action === "SET_SAFEZONE") {
    mySafezone = cmd.safezone;
    updateEdgeSafezoneBanner();
    tampilToast('Titik Safezone dikunci/dipulihkan oleh Monitor.', 'sukses');
  }
  if (cmd.action === "SAFEZONE_PERMISSION") {
    canPhoneSetSafezone = !!cmd.allowed;
    canPhoneSwitchRole = !!cmd.can_switch_role;
    const btnSz = $('btnSetSafezoneEdge');
    btnSz.disabled = !canPhoneSetSafezone;
    btnSz.innerHTML = canPhoneSetSafezone
      ? `<i class="fa-solid fa-location-crosshairs"></i> Set Safezone (Diizinkan Monitor)`
      : `<i class="fa-solid fa-lock"></i> Set Safezone (Menunggu Izin Monitor)`;

    const btnRole = $('btnEdgeSwitchRole');
    btnRole.disabled = !canPhoneSwitchRole;
    btnRole.innerHTML = canPhoneSwitchRole
      ? `<i class="fa-solid fa-unlock"></i> Ganti Peran (Diizinkan Monitor)`
      : `<i class="fa-solid fa-lock"></i> Ganti Peran (Menunggu Izin Monitor)`;
    updateEdgeSafezoneBanner();
  }
  if (cmd.action === "UPDATE_RADIUS") {
    if (mySafezone && cmd.radius) mySafezone.radius = cmd.radius;
    if (cmd.threshold !== undefined) $('thresholdInput').value = cmd.threshold;
    if (cmd.radius !== undefined) $('safezoneRadiusInput').value = cmd.radius;
    updateEdgeSafezoneBanner();
  }
}

function setSafezoneFromPhone() {
  if (!canPhoneSetSafezone) return;
  requireMonitorPassword(
    "Masukkan Sandi Master Monitor untuk mengunci titik Safezone baru dari HP ini:",
    () => {
      const maxRad = Math.min(10, parseFloat($('safezoneRadiusInput').value) || 10);
      mySafezone = { lat: latestLat, lon: latestLon, radius: maxRad };
      updateEdgeSafezoneBanner();
      publishEdgeTelemetry(true);
      tampilToast('Safezone berhasil dikunci dari HP!', 'sukses');
    }
  );
}

function updateEdgeSafezoneBanner() {
  const box = $('edgeSafezoneAlert');
  if (mySafezone) {
    box.innerHTML = `✅ <strong>Safezone Aktif:</strong> Terkunci pada <code class="mono">${mySafezone.lat.toFixed(6)}, ${mySafezone.lon.toFixed(6)}</code> (Radius Maks ${mySafezone.radius}m).`;
  } else if (canPhoneSetSafezone) {
    box.innerHTML = `🔓 <strong>Akses Diberikan Monitor!</strong> Anda kini dapat menekan tombol <em>"Set Safezone"</em> atau <em>"Ganti Peran"</em> (dengan verifikasi Sandi Monitor).`;
  } else {
    box.innerHTML = `🔒 <strong>Proteksi Anti-Theft Aktif:</strong> Seluruh parameter jaringan dikunci. Hanya Monitor yang dapat mengubah Safezone atau memberikan izin akses.`;
  }
}

function onPhoneMotion(e) {
  if (currentMode !== 'edge') return;
  const acc = e.accelerationIncludingGravity;
  if (!acc || acc.x === null) return;
  const mag = Math.sqrt(acc.x*acc.x + acc.y*acc.y + acc.z*acc.z);
  accelWindow.push(Math.abs(mag - 9.81));
  if (accelWindow.length > 15) accelWindow.shift();
  const sumSq = accelWindow.reduce((a, b) => a + b*b, 0);
  latestRms = Math.sqrt(sumSq / accelWindow.length);

  const walkSpeed = latestRms > 0.35 ? Math.min(14, latestRms * 3.2) : 0;
  const speed = Math.max(gpsSpeedKmh, walkSpeed);
  const limit = parseFloat($('thresholdInput').value) || 2.5;

  $('eRms').textContent = latestRms.toFixed(2);
  $('edgeLocalSpeedo').innerHTML = buildSpeedometerSvg(speed, limit);
}

function publishEdgeTelemetry(sendPhoneSafezone = false) {
  if (!mqttClient || !mqttClient.connected) return;
  const walkSpeed = latestRms > 0.35 ? Math.min(14, latestRms * 3.2) : 0;
  const speedKmh = parseFloat(Math.max(gpsSpeedKmh, walkSpeed).toFixed(2));
  const rmsVal = parseFloat(latestRms.toFixed(2));
  const limit = parseFloat($('thresholdInput').value) || 2.5;

  $('edgeLocalSpeedo').innerHTML = buildSpeedometerSvg(speedKmh, limit);

  if (mySafezone) {
    const distM = haversineMeters(mySafezone.lat, mySafezone.lon, latestLat, latestLon);
    $('eDist').textContent = distM.toFixed(1);
    const badge = $('edgeStatusBadge');
    if (distM > mySafezone.radius) {
      badge.textContent = "🔴 HP BERGERAK (KELUAR SAFEZONE)";
      badge.style.background = "#dc2626";
      badge.style.color = "#fff";
    } else {
      badge.textContent = "🟢 AMAN (DI DALAM SAFEZONE)";
      badge.style.background = "#10b981";
      badge.style.color = "#fff";
    }
  }

  const payload = {
    device_id: sessionDeviceId,
    custom_name: phoneCustomName,
    speed_kmh: speedKmh,
    accel_rms: rmsVal,
    battery_pct: batteryPct,
    location: {
      latitude: parseFloat(latestLat.toFixed(6)),
      longitude: parseFloat(latestLon.toFixed(6))
    },
    phone_safezone: sendPhoneSafezone && mySafezone ? mySafezone : null,
    timestamp: Date.now()
  };

  mqttClient.publish(`${getTopicBase()}/edge/${sessionDeviceId}/telemetry`, JSON.stringify(payload), { qos: 1 });
}

function stopEdgeNodeInternal(notifyMonitor = false) {
  window.removeEventListener('devicemotion', onPhoneMotion);
  if (publishTimer) { clearInterval(publishTimer); publishTimer = null; }
  if (notifyMonitor && mqttClient && mqttClient.connected) {
    try {
      mqttClient.publish(`${getTopicBase()}/edge/${sessionDeviceId}/offline`, JSON.stringify({ device_id: sessionDeviceId }), { qos: 1 });
    } catch (e) {}
  }
  if (mqttClient && currentMode === 'edge') { try { mqttClient.end(true); } catch(e){} mqttClient = null; }
  $('btnStartEdge').disabled = false;
  $('btnStopEdge').disabled = true;
  $('edgeStatusBadge').textContent = "TERPUTUS (LOCKED)";
  $('edgeStatusBadge').style.background = "#fff";
  $('edgeStatusBadge').style.color = "#ea580c";
}