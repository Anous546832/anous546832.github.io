// ─── Fonctionnalités bêta ────────────────────────────────────────────────────
// Interrupteurs locaux (par appareil) pour tester des nouveautés en production.
// Rien n'est synchronisé : activer une bêta sur le PC ne la touche pas sur le téléphone.
//
// Ajouter une bêta :
//   1. l'ajouter dans BETA_FEATURES ci-dessous (id unique, label, desc)
//   2. dans le code : if (betaOn('mon-id')) { ... }   ou en CSS : body.beta-mon-id .x { ... }
//   3. optionnel : onChange(on) est appelé à chaque bascule (et au démarrage si active)

const BETA_FEATURES = [
  {
    id: 'real-time-grab',
    label: '⏱️ Position réelle du lecteur',
    desc: 'Le bouton ⏱️ lit la position exacte dans la vidéo, pas la dernière valeur sauvegardée.'
  },
  {
    id: 'sleep-timer',
    label: '😴 Minuteur de mise en veille',
    desc: 'Met la vidéo en pause après le délai choisi, pour laisser l\'appareil se mettre en veille. Démarre à la lecture, s\'annule si tu mets en pause.',
    select: {
      key: 'minutes', def: 30,
      values: [[1, '1 min (test)'], [15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 h'], [90, '1 h 30'], [120, '2 h']]
    },
    onChange(on) { if (!on) _sleepDisarm(); }
  },
  {
    id: 'blackout-pause',
    label: '⬛ Écran noir en pause',
    desc: 'Cache la vidéo par un écran noir quand elle est en pause (anti-spoil). Touche l\'écran pour reprendre.',
    onChange(on) { if (!on) _blackoutHide(); }
  }
];

const BETA_KEY = 'sv_beta_v1';
let _betaState = { master: false, flags: {}, opts: {} };

function _betaLoad() {
  try {
    const raw = localStorage.getItem(BETA_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s === 'object') {
        _betaState.master = !!s.master;
        _betaState.flags = (s.flags && typeof s.flags === 'object') ? s.flags : {};
        _betaState.opts = (s.opts && typeof s.opts === 'object') ? s.opts : {};
      }
    }
  } catch (e) {
    _betaState = { master: false, flags: {}, opts: {} };
  }
}
function _betaSave() {
  try { localStorage.setItem(BETA_KEY, JSON.stringify(_betaState)); } catch (e) {}
}

// Vrai si l'interrupteur général ET la fonctionnalité sont activés
function betaOn(id) {
  return !!(_betaState.master && _betaState.flags[id]);
}

function _betaApply(id) {
  const on = betaOn(id);
  document.body.classList.toggle('beta-' + id, on);
  const f = BETA_FEATURES.find(x => x.id === id);
  if (f && typeof f.onChange === 'function') {
    try { f.onChange(on); } catch (e) { console.error('[beta] ' + id, e); }
  }
}
function _betaApplyAll() { BETA_FEATURES.forEach(f => _betaApply(f.id)); }

function setBetaMaster(on) {
  _betaState.master = !!on;
  _betaSave();
  _betaApplyAll();
  renderBetaPanel();
}
function setBetaFlag(id, on) {
  _betaState.flags[id] = !!on;
  _betaSave();
  _betaApply(id);
  renderBetaPanel();
}
function betaOpt(id, key) {
  const f = BETA_FEATURES.find(x => x.id === id);
  const v = _betaState.opts[id + '.' + key];
  return v !== undefined ? v : (f && f.select ? f.select.def : undefined);
}
function setBetaOpt(id, key, val) {
  _betaState.opts[id + '.' + key] = Number(val);
  _betaSave();
  if (id === 'sleep-timer') _sleepDisarm(); // nouveau délai : repart à la prochaine lecture
}
function resetBeta() {
  _betaState = { master: false, flags: {}, opts: {} };
  _betaSave();
  _betaApplyAll();
  renderBetaPanel();
}

function _betaSelectHtml(f, enabled) {
  if (!f.select) return '';
  const cur = betaOpt(f.id, f.select.key);
  const opts = f.select.values.map(([v, t]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${_esc(t)}</option>`).join('');
  return `<select class="beta-select" ${enabled ? '' : 'disabled'} onclick="event.stopPropagation()"
            onchange="setBetaOpt('${f.id}','${f.select.key}', this.value)">${opts}</select>`;
}

function renderBetaPanel() {
  const box = document.getElementById('betaList');
  if (!box) return;
  const m = _betaState.master;
  const rows = BETA_FEATURES.map(f => `
    <label class="beta-row${m ? '' : ' beta-off'}">
      <input type="checkbox" ${_betaState.flags[f.id] ? 'checked' : ''} ${m ? '' : 'disabled'}
             onchange="setBetaFlag('${f.id}', this.checked)" />
      <span><b>${_esc(f.label)}</b><small>${_esc(f.desc)}</small>${_betaSelectHtml(f, m)}</span>
    </label>`).join('');
  box.innerHTML = `
    <label class="beta-row beta-master">
      <input type="checkbox" ${m ? 'checked' : ''} onchange="setBetaMaster(this.checked)" />
      <span><b>Activer les fonctionnalités bêta</b><small>Interrupteur général, pour cet appareil uniquement</small></span>
    </label>
    ${rows || '<div class="beta-empty">Aucune bêta disponible</div>'}`;
}

// ─── Runtime : minuteur de veille + écran noir ───────────────────────────────
let _sleepDeadline = 0, _sleepTick = null, _isPaused = false, _pauseTimer = null, _blackTimer = null;

function _sleepPill() {
  let el = document.getElementById('betaSleepPill');
  if (!el) {
    el = document.createElement('div');
    el.id = 'betaSleepPill'; el.className = 'beta-pill';
    document.body.appendChild(el);
  }
  return el;
}
function _sleepArm() {
  if (_sleepDeadline || !betaOn('sleep-timer')) return;
  _sleepDeadline = Date.now() + betaOpt('sleep-timer', 'minutes') * 60000;
  _sleepTick = setInterval(_sleepUpdate, 1000);
  _sleepUpdate();
}
function _sleepDisarm() {
  _sleepDeadline = 0;
  if (_sleepTick) { clearInterval(_sleepTick); _sleepTick = null; }
  const el = document.getElementById('betaSleepPill');
  if (el) el.style.display = 'none';
}
function _sleepUpdate() {
  const left = _sleepDeadline - Date.now();
  if (left <= 0) {
    _sleepDisarm();
    try { if (player) player.pause(); } catch (e) {}
    return;
  }
  const el = _sleepPill();
  const m = Math.floor(left / 60000), sec = Math.floor(left / 1000) % 60;
  el.textContent = '😴 ' + m + ':' + String(sec).padStart(2, '0');
  el.style.display = 'block';
}

function _blackoutShow() {
  if (!betaOn('blackout-pause')) return;
  const area = document.getElementById('videoArea');
  if (!area || area.querySelector('.beta-blackout')) return;
  const d = document.createElement('div');
  d.className = 'beta-blackout';
  d.innerHTML = '<span>⏸</span>';
  d.onclick = () => { try { if (player) player.play(); } catch (e) {} };
  area.appendChild(d);
}
function _blackoutHide() {
  clearTimeout(_blackTimer);
  document.querySelectorAll('.beta-blackout').forEach(e => e.remove());
}

// Appelé par player.js quand une nouvelle vidéo est chargée / quand le lecteur est prêt
function betaVideoLoaded() { _isPaused = false; clearTimeout(_pauseTimer); clearTimeout(_blackTimer); }
function betaPlayerReady(p) {
  p.on('play', () => {
    _isPaused = false;
    clearTimeout(_pauseTimer); clearTimeout(_blackTimer);
    _blackoutHide();
    _sleepArm();
  });
  p.on('pause', () => {
    _isPaused = true;
    // le minuteur ignore les pauses fugitives (déplacement dans la barre, chargement)
    clearTimeout(_pauseTimer); clearTimeout(_blackTimer);
    _pauseTimer = setTimeout(() => { if (_isPaused) _sleepDisarm(); }, 1500);
    _blackoutShow(); // instantané : aucun délai, pour ne rien laisser voir
  });
  p.on('ended', () => { _isPaused = false; clearTimeout(_blackTimer); });
}

_betaLoad();
document.addEventListener('DOMContentLoaded', () => { _betaApplyAll(); renderBetaPanel(); });
