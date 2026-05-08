/* global supabase */

// ─── Supabase Projets ────────────────────────────────────────────────────────
const SUPABASE_URL = "https://fjuwemzbsiwxvlajdckx.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqdXdlbXpic2l3eHZsYWpkY2t4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNzQ2OTAsImV4cCI6MjA5Mjg1MDY5MH0.QALJfDIWnAgY174aYkT3xXtB3ZzUsBftyoDusQV30fE";

const SUPABASE_WATCH_URL = "https://lzuoubzegbfelrftgpqt.supabase.co";
const SUPABASE_WATCH_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6dW91YnplZ2JmZWxyZnRncHF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MjA2OTYsImV4cCI6MjA5MzM5NjY5Nn0.BE2BAtNMTcjJt702Dbrvw3aShJNGsFWM1x3ILbSzCLU";

let supabaseClient = null;
let supabaseReady = false;
let syncId = localStorage.getItem("sv_sync_id") || "";
let pendingSync = null;

let supabaseWatch = null;
let watchChannel = null;
let isWatchHost = false;
let watchSessionCode = null;
let watchSyncInterval = null;
let usePrecisionMode = false;

// Initialisation Supabase principal
try {
  supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  if (!syncId) {
    syncId = 'sv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem("sv_sync_id", syncId);
  }
  supabaseReady = true;
  console.log("✅ Supabase Progression connecté");
} catch(e) {
  console.warn("⚠ Supabase Progression non disponible");
}

// Initialisation Supabase Watch Together
try {
  supabaseWatch = supabase.createClient(SUPABASE_WATCH_URL, SUPABASE_WATCH_KEY);
  console.log("✅ Supabase Watch connecté");
} catch(e) {
  console.warn("⚠ Supabase Watch non disponible");
}

// ─── Sync Cloud ──────────────────────────────────────────────────────────────
async function syncToCloud() {
  if (!supabaseReady || !supabaseClient) return;
  const progress = { resume: getResume(), watched: getWatched(), timecodes: getTimecodes() };
  try {
    await supabaseClient.from('progress').upsert({ id: syncId, data: progress, updated_at: new Date().toISOString() });
    console.log("☁️ Sync OK");
  } catch(e) {
    console.warn("⚠ Sync échoué:", e.message);
  }
}

function saveWithSync() {
  localStorage.setItem("sv_last_sync", Date.now().toString());
  if (pendingSync) clearTimeout(pendingSync);
  pendingSync = setTimeout(() => { syncToCloud(); pendingSync = null; }, 1000);
}

// ─── Force Sync ─────────────────────────────────────────────────────────────
async function forceSyncNow() {
  if (!supabaseReady || !supabaseClient) { alert("⚠ Supabase non connecté"); return; }
  try {
    const { data, error } = await supabaseClient.from('progress').select('data, updated_at').eq('id', syncId).single();
    if (error || !data) {
      console.log("☁️ Aucune donnée cloud, envoi local...");
      await syncToCloud();
      alert("✅ Données locales envoyées !");
      return;
    }
    if (confirm("☁️ Écraser les données locales par le cloud et recharger ?")) {
      localStorage.setItem(RESUME_KEY, JSON.stringify(data.data.resume || {}));
      localStorage.setItem(WATCHED_KEY, JSON.stringify(data.data.watched || []));
      localStorage.setItem(TIMECODE_KEY, JSON.stringify(data.data.timecodes || {}));
      localStorage.setItem("sv_last_sync", Date.now().toString());
      await syncToCloud();
      location.reload();
    }
  } catch(e) { alert("❌ Erreur: " + e.message); }
}

// ─── Link Device ─────────────────────────────────────────────────────────────
function openLinkDeviceMenu() {
  document.getElementById("linkDeviceMyId").textContent = syncId;
  document.getElementById("linkDeviceOverlay").classList.add("active");
}
function closeLinkDeviceMenu() { document.getElementById("linkDeviceOverlay").classList.remove("active"); }
function copySyncId() {
  navigator.clipboard.writeText(syncId).then(() => alert("📋 ID copié !")).catch(() => prompt("Copie manuelle :", syncId));
}

async function linkById() {
  const targetId = document.getElementById("linkDeviceIdInput").value.trim();
  if (!targetId.startsWith("sv_")) { alert("❌ ID invalide"); return; }
  if (targetId === syncId) { alert("❌ C'est déjà ton ID !"); return; }
  if (!supabaseReady || !supabaseClient) { alert("⚠ Supabase non connecté"); return; }
  try {
    const { data: targetData, error } = await supabaseClient.from('progress').select('data').eq('id', targetId).single();
    if (error || !targetData?.data) { alert("❌ Appareil introuvable"); return; }
    if (!confirm("⚠ Remplacer tes données locales par celles de l'autre appareil ?")) return;
    const cloud = targetData.data;
    localStorage.setItem(RESUME_KEY, JSON.stringify(cloud.resume || {}));
    localStorage.setItem(WATCHED_KEY, JSON.stringify(cloud.watched || []));
    localStorage.setItem(TIMECODE_KEY, JSON.stringify(cloud.timecodes || {}));
    localStorage.setItem("sv_sync_id", targetId);
    syncId = targetId;
    localStorage.setItem("sv_last_sync", Date.now().toString());
    closeLinkDeviceMenu();
    alert("✅ Appareils liés ! Rechargement...");
    location.reload();
  } catch(e) { alert("❌ Erreur: " + e.message); }
}

// ─── Watch Together ──────────────────────────────────────────────────────────
function generateWatchCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function copyWatchCode() { navigator.clipboard.writeText(watchSessionCode).then(() => alert("📋 " + watchSessionCode)); }

function startWatchMenu() {
  if (watchSessionCode) {
    document.getElementById("watchOverlay").classList.add("active");
    document.getElementById("watchMenu").style.display = "none";
    document.getElementById("watchHosting").style.display = "none";
    document.getElementById("watchGuest").style.display = "none";
    if (isWatchHost) {
      document.getElementById("watchHosting").style.display = "block";
      document.getElementById("watchCodeDisplay").textContent = watchSessionCode;
    } else {
      document.getElementById("watchGuest").style.display = "block";
      document.getElementById("watchGuestCode").textContent = watchSessionCode;
      document.getElementById("watchSyncMode").checked = usePrecisionMode;
    }
    return;
  }
  if (!currentVideo) { alert("🎬 Lance d'abord une vidéo"); return; }
  document.getElementById("watchMenu").style.display = "block";
  document.getElementById("watchHosting").style.display = "none";
  document.getElementById("watchGuest").style.display = "none";
  document.getElementById("watchOverlay").classList.add("active");
}

function closeWatchMenu() { document.getElementById("watchOverlay").classList.remove("active"); }

async function hostWatchSession() {
  if (!supabaseWatch || !currentVideo) return;
  watchSessionCode = generateWatchCode();
  isWatchHost = true;
  watchChannel = supabaseWatch.channel('session-' + watchSessionCode);
  watchChannel.subscribe((status) => { console.log("🎬 Hôte connecté:", status); });

  watchSyncInterval = setInterval(() => {
    if (!isWatchHost || !currentVideo) return;
    player.getPaused((paused) => {
      const tc = getTimecodes()[currentVideo.id] || 0;
      watchChannel.send({
        type: 'broadcast', event: 'sync',
        payload: { timecode: Math.floor(tc), videoId: currentVideo.id, sentAt: Date.now(), isPaused: paused }
      });
    });
  }, 3000);

  document.getElementById("watchMenu").style.display = "none";
  document.getElementById("watchHosting").style.display = "block";
  document.getElementById("watchCodeDisplay").textContent = watchSessionCode;
  document.getElementById("watchHostBadge").classList.add("active");
}

async function joinWatchSession() {
  if (!supabaseWatch) return;
  const code = document.getElementById("watchCodeInput").value.trim().toUpperCase();
  watchSessionCode = code;
  isWatchHost = false;
  watchChannel = supabaseWatch.channel('session-' + code);
  watchChannel.on('broadcast', { event: 'sync' }, (payload) => {
    if (isWatchHost) return;
    const { timecode, videoId, sentAt, isPaused } = payload.payload;
    if (videoId !== currentVideo?.id) {
      const vid = findVideoById(videoId);
      if (vid) loadVideo(vid);
      return;
    }
    if (player && currentVideo) {
      if (isPaused) { player.pause(); player.setCurrentTime(timecode); return; }
      player.play();
      const localTime = getTimecodes()[currentVideo.id] || 0;
      let targetTime = usePrecisionMode && sentAt ? timecode + (Date.now() - sentAt) / 1000 : timecode;
      if (Math.abs(localTime - targetTime) > 1) {
        console.log("▶ Sync lecture | cible:", targetTime.toFixed(1));
        player.setCurrentTime(targetTime);
      }
    }
  });
  watchChannel.subscribe((status) => {
    console.log("🔗 Invité connecté:", status);
    document.getElementById("watchMenu").style.display = "none";
    document.getElementById("watchGuest").style.display = "block";
    document.getElementById("watchGuestCode").textContent = code;
  });
}

function findVideoById(id) {
  for (const cK of Object.keys(data)) {
    for (const catK of Object.keys(data[cK].categories)) {
      const v = data[cK].categories[catK].videos.find(v => v.id === id);
      if (v) { creator = cK; category = catK; view = "videos"; return v; }
    }
  }
  return null;
}

async function leaveWatchSession() {
  if (watchSyncInterval) { clearInterval(watchSyncInterval); watchSyncInterval = null; }
  if (watchChannel) { await supabaseWatch.removeChannel(watchChannel); }
  watchChannel = null; watchSessionCode = null; isWatchHost = false; usePrecisionMode = false;
  document.getElementById("watchOverlay").classList.remove("active");
  document.getElementById("watchHostBadge").classList.remove("active");
}
async function stopWatchSession() { await leaveWatchSession(); }
function toggleSyncMode() { usePrecisionMode = document.getElementById("watchSyncMode").checked; }