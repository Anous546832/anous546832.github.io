// ─── Init ─────────────────────────────────────────────────────────────────────
console.error = (...a) => { if (typeof a[0] === 'string' && (a[0].includes('WebSocket') || a[0].includes('socket'))) return; console.error.apply(console, a); };

loadDevChapters();

document.addEventListener("DOMContentLoaded", async () => {
  await loadDatabase();
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'D') { e.preventDefault(); toggleDevMode(); }
});