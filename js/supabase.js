/* global supabase */

// ─── Configuration ────────────────────────────────────────────────────────────
const SUPABASE_URL       = "https://fjuwemzbsiwxvlajdckx.supabase.co";
const SUPABASE_KEY       = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqdXdlbXpic2l3eHZsYWpkY2t4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNzQ2OTAsImV4cCI6MjA5Mjg1MDY5MH0.QALJfDIWnAgY174aYkT3xXtB3ZzUsBftyoDusQV30fE";
const SUPABASE_WATCH_URL = "https://lzuoubzegbfelrftgpqt.supabase.co";
const SUPABASE_WATCH_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6dW91YnplZ2JmZWxyZnRncHF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MjA2OTYsImV4cCI6MjA5MzM5NjY5Nn0.BE2BAtNMTcjJt702Dbrvw3aShJNGsFWM1x3ILbSzCLU";

// Clés localStorage internes
const LS_SYNC_ID        = "sv_sync_id";
const LS_CLOUD_SYNCED   = "sv_cloud_synced";   // Timestamp du dernier push cloud RÉUSSI
const LS_LOCAL_UPDATED  = "sv_local_updated";  // Timestamp de la dernière modification locale
const LS_BOOT_RELOAD    = "sv_boot_reload";    // Flag anti-boucle de rechargement

// Timings
const SYNC_DEBOUNCE_MS      = 2000;   // Délai avant push après un changement local
const AUTO_PUSH_INTERVAL_MS = 60000;  // Push automatique toutes les 60s (filet de sécurité)
const MAX_RETRIES           = 3;      // Nombre max de tentatives en cas d'échec réseau

// ─── État global ──────────────────────────────────────────────────────────────
let supabaseClient  = null;
let supabaseReady   = false;
let syncId          = localStorage.getItem(LS_SYNC_ID) || "";
let pendingSync     = null;
let hasDirtyChanges = false;  // true si des changements locaux ne sont PAS encore dans le cloud
let isSyncing       = false;
let syncRetryCount  = 0;

// Watch Together
let supabaseWatch     = null;
let watchChannel      = null;
let isWatchHost       = false;
let watchSessionCode  = null;
let watchSyncInterval = null;
let usePrecisionMode  = false;

// ─── Migration : ancienne clé sv_last_sync → nouveau système ─────────────────
// Évite un faux "cloud plus récent" au premier démarrage avec ce nouveau code
if (!localStorage.getItem(LS_CLOUD_SYNCED) && localStorage.getItem("sv_last_sync")) {
  localStorage.setItem(LS_CLOUD_SYNCED, localStorage.getItem("sv_last_sync"));
}

// ─── Initialisation Supabase Progression ─────────────────────────────────────
try {
  supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  if (!syncId) {
    syncId = "sv_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem(LS_SYNC_ID, syncId);
  }
  supabaseReady = true;
  console.log("✅ Supabase Progression connecté");
} catch(e) {
  console.warn("⚠ Supabase Progression non disponible:", e.message);
}

// ─── Initialisation Supabase Watch Together ───────────────────────────────────
try {
  supabaseWatch = supabase.createClient(SUPABASE_WATCH_URL, SUPABASE_WATCH_KEY);
  console.log("✅ Supabase Watch connecté");
} catch(e) {
  console.warn("⚠ Supabase Watch non disponible:", e.message);
}

// ─── Bootstrap : pull automatique au démarrage ────────────────────────────────
// Compare le cloud et le local au démarrage. Si le cloud est plus récent
// (= l'autre appareil a regardé des trucs), applique silencieusement et recharge.
(async function bootSync() {
  if (!supabaseReady || !supabaseClient) return;

  // Anti-boucle : si on vient de recharger suite à un boot sync, on s'arrête là
  if (localStorage.getItem(LS_BOOT_RELOAD)) {
    localStorage.removeItem(LS_BOOT_RELOAD);
    syncLog("☁️ Synchronisation automatique appliquée au démarrage");
    console.log("✅ Boot sync OK");
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from("progress")
      .select("data, updated_at")
      .eq("id", syncId)
      .single();

    if (error || !data) return; // Pas encore de données cloud → on reste sur le local

    const cloudTime  = new Date(data.updated_at).getTime();
    const lastSynced = parseInt(localStorage.getItem(LS_CLOUD_SYNCED) || "0");
    const lastLocal  = parseInt(localStorage.getItem(LS_LOCAL_UPDATED) || "0");

    // Le cloud n'a rien de nouveau par rapport à notre dernier push
    if (cloudTime <= lastSynced) {
      console.log("✅ Local déjà synchronisé avec le cloud");
      return;
    }

    // Le cloud est plus récent. Est-ce qu'on a des changements locaux non pushés ?
    const hasUnsyncedLocal = lastLocal > lastSynced;

    if (hasUnsyncedLocal) {
      // Conflit : l'autre appareil a pushé ET on a des changements locaux non envoyés.
      // On ne touche à rien automatiquement, l'utilisateur devra faire une sync manuelle.
      syncLog("⚠️ Données cloud disponibles. Utilise 'Forcer sync' pour récupérer.");
      console.warn("⚠ Boot sync: conflit local/cloud détecté, sync manuelle nécessaire");
      return;
    }

    // Aucun conflit : le cloud a du nouveau, on l'applique et on recharge une fois
    _applyCloudData(data.data);
    localStorage.setItem(LS_CLOUD_SYNCED, cloudTime.toString());
    localStorage.setItem(LS_BOOT_RELOAD, "1"); // Flag anti-boucle
    console.log("☁️ Boot sync: données cloud plus récentes, rechargement...");
    location.reload();

  } catch(e) {
    // Pas de connexion, erreur réseau, etc. → on continue normalement avec le local
    console.warn("⚠ Boot sync échoué (probablement hors-ligne):", e.message);
  }
})();

// ─── Listeners de fiabilité ───────────────────────────────────────────────────

// Sur mobile : flush quand l'app passe en arrière-plan (changement d'app, onglet masqué)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && hasDirtyChanges) {
    _flushSync();
  }
});

// Sur desktop : flush quand la page/onglet se ferme
window.addEventListener("beforeunload", () => {
  if (hasDirtyChanges) _flushSync();
});

// Filet de sécurité : push automatique toutes les 60s si des changements sont en attente
setInterval(() => {
  if (hasDirtyChanges && !isSyncing) pushToCloud();
}, AUTO_PUSH_INTERVAL_MS);

// ─── Appliquer données cloud en local ────────────────────────────────────────
function _applyCloudData(cloudData) {
  if (!cloudData) return;
  if (cloudData.resume)    localStorage.setItem(RESUME_KEY,   JSON.stringify(cloudData.resume));
  if (cloudData.watched)   localStorage.setItem(WATCHED_KEY,  JSON.stringify(cloudData.watched));
  if (cloudData.timecodes) localStorage.setItem(TIMECODE_KEY, JSON.stringify(cloudData.timecodes));
}

// ─── Push local → cloud (avec retry automatique) ─────────────────────────────
async function pushToCloud() {
  if (!supabaseReady || !supabaseClient || isSyncing) return false;
  isSyncing = true;

  const progress = {
    resume:    getResume(),
    watched:   getWatched(),
    timecodes: getTimecodes()
  };

  try {
    const { error } = await supabaseClient
      .from("progress")
      .upsert({ id: syncId, data: progress, updated_at: new Date().toISOString() });

    if (error) throw new Error(error.message);

    // ✅ Succès
    hasDirtyChanges = false;
    syncRetryCount  = 0;
    const ts = Date.now();
    localStorage.setItem(LS_CLOUD_SYNCED, ts.toString());
    syncLog("☁️ Sync cloud OK – " + Object.keys(progress.resume).length + " reprises sauvegardées");
    console.log("☁️ Push OK à", new Date(ts).toLocaleTimeString());
    return true;

  } catch(e) {
    syncRetryCount++;
    console.warn(`⚠ Push cloud échoué (tentative ${syncRetryCount}/${MAX_RETRIES}):`, e.message);

    if (syncRetryCount <= MAX_RETRIES) {
      const delay = 5000 * syncRetryCount; // 5s, 10s, 15s
      syncLog(`⚠️ Sync échouée – nouvelle tentative dans ${delay / 1000}s`);
      setTimeout(pushToCloud, delay);
    } else {
      syncRetryCount = 0;
      syncLog("❌ Sync impossible après " + MAX_RETRIES + " tentatives – données conservées en local");
    }
    return false;

  } finally {
    isSyncing = false;
  }
}

// ─── Flush sync via fetch keepalive ───────────────────────────────────────────
// fetch avec keepalive : le navigateur TERMINE la requête même si la page se ferme.
// C'est la seule méthode fiable pour envoyer des données dans beforeunload/visibilitychange.
function _flushSync() {
  if (!supabaseReady || !SUPABASE_KEY) return;

  const progress = {
    resume:    getResume(),
    watched:   getWatched(),
    timecodes: getTimecodes()
  };

  fetch(`${SUPABASE_URL}/rest/v1/progress`, {
    method:    "POST",
    keepalive: true, // ← la clé : survit à la fermeture de page
    headers: {
      "Content-Type":  "application/json",
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Prefer":        "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      id:         syncId,
      data:       progress,
      updated_at: new Date().toISOString()
    })
  })
  .then(() => {
    hasDirtyChanges = false;
    localStorage.setItem(LS_CLOUD_SYNCED, Date.now().toString());
    console.log("☁️ Flush sync OK (keepalive)");
  })
  .catch(e => console.warn("⚠ Flush sync échoué:", e.message));
}

// ─── saveWithSync : appelé à chaque changement local ─────────────────────────
// Remplace l'ancien saveWithSync. Même signature, comportement fiabilisé.
function saveWithSync() {
  // 1. Marquer qu'on a des changements non envoyés au cloud
  hasDirtyChanges = true;
  localStorage.setItem(LS_LOCAL_UPDATED, Date.now().toString());

  // 2. Debounce : attendre 2s sans nouveau changement avant de pusher
  //    (évite de spammer Supabase pendant le scrub d'une vidéo ou un tick de timecode)
  if (pendingSync) clearTimeout(pendingSync);
  pendingSync = setTimeout(() => {
    pendingSync = null;
    pushToCloud();
  }, SYNC_DEBOUNCE_MS);
}

// ─── forceSyncNow : bouton manuel ─────────────────────────────────────────────
async function forceSyncNow() {
  if (!supabaseReady || !supabaseClient) {
    alert("⚠ Supabase non connecté");
    return;
  }

  // Étape 1 : pousser les changements locaux en attente AVANT de lire le cloud
  // (évite de perdre des données si on a avancé sur cet appareil aussi)
  if (hasDirtyChanges || pendingSync) {
    if (pendingSync) { clearTimeout(pendingSync); pendingSync = null; }
    syncLog("⬆️ Envoi des modifications locales...");
    const pushed = await pushToCloud();
    if (!pushed) {
      alert("❌ Impossible d'envoyer tes données locales.\nVérifie ta connexion et réessaie.");
      return;
    }
  }

  // Étape 2 : lire les données cloud
  syncLog("⬇️ Lecture des données cloud...");
  let cloudRow;
  try {
    const { data, error } = await supabaseClient
      .from("progress")
      .select("data, updated_at")
      .eq("id", syncId)
      .single();

    if (error) throw new Error(error.message);
    cloudRow = data;
  } catch(e) {
    // ⚠ JAMAIS uploader en cas d'erreur de lecture — on ne risque pas d'écraser le cloud
    syncLog("❌ Impossible de lire le cloud: " + e.message);
    alert("❌ Impossible de lire le cloud.\nRéessaie dans quelques secondes.");
    return;
  }

  if (!cloudRow) {
    syncLog("☁️ Aucune donnée cloud — tes données locales viennent d'être envoyées");
    alert("ℹ️ Aucune donnée cloud trouvée.\nTes données locales ont été envoyées au cloud.");
    return;
  }

  // Étape 3 : comparer les timestamps pour savoir si le cloud a du nouveau
  const cloudTime  = new Date(cloudRow.updated_at).getTime();
  const lastSynced = parseInt(localStorage.getItem(LS_CLOUD_SYNCED) || "0");

  if (cloudTime > lastSynced) {
    // Le cloud a des données plus récentes → appliquer
    const cloudDate = new Date(cloudTime).toLocaleString();
    _applyCloudData(cloudRow.data);
    localStorage.setItem(LS_CLOUD_SYNCED, cloudTime.toString());
    localStorage.setItem(LS_BOOT_RELOAD, "1");
    syncLog("☁️ Données cloud du " + cloudDate + " appliquées");
    alert("✅ Synchronisation réussie !\nDonnées récupérées du " + cloudDate + ".");
    location.reload();
  } else {
    const syncDate = new Date(lastSynced).toLocaleString();
    syncLog("✅ Déjà à jour – dernière sync: " + syncDate);
    alert("✅ Déjà à jour !\nDernière synchronisation : " + syncDate);
  }
}

// ─── Liaison d'appareils ──────────────────────────────────────────────────────
function openLinkDeviceMenu() {
  document.getElementById("linkDeviceMyId").textContent = syncId;
  document.getElementById("linkDeviceOverlay").classList.add("active");
}

function closeLinkDeviceMenu() {
  document.getElementById("linkDeviceOverlay").classList.remove("active");
}

function copySyncId() {
  navigator.clipboard.writeText(syncId)
    .then(() => alert("📋 ID copié !"))
    .catch(() => prompt("Copie manuelle :", syncId));
}

async function linkById() {
  const targetId = document.getElementById("linkDeviceIdInput").value.trim();
  if (!targetId.startsWith("sv_"))       { alert("❌ ID invalide"); return; }
  if (targetId === syncId)                { alert("❌ C'est déjà ton ID !"); return; }
  if (!supabaseReady || !supabaseClient) { alert("⚠ Supabase non connecté"); return; }

  try {
    const { data: targetData, error } = await supabaseClient
      .from("progress")
      .select("data, updated_at")
      .eq("id", targetId)
      .single();

    if (error || !targetData?.data) { alert("❌ Appareil introuvable"); return; }

    const cloudDate = new Date(targetData.updated_at).toLocaleString();
    if (!confirm(`⚠ Relier cet appareil ?\n\nDonnées à récupérer du : ${cloudDate}`)) return;

    _applyCloudData(targetData.data);
    localStorage.setItem(LS_SYNC_ID,      targetId);
    localStorage.setItem(LS_CLOUD_SYNCED, new Date(targetData.updated_at).getTime().toString());
    syncId = targetId;
    hasDirtyChanges = false;

    closeLinkDeviceMenu();
    alert("✅ Appareils liés ! Rechargement...");
    location.reload();
  } catch(e) {
    alert("❌ Erreur: " + e.message);
  }
}

// ─── Watch Together ───────────────────────────────────────────────────────────
function generateWatchCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function copyWatchCode() {
  navigator.clipboard.writeText(watchSessionCode).then(() => alert("📋 " + watchSessionCode));
}

function startWatchMenu() {
  if (watchSessionCode) {
    document.getElementById("watchOverlay").classList.add("active");
    document.getElementById("watchMenu").style.display    = "none";
    document.getElementById("watchHosting").style.display = "none";
    document.getElementById("watchGuest").style.display   = "none";
    if (isWatchHost) {
      document.getElementById("watchHosting").style.display  = "block";
      document.getElementById("watchCodeDisplay").textContent = watchSessionCode;
    } else {
      document.getElementById("watchGuest").style.display   = "block";
      document.getElementById("watchGuestCode").textContent  = watchSessionCode;
      document.getElementById("watchSyncMode").checked       = usePrecisionMode;
    }
    return;
  }
  if (!currentVideo) { alert("🎬 Lance d'abord une vidéo"); return; }
  document.getElementById("watchMenu").style.display    = "block";
  document.getElementById("watchHosting").style.display = "none";
  document.getElementById("watchGuest").style.display   = "none";
  document.getElementById("watchOverlay").classList.add("active");
}

function closeWatchMenu() {
  document.getElementById("watchOverlay").classList.remove("active");
}

async function hostWatchSession() {
  if (!supabaseWatch || !currentVideo) return;

  watchSessionCode = generateWatchCode();
  isWatchHost      = true;
  watchChannel     = supabaseWatch.channel("session-" + watchSessionCode);
  watchChannel.subscribe(status => console.log("🎬 Hôte connecté:", status));

  watchSyncInterval = setInterval(() => {
    if (!isWatchHost || !currentVideo) return;
    player.getPaused(paused => {
      const tc = getTimecodes()[currentVideo.id] || 0;
      watchChannel.send({
        type:    "broadcast",
        event:   "sync",
        payload: {
          timecode: Math.floor(tc),
          videoId:  currentVideo.id,
          sentAt:   Date.now(),
          isPaused: paused
        }
      });
    });
  }, 3000);

  document.getElementById("watchMenu").style.display      = "none";
  document.getElementById("watchHosting").style.display   = "block";
  document.getElementById("watchCodeDisplay").textContent = watchSessionCode;
  document.getElementById("watchHostBadge").classList.add("active");
}

async function joinWatchSession() {
  if (!supabaseWatch) return;

  const code       = document.getElementById("watchCodeInput").value.trim().toUpperCase();
  watchSessionCode = code;
  isWatchHost      = false;
  watchChannel     = supabaseWatch.channel("session-" + code);

  watchChannel.on("broadcast", { event: "sync" }, ({ payload }) => {
    if (isWatchHost) return;
    const { timecode, videoId, sentAt, isPaused } = payload;

    if (videoId !== currentVideo?.id) {
      const vid = findVideoById(videoId);
      if (vid) loadVideo(vid);
      // La prochaine diffusion de l'hôte (3s max) placera le timecode
      return;
    }

    if (!player || !currentVideo) return;

    if (isPaused) {
      player.pause();
      player.setCurrentTime(timecode);
      return;
    }

    player.play();
    const targetTime = usePrecisionMode && sentAt
      ? timecode + (Date.now() - sentAt) / 1000
      : timecode;

    const localTime = getTimecodes()[currentVideo.id] || 0;
    if (Math.abs(localTime - targetTime) > 1) {
      console.log("▶ Sync lecture | cible:", targetTime.toFixed(1));
      player.setCurrentTime(targetTime);
    }
  });

  watchChannel.subscribe(status => {
    console.log("🔗 Invité connecté:", status);
    document.getElementById("watchMenu").style.display   = "none";
    document.getElementById("watchGuest").style.display  = "block";
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
  if (watchChannel)      { await supabaseWatch.removeChannel(watchChannel); }
  watchChannel     = null;
  watchSessionCode = null;
  isWatchHost      = false;
  usePrecisionMode = false;
  document.getElementById("watchOverlay").classList.remove("active");
  document.getElementById("watchHostBadge").classList.remove("active");
}

async function stopWatchSession() { await leaveWatchSession(); }

function toggleSyncMode() {
  usePrecisionMode = document.getElementById("watchSyncMode").checked;
}

// ─── Logs de sync ─────────────────────────────────────────────────────────────
function syncLog(msg) {
  const logEl = document.getElementById("syncLogs");
  if (!logEl) return;
  const time = new Date().toLocaleTimeString();
  logEl.innerHTML += `<div style="margin:2px 0;">[${time}] ${msg}</div>`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log("🔄", msg);
}

function clearSyncLogs() {
  const logEl = document.getElementById("syncLogs");
  if (logEl) logEl.innerHTML = "";
}