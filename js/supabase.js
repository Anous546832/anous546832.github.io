/* global supabase, RESUME_KEY, WATCHED_KEY, TIMECODE_KEY, currentVideo, player, data, creator, category, view, loadVideo */

/* ═══════════════════════════════════════════════════════════════════════════
   SYNCHRONISATION — v4
   ───────────────────────────────────────────────────────────────────────────
   Deux principes, et aucune heuristique de rattrapage.

   1. CAUSALITE, PAS HORLOGES
      Chaque valeur transporte un vecteur de version : un compteur par
      appareil. Comparer deux vecteurs repond exactement a la question utile :
      "cette ecriture a-t-elle ete faite en connaissance de l'autre ?"
        - un vecteur domine l'autre  -> il lui est POSTERIEUR, il gagne, point.
        - aucun ne domine            -> ecritures CONCURRENTES, on applique une
                                        regle de metier explicite.
      Aucune horloge n'intervient. La derive, les fuseaux, les telephones mal
      regles n'ont plus aucun effet possible.

   2. AUCUNE VALEUR N'EST ENREGISTREE SANS CONFIRMATION
      Un timecode n'est jamais lu dans localStorage ni deduit d'un diff : il
      est echantillonne sur le player, et n'est retenu que si un second
      echantillon le confirme. Une position transitoire emise au chargement
      (le fameux 0) n'est jamais confirmee, donc jamais enregistree.
      Il n'y a plus rien a "deviner apres coup".
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Configuration ────────────────────────────────────────────────────────────
const SUPABASE_URL       = "https://fjuwemzbsiwxvlajdckx.supabase.co";
const SUPABASE_KEY       = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqdXdlbXpic2l3eHZsYWpkY2t4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNzQ2OTAsImV4cCI6MjA5Mjg1MDY5MH0.QALJfDIWnAgY174aYkT3xXtB3ZzUsBftyoDusQV30fE";
const SUPABASE_WATCH_URL = "https://lzuoubzegbfelrftgpqt.supabase.co";
const SUPABASE_WATCH_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6dW91YnplZ2JmZWxyZnRncHF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MjA2OTYsImV4cCI6MjA5MzM5NjY5Nn0.BE2BAtNMTcjJt702Dbrvw3aShJNGsFWM1x3ILbSzCLU";

// Cles localStorage
const LS_SYNC_ID   = "sv_sync_id";      // identifiant du COMPTE (partage entre appareils)
const LS_DEVICE_ID = "sv_device_id";    // identifiant de CET appareil (jamais partage)
const LS_DOC       = "sv_doc_v4";       // document versionne (source de verite locale)
const LS_DIRTY     = "sv_dirty_v4";     // des modifications attendent d'etre envoyees

// Cles natives lues par le reste de l'application
const K_RESUME   = (typeof RESUME_KEY   !== "undefined") ? RESUME_KEY   : "sv_resume";
const K_WATCHED  = (typeof WATCHED_KEY  !== "undefined") ? WATCHED_KEY  : "sv_watched";
const K_TIMECODE = (typeof TIMECODE_KEY !== "undefined") ? TIMECODE_KEY : "sv_timecodes";

// Echantillonnage du player
const SAMPLE_MS        = 1000;   // frequence de lecture de la position
const DRIFT_TOLERANCE  = 2.5;    // ecart max (s) pour considerer une lecture continue
const MIN_DELTA        = 3;      // variation min (s) avant d'enregistrer une progression

// Reseau
const PUSH_DEBOUNCE_MS = 1500;
const PULL_INTERVAL_MS = 30000;
const RETRY_BASE_MS    = 4000;
const RETRY_MAX_MS     = 120000;

// ─── Etat ─────────────────────────────────────────────────────────────────────
let supabaseClient = null;
let supabaseReady  = false;
let syncId   = localStorage.getItem(LS_SYNC_ID)   || "";
let deviceId = localStorage.getItem(LS_DEVICE_ID) || "";

let _doc        = null;   // document versionne en memoire
let _pushTimer  = null;
let _retryTimer = null;
let _retryN     = 0;
let _busy       = false;
let _queued     = false;
let _rtChannel  = null;

// Watch Together
let supabaseWatch     = null;
let watchChannel      = null;
let isWatchHost       = false;
let watchSessionCode  = null;
let watchSyncInterval = null;
let usePrecisionMode  = false;


/* ═══════════════════════════════════════════════════════════════════════════
   1. VECTEURS DE VERSION
   ───────────────────────────────────────────────────────────────────────────
   Un vecteur est un objet { idAppareil: compteur }. Il n'exprime pas "quand"
   mais "ce qui etait connu au moment de l'ecriture". C'est la seule chose qui
   permette de trancher sans se tromper.
   ═══════════════════════════════════════════════════════════════════════════ */

const VV_AFTER      = 1;   // a est posterieur a b
const VV_BEFORE     = -1;  // a est anterieur a b
const VV_SAME       = 0;   // meme version
const VV_CONCURRENT = 2;   // ecritures independantes : conflit reel

function vvCompare(a, b) {
  a = a || {}; b = b || {};
  let aGreater = false, bGreater = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] || 0, y = b[k] || 0;
    if (x > y) aGreater = true;
    if (y > x) bGreater = true;
  }
  if (aGreater && bGreater) return VV_CONCURRENT;
  if (aGreater) return VV_AFTER;
  if (bGreater) return VV_BEFORE;
  return VV_SAME;
}

function vvMerge(a, b) {
  const out = { ...(a || {}) };
  for (const k of Object.keys(b || {})) out[k] = Math.max(out[k] || 0, b[k]);
  return out;
}

/** Nouvelle version, posterieure a tout ce qui est connu localement */
function vvNext(base) {
  const out = { ...(base || {}) };
  out[deviceId] = (out[deviceId] || 0) + 1;
  return out;
}


/* ═══════════════════════════════════════════════════════════════════════════
   2. DOCUMENT VERSIONNE
   ═══════════════════════════════════════════════════════════════════════════ */

function _readJSON(key, fallback) {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; }
  catch(e) { console.warn("⚠ localStorage illisible:", key); return fallback; }
}

function _emptyDoc() { return { v: 4, timecodes: {}, watched: {}, resume: {} }; }

/** Charge le document, en migrant l'etat natif existant si besoin */
function _loadDoc() {
  if (_doc) return _doc;
  const saved = _readJSON(LS_DOC, null);
  if (saved && saved.v === 4) { _doc = saved; return _doc; }

  // Premiere execution : on adopte l'etat natif existant avec un vecteur VIDE.
  // Un vecteur vide est domine par n'importe quelle ecriture reelle, sur cet
  // appareil comme sur l'autre : rien n'est perdu, et aucune donnee heritee ne
  // peut usurper la priorite sur une ecriture veritable.
  _doc = _emptyDoc();
  const tcs = _readJSON(K_TIMECODE, {}) || {};
  const wl  = _readJSON(K_WATCHED, []) || [];
  const rs  = _readJSON(K_RESUME, {}) || {};

  Object.keys(tcs).forEach(id => _doc.timecodes[id] = { v: tcs[id], vv: {} });
  wl.forEach(id                => _doc.watched[id]   = { v: true,    vv: {} });
  Object.keys(rs).forEach(k    => _doc.resume[k]     = { v: rs[k],   vv: {} });

  _saveDoc();
  console.log("📦 Document de synchronisation initialise depuis l'etat local");
  return _doc;
}

function _saveDoc() {
  try { localStorage.setItem(LS_DOC, JSON.stringify(_doc)); }
  catch(e) { console.warn("⚠ Ecriture du document impossible:", e.message); }
}

function _markDirty() { localStorage.setItem(LS_DIRTY, "1"); }
function _clearDirty() { localStorage.removeItem(LS_DIRTY); }
function _isDirty() { return localStorage.getItem(LS_DIRTY) === "1"; }

/** Projette le document vers les cles natives lues par le reste de l'app */
function _project() {
  const d = _loadDoc();
  const tcs = {}, rs = {}, wl = [];
  Object.keys(d.timecodes).forEach(id => { if (d.timecodes[id].v != null) tcs[id] = d.timecodes[id].v; });
  Object.keys(d.resume).forEach(k     => { if (d.resume[k].v != null)     rs[k]  = d.resume[k].v; });
  Object.keys(d.watched).forEach(id   => { if (d.watched[id].v) wl.push(id); });
  wl.sort();

  localStorage.setItem(K_TIMECODE, JSON.stringify(tcs));
  localStorage.setItem(K_RESUME,   JSON.stringify(rs));
  localStorage.setItem(K_WATCHED,  JSON.stringify(wl));
}

/** Ecrit une valeur dans le document en creant une nouvelle version */
function _put(section, key, value) {
  const d = _loadDoc();
  const cur = d[section][key];
  if (cur && _canon(cur.v) === _canon(value)) return false;   // rien de neuf
  d[section][key] = { v: value, vv: vvNext(cur?.vv) };
  _saveDoc();
  _markDirty();
  return true;
}


/* ═══════════════════════════════════════════════════════════════════════════
   3. ENREGISTREMENT DES TIMECODES — echantillonnage confirme
   ───────────────────────────────────────────────────────────────────────────
   Le timecode n'est PAS lu dans localStorage. Il est echantillonne sur le
   player, et une valeur n'est retenue que si elle est coherente avec
   l'echantillon precedent :

     - lecture continue  : position ≈ precedente + temps ecoule -> on enregistre
     - discontinuite     : on ne fait que MEMORISER la valeur, et on attend
                           l'echantillon suivant pour la confirmer

   Consequence : une position transitoire isolee (0 au chargement, valeur
   perimee avant un seek, artefact du lecteur) n'est jamais confirmee, donc
   jamais enregistree, donc ne peut jamais ecraser quoi que ce soit.
   ═══════════════════════════════════════════════════════════════════════════ */

let _samp = { videoId: null, last: null, at: 0, pending: null, pendingAt: 0 };

function _resetSampler(videoId, knownValue) {
  _samp = { videoId, last: knownValue ?? null, at: Date.now(), pending: null, pendingAt: 0 };
}

async function _sampleTick() {
  try {
    if (typeof currentVideo === "undefined" || !currentVideo || !player) {
      if (_samp.videoId) _resetSampler(null, null);
      return;
    }

    const id = currentVideo.id;
    if (id !== _samp.videoId) {
      // Nouvelle video : on part de la valeur du document, pas de celle du player
      _resetSampler(id, _loadDoc().timecodes[id]?.v ?? null);
      return;
    }

    const pos = await _livePosition();
    if (pos == null || !isFinite(pos) || pos < 0) return;

    const now     = Date.now();
    const elapsed = (now - _samp.at) / 1000;

    // ── Cas 1 : lecture continue ────────────────────────────────────────────
    // La position a avance d'a peu pres le temps ecoule : c'est une vraie
    // lecture, la valeur est fiable immediatement.
    if (_samp.last != null && Math.abs(pos - (_samp.last + elapsed)) <= DRIFT_TOLERANCE) {
      _samp.last = pos; _samp.at = now; _samp.pending = null;
      _commitTimecode(id, pos);
      return;
    }

    // ── Cas 2 : position identique (pause) ──────────────────────────────────
    // On enregistre la position EXACTE d'arret. Sans cela, les quelques
    // secondes separant la derniere version de l'arret reel seraient perdues.
    // L'appel est sans effet si la valeur est deja enregistree, donc une pause
    // prolongee ne cree pas de version a chaque seconde.
    if (_samp.last != null && Math.abs(pos - _samp.last) <= DRIFT_TOLERANCE) {
      _samp.at = now; _samp.pending = null;
      _commitTimecode(id, pos, true);
      return;
    }

    // ── Cas 3 : discontinuite ───────────────────────────────────────────────
    // Seek volontaire OU artefact. On ne tranche pas maintenant : on memorise
    // et on exige que l'echantillon suivant soit coherent avec celui-ci.
    if (_samp.pending == null) {
      _samp.pending = pos; _samp.pendingAt = now;
      return;
    }

    const pElapsed = (now - _samp.pendingAt) / 1000;
    const coherent = Math.abs(pos - _samp.pending) <= DRIFT_TOLERANCE ||
                     Math.abs(pos - (_samp.pending + pElapsed)) <= DRIFT_TOLERANCE;

    if (coherent) {
      // Confirme par deux echantillons : c'est une vraie position.
      _samp.last = pos; _samp.at = now; _samp.pending = null;
      _commitTimecode(id, pos, true);
    } else {
      // Incoherent : l'echantillon precedent etait un artefact, on repart.
      _samp.pending = pos; _samp.pendingAt = now;
    }
  } catch(e) { /* un echantillon rate n'a aucune consequence */ }
}

/**
 * Enregistre immediatement la position courante, sans attendre de confirmation.
 * Reserve aux moments ou l'on quitte : la position affichee est alors stable
 * par definition, il n'y a plus d'artefact possible.
 */
function _flushSampler() {
  try {
    if (typeof currentVideo === "undefined" || !currentVideo || !player) return;
    if (_samp.videoId !== currentVideo.id || _samp.last == null) return;
    _commitTimecode(currentVideo.id, _samp.last, true);
  } catch(e) { /* sans consequence */ }
}

function _commitTimecode(videoId, pos, isSeek) {
  const d   = _loadDoc();
  const cur = d.timecodes[videoId]?.v;
  const val = Math.floor(pos);

  // On evite de creer une version a chaque seconde : seules les variations
  // significatives, ou les seeks confirmes, produisent une nouvelle version.
  if (cur != null && !isSeek && Math.abs(val - cur) < MIN_DELTA) return;
  if (cur === val) return;

  if (_put("timecodes", videoId, val)) {
    _project();
    _schedulePush();
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   4. CHANGEMENTS DISCRETS (vus / reprises)
   ───────────────────────────────────────────────────────────────────────────
   Ceux-la sont de vraies actions ponctuelles de l'utilisateur : les detecter
   par comparaison avec la projection est fiable, contrairement aux timecodes.
   ═══════════════════════════════════════════════════════════════════════════ */

function _absorbNativeChanges() {
  const d  = _loadDoc();
  let n = 0;

  // ── vus ──
  const wlNow  = new Set(_readJSON(K_WATCHED, []) || []);
  const wlDoc  = new Set(Object.keys(d.watched).filter(id => d.watched[id].v));
  wlNow.forEach(id => { if (!wlDoc.has(id) && _put("watched", id, true))  n++; });
  wlDoc.forEach(id => { if (!wlNow.has(id) && _put("watched", id, false)) n++; });

  // ── reprises ──
  const rsNow = _readJSON(K_RESUME, {}) || {};
  Object.keys(rsNow).forEach(k => {
    if (_canon(rsNow[k]) !== _canon(d.resume[k]?.v) && _put("resume", k, rsNow[k])) n++;
  });
  Object.keys(d.resume).forEach(k => {
    if (!(k in rsNow) && d.resume[k].v != null && _put("resume", k, null)) n++;
  });

  return n;
}


/* ═══════════════════════════════════════════════════════════════════════════
   5. FUSION
   ═══════════════════════════════════════════════════════════════════════════ */

function _canon(o) {
  if (o === null || o === undefined || typeof o !== "object") return JSON.stringify(o ?? null);
  if (Array.isArray(o)) return "[" + o.map(_canon).join(",") + "]";
  return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + _canon(o[k])).join(",") + "}";
}

/**
 * Regles appliquees UNIQUEMENT en cas de conflit reel (ecritures concurrentes,
 * c'est-a-dire faites sans que l'une connaisse l'autre). Dans tous les autres
 * cas, la causalite tranche seule et ces regles ne servent pas.
 */
const RESOLVE = {
  // Ne jamais faire perdre de progression. Une eventuelle marche arriere
  // volontaire sera reappliquee des la prochaine ecriture, qui dominera.
  timecodes: (a, b) => (Number(a.v) >= Number(b.v) ? a.v : b.v),
  // "vu" l'emporte sur "pas vu" : on ne perd pas un episode marque.
  watched:   (a, b) => (a.v || b.v),
  // Depart deterministe, identique sur les deux appareils.
  resume:    (a, b) => (_canon(a.v) >= _canon(b.v) ? a.v : b.v)
};

function _mergeSection(section, local, remote) {
  const out = {};
  const keys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);

  for (const k of keys) {
    const a = local?.[k], b = remote?.[k];
    if (!a) { out[k] = b; continue; }
    if (!b) { out[k] = a; continue; }

    switch (vvCompare(a.vv, b.vv)) {
      case VV_AFTER:  out[k] = a; break;   // le local connait le distant
      case VV_BEFORE: out[k] = b; break;   // le distant connait le local
      case VV_SAME:   out[k] = a; break;   // meme version
      default:
        // Conflit reel : on applique la regle de metier, et le resultat porte
        // la fusion des deux vecteurs. Les deux appareils calculent la meme
        // chose a partir des memes entrees : ils convergent.
        out[k] = { v: RESOLVE[section](a, b), vv: vvMerge(a.vv, b.vv) };
    }
  }
  return out;
}

function _mergeDocs(localDoc, remoteDoc) {
  return {
    v: 4,
    timecodes: _mergeSection("timecodes", localDoc.timecodes, remoteDoc.timecodes),
    watched:   _mergeSection("watched",   localDoc.watched,   remoteDoc.watched),
    resume:    _mergeSection("resume",    localDoc.resume,    remoteDoc.resume)
  };
}

/** Accepte un document distant quel qu'en soit le format */
function _normalizeRemote(raw) {
  if (!raw) return _emptyDoc();
  if (raw.v === 4) {
    return {
      v: 4,
      timecodes: raw.timecodes || {},
      watched:   raw.watched   || {},
      resume:    raw.resume    || {}
    };
  }

  // Formats anterieurs : adoptes avec un vecteur VIDE, donc domines par
  // n'importe quelle ecriture reelle. Aucune donnee n'est perdue, mais un
  // ancien bloc ne peut pas usurper la priorite.
  const out = _emptyDoc();
  const tc = raw.timecodes || {}, rs = raw.resume || {}, wl = raw.watched;

  Object.keys(tc).forEach(k => out.timecodes[k] = { v: (tc[k]?.v ?? tc[k]), vv: {} });
  Object.keys(rs).forEach(k => out.resume[k]    = { v: (rs[k]?.v ?? rs[k]), vv: {} });
  if (Array.isArray(wl)) wl.forEach(id => out.watched[id] = { v: true, vv: {} });
  else Object.keys(wl || {}).forEach(id => out.watched[id] = { v: !!(wl[id]?.v ?? wl[id]), vv: {} });

  return out;
}


/* ═══════════════════════════════════════════════════════════════════════════
   6. RESEAU
   ═══════════════════════════════════════════════════════════════════════════ */

const _headers = {
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json"
};

async function _fetchRemote() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/progress?id=eq.${encodeURIComponent(syncId)}&select=data`,
    { headers: _headers, cache: "no-store" }
  );
  if (!res.ok) throw new Error("HTTP " + res.status);
  return (await res.json())?.[0]?.data || null;
}

async function _pushRemote(doc) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/progress`, {
    method: "POST",
    headers: { ..._headers, "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id: syncId, data: doc, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
}


/* ═══════════════════════════════════════════════════════════════════════════
   7. CYCLE DE SYNCHRONISATION
   ═══════════════════════════════════════════════════════════════════════════ */

async function syncNow({ silent = true } = {}) {
  if (!supabaseReady || !syncId) return { ok: false, reason: "not-ready" };
  if (_busy) { _queued = true; return { ok: false, reason: "busy" }; }
  _busy = true;

  try {
    _absorbNativeChanges();
    const before = _canon(_loadDoc());

    // ── Lecture distante ──
    let raw;
    try { raw = await _fetchRemote(); }
    catch(e) {
      _scheduleRetry();
      if (!silent) syncLog("❌ Lecture cloud impossible — nouvelle tentative programmee");
      return { ok: false, reason: "read-failed", error: e.message };
    }

    const remote = _normalizeRemote(raw);
    const merged = _mergeDocs(_loadDoc(), remote);

    _doc = merged;
    _saveDoc();
    _project();

    const changed = _canon(merged) !== before;

    // ── Envoi si le distant n'a pas deja exactement l'etat fusionne ──
    if (_isDirty() || _canon(merged) !== _canon(remote)) {
      try {
        await _pushRemote(merged);
        _clearDirty();
        _retryN = 0;
      } catch(e) {
        _scheduleRetry();
        if (!silent) syncLog("❌ Envoi cloud echoue — nouvelle tentative programmee");
        return { ok: false, reason: "push-failed", error: e.message };
      }
    }

    _retryN = 0;

    if (changed) {
      _afterRemoteChange();
      _refreshUI();
      if (!silent) syncLog("☁️ Synchronise — donnees mises a jour");
    } else if (!silent) {
      syncLog("✅ Synchronise — tout est a jour");
    }

    return { ok: true, changed };

  } finally {
    _busy = false;
    if (_queued) { _queued = false; setTimeout(() => syncNow({ silent: true }), 300); }
  }
}

/**
 * Le document a change suite a une fusion. Si la video en cours a desormais
 * une autre position, le PLAYER est repositionne dessus.
 *
 * L'echantillonneur est recale en meme temps : le seek qui suit sera vu comme
 * coherent et ne sera pas pris pour une action de l'utilisateur.
 */
function _afterRemoteChange() {
  if (typeof currentVideo === "undefined" || !currentVideo || !player) return;
  const id  = currentVideo.id;
  const val = _loadDoc().timecodes[id]?.v;
  if (val == null) return;

  _livePosition().then(pos => {
    if (pos == null || Math.abs(pos - val) < 5) return;
    _resetSampler(id, val);            // le player va suivre : c'est attendu
    try {
      player.setCurrentTime(val);
      console.log(`↪ Player aligne sur la valeur synchronisee : ${Math.round(val)}s`);
      syncLog(`↪ Reprise alignee : ${Math.floor(val / 60)} min`);
    } catch(e) { /* le player n'est pas pret, le prochain cycle reessaiera */ }
  }).catch(() => {});
}

function _schedulePush() {
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => { _pushTimer = null; syncNow({ silent: true }); }, PUSH_DEBOUNCE_MS);
}

function _scheduleRetry() {
  if (_retryTimer) return;
  _retryN++;
  const delay = Math.min(RETRY_BASE_MS * Math.pow(2, _retryN - 1), RETRY_MAX_MS);
  console.warn(`⚠ Sync echouee — nouvelle tentative dans ${Math.round(delay / 1000)}s`);
  _retryTimer = setTimeout(() => { _retryTimer = null; syncNow({ silent: true }); }, delay);
}

/** Envoi de dernier recours : aboutit meme si la page se ferme */
function _flush() {
  if (!supabaseReady || !syncId) return;
  _flushSampler();
  _absorbNativeChanges();
  if (!_isDirty()) return;
  try {
    fetch(`${SUPABASE_URL}/rest/v1/progress`, {
      method: "POST",
      keepalive: true,
      headers: { ..._headers, "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: syncId, data: _loadDoc(), updated_at: new Date().toISOString() })
    }).catch(() => {});
  } catch(e) { /* la page se ferme */ }
}

function _refreshUI() {
  for (const h of ["renderAll", "render", "renderHome", "renderVideos", "refreshUI", "updateUI"]) {
    if (typeof window[h] === "function") { try { window[h](); return; } catch(e) {} }
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   8. API PUBLIQUE
   ═══════════════════════════════════════════════════════════════════════════ */

/** Appelee par l'application a chaque modification. Meme signature qu'avant. */
function saveWithSync() {
  _absorbNativeChanges();
  _schedulePush();
}

async function forceSyncNow() {
  if (!supabaseReady) { alert("⚠ Supabase non connecte"); return; }
  if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; }
  syncLog("🔄 Synchronisation en cours...");

  const r = await syncNow({ silent: false });
  if (r.ok) {
    alert(r.changed ? "✅ Synchronise !\nDes donnees ont ete mises a jour."
                    : "✅ Tout est deja a jour.");
  } else if (r.reason === "busy") {
    alert("⏳ Une synchronisation est deja en cours.");
  } else {
    alert("❌ Synchronisation impossible.\nTes donnees locales sont intactes, une nouvelle tentative est programmee.");
  }
}

/* ─── Diagnostic ──────────────────────────────────────────────────────────── */

function svSyncStatus() {
  const d = _loadDoc();
  console.group("🔍 Etat de la synchronisation");
  console.log("Compte (syncId) :", syncId);
  console.log("Cet appareil    :", deviceId);
  console.log("En attente d'envoi :", _isDirty() ? "OUI" : "non");
  console.log("Timecodes :", Object.keys(d.timecodes).length,
              "| Vus :", Object.values(d.watched).filter(e => e.v).length);
  if (typeof currentVideo !== "undefined" && currentVideo) {
    const e = d.timecodes[currentVideo.id];
    console.log("Video en cours  :", currentVideo.id);
    console.log("  valeur        :", e?.v ?? "—", "s");
    console.log("  vecteur       :", JSON.stringify(e?.vv || {}));
  }
  console.log("Echantillonneur :", JSON.stringify(_samp));
  console.groupEnd();
  return d;
}

/** Compare local et distant pour un episode, et EXPLIQUE qui gagne et pourquoi */
async function svCompare(videoId) {
  const id = videoId || (typeof currentVideo !== "undefined" && currentVideo?.id);
  if (!id) { console.warn("Usage : svCompare('id_video')"); return; }

  let raw; try { raw = await _fetchRemote(); }
  catch(e) { console.error("Lecture cloud impossible :", e.message); return; }

  const a = _loadDoc().timecodes[id];
  const b = _normalizeRemote(raw).timecodes[id];
  const mmss = v => v == null ? "—"
    : `${Math.floor(v/3600)}h${String(Math.floor((v%3600)/60)).padStart(2,"0")}m${String(Math.floor(v%60)).padStart(2,"0")}s`;

  console.group("🔍 " + id);
  console.table({
    LOCAL: { position: mmss(a?.v), brut: a?.v ?? "—", vecteur: JSON.stringify(a?.vv || {}) },
    CLOUD: { position: mmss(b?.v), brut: b?.v ?? "—", vecteur: JSON.stringify(b?.vv || {}) }
  });

  if (!a || !b) console.log("→ Un seul cote possede une valeur : elle est reprise telle quelle.");
  else switch (vvCompare(a.vv, b.vv)) {
    case VV_AFTER:
      console.log("→ Le LOCAL a ete ecrit EN CONNAISSANCE du cloud : il gagne.", mmss(a.v)); break;
    case VV_BEFORE:
      console.log("→ Le CLOUD a ete ecrit EN CONNAISSANCE du local : il gagne.", mmss(b.v)); break;
    case VV_SAME:
      console.log("→ Meme version des deux cotes, rien a faire."); break;
    default:
      console.log("→ Ecritures CONCURRENTES (aucune ne connaissait l'autre).");
      console.log("  Regle appliquee : on ne perd jamais de progression →", mmss(RESOLVE.timecodes(a, b)));
  }
  console.groupEnd();
  return { local: a, cloud: b };
}

/** Remet ce seul appareil sur l'etat du cloud, sans rien detruire ailleurs */
async function svResetFromCloud() {
  if (!confirm("Remplacer l'etat de CET appareil par celui du cloud ?")) return;
  const raw = await _fetchRemote();
  _doc = _normalizeRemote(raw);
  _saveDoc(); _project(); _clearDirty();
  alert("✅ Etat repris depuis le cloud.");
  location.reload();
}


/* ═══════════════════════════════════════════════════════════════════════════
   9. INITIALISATION
   ═══════════════════════════════════════════════════════════════════════════ */

try {
  supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  if (!syncId) {
    syncId = "sv_" + Date.now() + "_" + Math.random().toString(36).slice(2, 11);
    localStorage.setItem(LS_SYNC_ID, syncId);
  }
  if (!deviceId) {
    deviceId = "d_" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(LS_DEVICE_ID, deviceId);
  }
  supabaseReady = true;
  console.log("✅ Supabase Progression connecte | appareil:", deviceId);
} catch(e) {
  console.warn("⚠ Supabase Progression non disponible:", e.message);
}

try {
  supabaseWatch = supabase.createClient(SUPABASE_WATCH_URL, SUPABASE_WATCH_KEY);
  console.log("✅ Supabase Watch connecte");
} catch(e) {
  console.warn("⚠ Supabase Watch non disponible:", e.message);
}

_loadDoc();
_project();

(async function boot() {
  if (!supabaseReady) return;
  await syncNow({ silent: true });

  setInterval(_sampleTick, SAMPLE_MS);

  try {
    _rtChannel = supabaseClient
      .channel("progress-" + syncId)
      .on("postgres_changes",
          { event: "*", schema: "public", table: "progress", filter: `id=eq.${syncId}` },
          () => { if (!_busy) syncNow({ silent: true }); })
      .subscribe(s => console.log("📡 Realtime:", s));
  } catch(e) {
    console.log("ℹ Realtime indisponible, interrogation periodique utilisee");
  }
})();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") _flush();
  else if (supabaseReady) syncNow({ silent: true });
});
window.addEventListener("pagehide", _flush);
window.addEventListener("beforeunload", _flush);
window.addEventListener("online", () => {
  if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
  _retryN = 0;
  syncNow({ silent: true });
});

setInterval(() => {
  if (supabaseReady && document.visibilityState === "visible" && !_busy) syncNow({ silent: true });
}, PULL_INTERVAL_MS);


/* ═══════════════════════════════════════════════════════════════════════════
   10. LIAISON D'APPAREILS
   ═══════════════════════════════════════════════════════════════════════════ */

function openLinkDeviceMenu() {
  document.getElementById("linkDeviceMyId").textContent = syncId;
  document.getElementById("linkDeviceOverlay").classList.add("active");
}
function closeLinkDeviceMenu() {
  document.getElementById("linkDeviceOverlay").classList.remove("active");
}
function copySyncId() {
  navigator.clipboard.writeText(syncId)
    .then(() => alert("📋 ID copie !"))
    .catch(() => prompt("Copie manuelle :", syncId));
}

async function linkById() {
  const targetId = document.getElementById("linkDeviceIdInput").value.trim();
  if (!targetId.startsWith("sv_")) { alert("❌ ID invalide"); return; }
  if (targetId === syncId)         { alert("❌ C'est deja ton ID !"); return; }
  if (!supabaseReady)              { alert("⚠ Supabase non connecte"); return; }
  if (!confirm("🔗 Lier cet appareil ?\n\nLes deux progressions seront FUSIONNEES.\nAucune donnee ne sera perdue.")) return;

  try {
    await syncNow({ silent: true });          // on publie l'etat courant
    syncId = targetId;
    localStorage.setItem(LS_SYNC_ID, targetId);
    _markDirty();                              // force la republication sous le nouvel ID
    const r = await syncNow({ silent: false });
    closeLinkDeviceMenu();
    if (r.ok) { alert("✅ Appareils lies et fusionnes !"); _refreshUI(); }
    else      { alert("⚠ Lie, mais la synchro a echoue. Elle se fera automatiquement."); }
  } catch(e) { alert("❌ Erreur: " + e.message); }
}


/* ═══════════════════════════════════════════════════════════════════════════
   11. WATCH TOGETHER
   ═══════════════════════════════════════════════════════════════════════════ */

function generateWatchCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function copyWatchCode() { navigator.clipboard.writeText(watchSessionCode).then(() => alert("📋 " + watchSessionCode)); }

/** Position reelle du player, quelle que soit l'API (callback ou promesse) */
function _livePosition() {
  return new Promise(resolve => {
    if (!player) return resolve(null);
    let done = false;
    const ok = t => { if (!done) { done = true; resolve(typeof t === "number" ? t : null); } };
    try {
      const r = player.getCurrentTime(ok);
      if (r && typeof r.then === "function") r.then(ok).catch(() => ok(null));
    } catch(e) { return resolve(null); }
    setTimeout(() => ok(null), 800);   // le player ne repond pas : on abandonne
  });
}

function _playerPaused() {
  return new Promise(resolve => {
    if (!player || typeof player.getPaused !== "function") return resolve(null);
    let done = false;
    const ok = p => { if (!done) { done = true; resolve(p); } };
    try {
      const r = player.getPaused(ok);
      if (r && typeof r.then === "function") r.then(ok).catch(() => ok(null));
    } catch(e) { return resolve(null); }
    setTimeout(() => ok(null), 800);
  });
}

function startWatchMenu() {
  if (watchSessionCode) {
    document.getElementById("watchOverlay").classList.add("active");
    document.getElementById("watchMenu").style.display    = "none";
    document.getElementById("watchHosting").style.display = "none";
    document.getElementById("watchGuest").style.display   = "none";
    if (isWatchHost) {
      document.getElementById("watchHosting").style.display   = "block";
      document.getElementById("watchCodeDisplay").textContent = watchSessionCode;
    } else {
      document.getElementById("watchGuest").style.display    = "block";
      document.getElementById("watchGuestCode").textContent  = watchSessionCode;
      document.getElementById("watchSyncMode").checked       = usePrecisionMode;
    }
    return;
  }
  if (!currentVideo) { alert("🎬 Lance d'abord une video"); return; }
  document.getElementById("watchMenu").style.display    = "block";
  document.getElementById("watchHosting").style.display = "none";
  document.getElementById("watchGuest").style.display   = "none";
  document.getElementById("watchOverlay").classList.add("active");
}

function closeWatchMenu() { document.getElementById("watchOverlay").classList.remove("active"); }

async function hostWatchSession() {
  if (!supabaseWatch || !currentVideo) return;
  watchSessionCode = generateWatchCode();
  isWatchHost      = true;
  watchChannel     = supabaseWatch.channel("session-" + watchSessionCode);
  watchChannel.subscribe(s => console.log("🎬 Hote connecte:", s));

  watchSyncInterval = setInterval(async () => {
    if (!isWatchHost || !currentVideo || !watchChannel) return;
    const tc     = await _livePosition();
    const paused = await _playerPaused();
    if (tc == null) return;
    watchChannel.send({
      type: "broadcast", event: "sync",
      payload: { timecode: tc, videoId: currentVideo.id, sentAt: Date.now(), isPaused: !!paused }
    });
  }, 2000);

  document.getElementById("watchMenu").style.display      = "none";
  document.getElementById("watchHosting").style.display   = "block";
  document.getElementById("watchCodeDisplay").textContent = watchSessionCode;
  document.getElementById("watchHostBadge").classList.add("active");
}

async function joinWatchSession() {
  if (!supabaseWatch) return;
  const code = document.getElementById("watchCodeInput").value.trim().toUpperCase();
  if (!code) { alert("❌ Code invalide"); return; }
  watchSessionCode = code;
  isWatchHost      = false;
  watchChannel     = supabaseWatch.channel("session-" + code);

  let pendingSeek = null;

  watchChannel.on("broadcast", { event: "sync" }, async ({ payload }) => {
    if (isWatchHost) return;
    const { timecode, videoId, sentAt, isPaused } = payload;

    if (videoId !== currentVideo?.id) {
      const vid = findVideoById(videoId);
      if (vid) {
        pendingSeek = timecode;
        loadVideo(vid);
        setTimeout(() => {
          if (pendingSeek != null && player) {
            _resetSampler(videoId, pendingSeek);
            player.setCurrentTime(pendingSeek);
            pendingSeek = null;
          }
        }, 1200);
      }
      return;
    }

    if (!player || !currentVideo) return;

    if (isPaused) { player.pause(); player.setCurrentTime(timecode); return; }
    player.play();

    const target = usePrecisionMode && sentAt ? timecode + (Date.now() - sentAt) / 1000 : timecode;
    const here   = await _livePosition();
    if (here != null && Math.abs(here - target) > 1.5) {
      _resetSampler(currentVideo.id, target);
      player.setCurrentTime(target);
    }
  });

  watchChannel.subscribe(s => {
    console.log("🔗 Invite connecte:", s);
    document.getElementById("watchMenu").style.display    = "none";
    document.getElementById("watchGuest").style.display   = "block";
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
  if (watchChannel) { try { await supabaseWatch.removeChannel(watchChannel); } catch(e) {} }
  watchChannel = null; watchSessionCode = null; isWatchHost = false; usePrecisionMode = false;
  document.getElementById("watchOverlay").classList.remove("active");
  document.getElementById("watchHostBadge").classList.remove("active");
}
async function stopWatchSession() { await leaveWatchSession(); }
function toggleSyncMode() { usePrecisionMode = document.getElementById("watchSyncMode").checked; }


/* ═══════════════════════════════════════════════════════════════════════════
   12. LOGS
   ═══════════════════════════════════════════════════════════════════════════ */

function syncLog(msg) {
  console.log("🔄", msg);
  const el = document.getElementById("syncLogs");
  if (!el) return;
  el.innerHTML += `<div style="margin:2px 0;">[${new Date().toLocaleTimeString()}] ${msg}</div>`;
  el.scrollTop = el.scrollHeight;
}

function clearSyncLogs() {
  const el = document.getElementById("syncLogs");
  if (el) el.innerHTML = "";
}