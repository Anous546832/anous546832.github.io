// ─── Constantes localStorage ──────────────────────────────────────────────────
const RESUME_KEY   = "sv_res_v1";
const WATCHED_KEY  = "sv_wat_v1";
const TIMECODE_KEY = "sv_time_v1";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatSeconds(s) {
  if (!s || isNaN(s) || s < 1) return "";
  const d = new Date(null);
  d.setSeconds(Math.floor(s));
  return s >= 3600 ? d.toISOString().substr(11, 8) : d.toISOString().substr(14, 5);
}

function parseTimeToSeconds(str) {
  if (!str || !str.includes(':')) return 0;
  const p = str.split(':').reverse();
  return (parseInt(p[0]) || 0) + (parseInt(p[1]) || 0) * 60 + (parseInt(p[2]) || 0) * 3600;
}

function getCategoryIcon(key, cat) {
  if (cat && cat.image) {
    return `<img src="${cat.image}" alt="${cat.title}" 
      style="width:100%; height:100%; object-fit:cover; border-radius:inherit;" 
      onerror="this.parentElement.textContent='📁'">`;
  }
  const icons = { hxh: '⚡', narutokai: '🍃', shippuden: '🔥', onepiece: '⚓', parasite: '🕷️' };
  return icons[key] || '📁';
}

const getResume    = () => JSON.parse(localStorage.getItem(RESUME_KEY)) || {};
const getWatched   = () => JSON.parse(localStorage.getItem(WATCHED_KEY)) || [];
const getTimecodes = () => JSON.parse(localStorage.getItem(TIMECODE_KEY)) || {};