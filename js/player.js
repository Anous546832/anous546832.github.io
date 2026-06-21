// ─── Variables player ────────────────────────────────────────────────────────
let currentVideo = null, currentCreator = null, currentCategory = null;
let player = null;
let cinemaMode = false;
let currentChapterIndex = 0, chapterDropdownOpen = false;
let lastTimecodeSave = {}, lastTimecodeValue = {};
let inactivityPoints = [];
let lastInteraction = Date.now();
let lastInactivitySave = 0;

// ─── Escape HTML ─────────────────────────────────────────────────────────────
function _escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Buffer timecodes ─────────────────────────────────────────────────────────
// Évite un JSON.parse + JSON.stringify sur chaque timeupdate (~4×/sec).
// Les écritures localStorage sont limitées à 1 toutes les 5s pendant la lecture ;
// les événements importants (ended, page masquée, chargement vidéo) forcent un flush immédiat.
let _tcBuf = null;
let _lastTcWrite = 0;
const TC_WRITE_INTERVAL = 5000;

function _loadTcBuf() {
  if (!_tcBuf) _tcBuf = JSON.parse(localStorage.getItem(TIMECODE_KEY)) || {};
  return _tcBuf;
}
function _flushTc() {
  if (_tcBuf) {
    localStorage.setItem(TIMECODE_KEY, JSON.stringify(_tcBuf));
    _lastTcWrite = Date.now();
  }
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") _flushTc(); });
window.addEventListener("beforeunload", _flushTc);

// ─── Chapitres ───────────────────────────────────────────────────────────────
function getChapters(video) {
  if (!video) return [];
  const original = video.chapters || [];
  const dev = devChapters[video.id] || [];
  const merged = [...original];
  dev.forEach(ch => { if (!merged.some(m => Math.abs(m.start - ch.start) < 1)) merged.push(ch); });
  merged.sort((a, b) => a.start - b.start);
  return merged.length ? merged : [{ id: video.id + '_default', title: video.title, start: 0 }];
}
function findCurrentChapterIndex(time, chapters) {
  if (!chapters?.length) return 0;
  for (let i = chapters.length - 1; i >= 0; i--) if (time >= chapters[i].start) return i;
  return 0;
}
function toggleChapterDropdown(e) {
  e.stopPropagation();
  const chapters = getChapters(currentVideo);
  if (chapters.length <= 1) return;
  chapterDropdownOpen = !chapterDropdownOpen;
  document.getElementById("chapterDropdown").classList.toggle("active", chapterDropdownOpen);
  document.getElementById("chapterDisplay").classList.toggle("open", chapterDropdownOpen);
}
function closeChapterDropdown() {
  chapterDropdownOpen = false;
  document.getElementById("chapterDropdown").classList.remove("active");
  document.getElementById("chapterDisplay").classList.remove("open");
}
document.addEventListener('click', (e) => {
  if (chapterDropdownOpen && !e.target.closest('#chapterDisplay') && !e.target.closest('#chapterDropdown')) closeChapterDropdown();
});
function skipToChapter(index) {
  const chapters = getChapters(currentVideo);
  if (!chapters[index]) return;
  currentChapterIndex = index;
  const chapter = chapters[index];
  closeChapterDropdown();
  if (player) player.setCurrentTime(chapter.start);
  updateChapterDisplay(chapter, chapters);
  updateChapterDropdownHighlight(index);
  saveTimecode(currentVideo.id, chapter.start);
}
function updateChapterDisplay(chapter, chapters) {
  const display = document.getElementById("chapterDisplay");
  const titleDisplay = document.getElementById("chapterTitleDisplay");
  if (chapters.length <= 1) {
    display.style.display = "flex"; display.querySelector(".chapter-label").textContent = "EN COURS";
    titleDisplay.textContent = chapter.title; display.style.cursor = "default"; return;
  }
  display.style.display = "flex"; display.querySelector(".chapter-label").textContent = "CHAPITRE";
  titleDisplay.textContent = chapter.title; display.style.cursor = "pointer";
  buildChapterDropdown(chapters);
}
function buildChapterDropdown(chapters) {
  const watched = getWatched();
  // ch.id peut être absent sur les chapitres devmode → fallback sur ch.start comme clé
  document.getElementById("chapterDropdown").innerHTML = `
    <div class="chapter-dropdown-header"><span>${chapters.length} chapitres</span></div>
    <div class="chapter-dropdown-scroll">${chapters.map((ch, i) => `
      <div class="chapter-item ${i === currentChapterIndex ? 'current' : ''}" data-chapter-index="${i}" onclick="skipToChapter(${i})">
        <div class="chapter-item-num">${i + 1}</div><div class="chapter-item-info"><div class="chapter-item-title">${_escHtml(ch.title)}</div><div class="chapter-item-time">${ch.start > 0 ? formatSeconds(ch.start) : 'Début'}</div></div>
        <span class="chapter-item-status">${watched.includes(currentVideo.id + '_ch_' + (ch.id ?? ch.start)) ? '✓' : ''}</span>
      </div>`).join('')}</div>`;
}
function updateChapterDropdownHighlight(index) {
  document.querySelectorAll('#chapterDropdown .chapter-item').forEach(item => item.classList.toggle('current', parseInt(item.dataset.chapterIndex) === index));
}

// ─── Timecode ────────────────────────────────────────────────────────────────
// immediate=true : écrit localStorage maintenant (actions utilisateur, ended, etc.)
// immediate=false : throttle à TC_WRITE_INTERVAL (appelé depuis timeupdate)
function saveTimecode(id, value, immediate = true) {
  const sec = typeof value === 'string' ? parseTimeToSeconds(value) : value;
  _loadTcBuf()[id] = sec;

  const now = Date.now();
  if (immediate || now - _lastTcWrite >= TC_WRITE_INTERVAL) _flushTc();

  if (!lastTimecodeSave[id] || now - lastTimecodeSave[id] >= 20000) {
    if (lastTimecodeValue[id] !== sec) { lastTimecodeSave[id] = now; lastTimecodeValue[id] = sec; saveWithSync(); }
  }
}
function toggleWatched(id, e) {
  e.stopPropagation();
  let w = getWatched();
  if (w.includes(id)) w = w.filter(wId => wId !== id);
  else {
    w.push(id);
    // Supprime le timecode de la vidéo du buffer mémoire puis flush immédiatement
    delete _loadTcBuf()[id];
    _flushTc();
  }
  localStorage.setItem(WATCHED_KEY, JSON.stringify(w));
  saveWithSync(); skipAutoScroll = true; render();
}

// ─── Lecture vidéo ───────────────────────────────────────────────────────────
function loadVideo(v, chapterIndex = 0) {
  if (!v) return;
  _flushTc(); // persiste le timecode de la vidéo précédente avant de changer
  document.getElementById("nextOverlay").style.display = "none";
  currentVideo = v; currentCreator = creator; currentCategory = category; currentChapterIndex = chapterIndex;
  inactivityPoints = [];
  lastInteraction = Date.now();
  lastInactivitySave = 0;
  const chapters = getChapters(v);
  const chapter = chapters[chapterIndex] || chapters[0];
  updateChapterDisplay(chapter, chapters);

  const resume = getResume();
  resume[creator + "__" + category] = { video: v, creator, creatorName: data[creator].name, categoryName: data[creator].categories[category].title, category, time: Date.now(), chapterIndex };
  localStorage.setItem(RESUME_KEY, JSON.stringify(resume));
  saveWithSync();

  const url = `https://cdn.embedly.com/widgets/media.html?src=https%3A%2F%2Fstreamable.com%2Fe%2F${v.id}&display_name=Streamable&url=${encodeURIComponent("https://streamable.com/"+v.id)}&key=96a16496e36611e091d14040d3dc5c07&type=text%2Fhtml&schema=streamable`;
  document.getElementById("videoArea").innerHTML = `<iframe id="main-player" src="${url}" allowfullscreen scrolling="no"></iframe>`;
  player = new playerjs.Player(document.getElementById("main-player"));

  player.on('ready', () => {
    player.setLoop(false); // doit être appelé après ready (API playerjs)

    const saved = _loadTcBuf()[v.id];
    const targetTime = (chapterIndex > 0 && chapter.start > 0) ? chapter.start : (saved || 0);
    if (targetTime > 0) player.setCurrentTime(targetTime);

    player.on('pause', () => { if (isWatchHost && watchChannel && currentVideo) sendWatchEvent(true); });
    player.on('play',  () => { if (isWatchHost && watchChannel && currentVideo) sendWatchEvent(false); });

    player.on('timeupdate', res => {
      if (res.seconds > 0) {
        saveTimecode(v.id, res.seconds, false); // false = throttlé, pas d'écriture à chaque tick

        const now = Date.now();
        if (now - lastInteraction > 1200000 && now - lastInactivitySave > 1200000) {
          inactivityPoints.push({ timecode: Math.floor(res.seconds), timestamp: now });
          lastInactivitySave = now;
        }
        const activeInput = document.querySelector('.item.active .time-input');
        if (activeInput) activeInput.value = formatSeconds(res.seconds);
        const newIdx = findCurrentChapterIndex(res.seconds, chapters);
        if (newIdx !== currentChapterIndex) { currentChapterIndex = newIdx; updateChapterDisplay(chapters[newIdx], chapters); updateChapterDropdownHighlight(newIdx); }
      }
    });

    player.on('ended', () => {
      _flushTc(); // flush avant de remettre à 0 pour ne pas perdre la position max atteinte
      saveTimecode(v.id, 0);
      showNextOverlay();
    });
  });

  checkNextVideoOrChapter(); render();
  if (window.innerWidth <= 768 && !cinemaMode) toggleCinema();
  if (devMode) openDevPanel();
}

function sendWatchEvent(isPaused) {
  const tc = _loadTcBuf()[currentVideo.id] || 0;
  watchChannel.send({ type: 'broadcast', event: 'sync', payload: { timecode: Math.floor(tc), videoId: currentVideo.id, sentAt: Date.now(), isPaused } });
}

// ─── Suivant / Overlay ──────────────────────────────────────────────────────
function getNextChapterOrVideo() {
  if (!currentVideo || !currentCreator || !currentCategory) return null;
  const vids = data[currentCreator].categories[currentCategory].videos;
  const vidIdx = vids.findIndex(v => v.id === currentVideo.id);
  if (vidIdx !== -1 && vidIdx < vids.length - 1) return { type: 'video', video: vids[vidIdx + 1], chapterIndex: 0 };
  const chapters = getChapters(currentVideo);
  const currentIdx = findCurrentChapterIndex(_loadTcBuf()[currentVideo.id] || 0, chapters);
  if (currentIdx < chapters.length - 1) return { type: 'chapter', video: currentVideo, chapterIndex: currentIdx + 1, chapter: chapters[currentIdx + 1] };
  return null;
}
function loadNextVideoOrChapter() {
  const next = getNextChapterOrVideo();
  if (!next) return;
  if (next.type === 'video' && currentVideo) {
    const w = getWatched();
    if (!w.includes(currentVideo.id)) {
      w.push(currentVideo.id);
      delete _loadTcBuf()[currentVideo.id];
      localStorage.setItem(WATCHED_KEY, JSON.stringify(w));
      saveWithSync();
    }
  }
  loadVideo(next.video, next.chapterIndex);
}
function checkNextVideoOrChapter() {
  const btn = document.getElementById("headerNextBtn"), overlay = document.getElementById("nextOverlay");
  const next = getNextChapterOrVideo();
  if (!next) { btn.style.display = "none"; overlay.style.display = "none"; return; }
  btn.style.display = "block"; btn.textContent = next.type === 'chapter' ? 'Chapitre suivant →' : 'Épisode suivant →';
  document.getElementById("nextTitle").textContent = next.type === 'chapter' ? next.chapter.title : next.video.title;
}
function showNextOverlay() {
  const overlay = document.getElementById("nextOverlay");
  if (!currentVideo || !currentCreator || !currentCategory) { overlay.style.display = "none"; return; }

  const vids = data[currentCreator].categories[currentCategory].videos;
  const idx = vids.findIndex(v => v.id === currentVideo.id);

  if (idx !== -1 && idx < vids.length - 1) {
    const nextVideo = vids[idx + 1];
    const hasPoints = inactivityPoints.length > 0;

    document.getElementById("nextTitle").textContent = nextVideo.title;
    // overlay est déjà la référence, pas besoin de getElementById une seconde fois
    const pEl = overlay.querySelector("p");
    if (pEl) pEl.textContent = "ÉPISODE SUIVANT";

    // Nettoie les éléments inactivité de la session précédente
    document.getElementById("inactivitySelect")?.remove();
    document.getElementById("resumeInactivityBtn")?.remove();

    if (hasPoints) {
      const select = document.createElement("select");
      select.id = "inactivitySelect";
      select.style.cssText = "width:100%;margin-bottom:8px;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px;font-size:11px;font-family:var(--font-body);box-sizing:border-box;";
      select.innerHTML = `<option value="">💤 Moments d'inactivité</option>
        ${inactivityPoints.slice().reverse().map(p => `<option value="${p.timecode}">${formatSeconds(p.timecode)}</option>`).join('')}`;

      const btn = document.createElement("button");
      btn.id = "resumeInactivityBtn";
      btn.className = "btn btn-ghost";
      btn.style.cssText = "width:100%;margin-bottom:4px;";
      btn.textContent = "↩ Reprendre au point sélectionné";
      btn.onclick = resumeFromInactivity;

      const primaryBtn = overlay.querySelector(".btn-primary");
      overlay.insertBefore(btn, primaryBtn);
      overlay.insertBefore(select, primaryBtn);
    }

    overlay.style.display = "block";
  } else {
    overlay.style.display = "none";
  }
}

function resumeFromInactivity() {
  const select = document.getElementById("inactivitySelect");
  if (!select || !select.value) return;
  const timecode = parseInt(select.value);
  document.getElementById("nextOverlay").style.display = "none";
  if (player && currentVideo) {
    player.setCurrentTime(timecode);
    player.play();
    document.getElementById("headerNextBtn").style.display = "none";
  }
}

// ─── Cinéma ─────────────────────────────────────────────────────────────────
function toggleCinema() {
  cinemaMode = !cinemaMode;
  document.getElementById("list").classList.toggle("hidden", cinemaMode);
  document.getElementById("searchBarArea").classList.toggle("cinema-hidden", cinemaMode);
  document.getElementById("cinemaBtnHeader").textContent = cinemaMode ? "⊟" : "⊞";
}
