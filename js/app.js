// ─── Init ─────────────────────────────────────────────────────────────────────
// Masque le bruit des WebSockets Realtime. On garde l'original : l'ancienne version
// s'appelait elle-même (récursion infinie) pour toute autre erreur.
const _origConsoleError = console.error.bind(console);
console.error = (...a) => {
  if (typeof a[0] === 'string' && (a[0].includes('WebSocket') || a[0].includes('socket'))) return;
  _origConsoleError(...a);
};

loadDevChapters();

document.addEventListener("DOMContentLoaded", async () => {
  // On attend la 1re synchro (max 2,5 s) AVANT de restaurer la dernière vidéo :
  // sinon l'appareil redémarre sur sa position locale périmée au lieu de celle de l'autre appareil.
  if (window.svBootSync) await Promise.race([window.svBootSync, new Promise(r => setTimeout(r, 2500))]);
  await loadDatabase();
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'D') { e.preventDefault(); toggleDevMode(); }
});

['mousemove', 'keydown', 'touchstart', 'click', 'scroll'].forEach(eventName => {
  document.addEventListener(eventName, () => {
    lastInteraction = Date.now();
  });
});

// ─── Menu du header ──────────────────────────────────────────────────────────
function toggleAppMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('appMenu');
  const open = !menu.classList.contains('active');
  menu.classList.toggle('active', open);
  document.getElementById('menuBtn').setAttribute('aria-expanded', String(open));
  if (open && typeof _setSyncState === 'function') _setSyncState(window.svSyncState || 'idle');
}
function closeAppMenu() {
  document.getElementById('appMenu')?.classList.remove('active');
  document.getElementById('menuBtn')?.setAttribute('aria-expanded', 'false');
}
function menuAction(fn) { closeAppMenu(); fn(); }
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeAppMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAppMenu(); });
