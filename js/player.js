// ─── Variables player ────────────────────────────────────────────────────────
let currentVideo = null, currentCreator = null, currentCategory = null;
let player = null;
let cinemaMode = false;
let currentChapterIndex = 0, chapterDropdownOpen = false;
let lastTimecodeSave = {}, lastTimecodeValue = {};

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
  document.getElementById("chapterDropdown").innerHTML = `
    <div class="chapter-dropdown-header"><span>${chapters.length} chapitres</span></div>
    <div class="chapter-dropdown-scroll">${chapters.map((ch, i) => `
      <div class="chapter-item ${i === currentChapterIndex ? 'current' : ''}" data-chapter-index="${i}" onclick="skipToChapter(${i})">
        <div class="chapter-item-num">${i + 1}</div><div class="chapter-item-info"><div class="chapter-item-title">${ch.title}</div><div class="chapter-item-time">${ch.start > 0 ? formatSeconds(ch.start) : 'Début'}</div></div>
        <span class="chapter-item-status">${watched.includes(currentVideo.id + '_ch_' + ch.id) ? '✓' : ''}</span>
      </div>`).join('')}</div>`;
}
function updateChapterDropdownHighlight(index) {
  document.querySelectorAll('#chapterDropdown .chapter-item').forEach(item => item.classList.toggle('current', parseInt(item.dataset.chapterIndex) === index));
}

// ─── Timecode ────────────────────────────────────────────────────────────────
function saveTimecode(id, value) {
  const sec = typeof value === 'string' ? parseTimeToSeconds(value) : value;
  const t = getTimecodes(); t[id] = sec;
  localStorage.setItem(TIMECODE_KEY, JSON.stringify(t));
  const now = Date.now();
  if (!lastTimecodeSave[id] || now - lastTimecodeSave[id] >= 20000) {
    if (lastTimecodeValue[id] !== sec) { lastTimecodeSave[id] = now; lastTimecodeValue[id] = sec; saveWithSync(); }
  }
}
function toggleWatched(id, e) {
  e.stopPropagation();
  let w = getWatched();
  if (w.includes(id)) w = w.filter(i => i !== id);
  else { w.push(id); const t = getTimecodes(); delete t[id]; localStorage.setItem(TIMECODE_KEY, JSON.stringify(t)); }
  localStorage.setItem(WATCHED_KEY, JSON.stringify(w));
  saveWithSync(); skipAutoScroll = true; render();
}

// ─── Lecture vidéo ───────────────────────────────────────────────────────────
function loadVideo(v, chapterIndex = 0) {
  if (!v) return;
  currentVideo = v; currentCreator = creator; currentCategory = category; currentChapterIndex = chapterIndex;
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
  player.setLoop(false);

  player.on('ready', () => {
    const saved = getTimecodes()[v.id];
    const targetTime = (chapterIndex > 0 && chapter.start > 0) ? chapter.start : (saved || 0);
    if (targetTime > 0) player.setCurrentTime(targetTime);

    player.on('pause', () => { if (isWatchHost && watchChannel && currentVideo) sendWatchEvent(true); });
    player.on('play', () => { if (isWatchHost && watchChannel && currentVideo) sendWatchEvent(false); });

    player.on('timeupdate', res => {
      if (res.seconds > 0) {
        saveTimecode(v.id, res.seconds);
        const activeInput = document.querySelector('.item.active .time-input');
        if (activeInput) activeInput.value = formatSeconds(res.seconds);
        const newIdx = findCurrentChapterIndex(res.seconds, chapters);
        if (newIdx !== currentChapterIndex) { currentChapterIndex = newIdx; updateChapterDisplay(chapters[newIdx], chapters); updateChapterDropdownHighlight(newIdx); }
      }
    });
    player.on('ended', () => { saveTimecode(v.id, 0); showNextOverlay(); });
  });
  checkNextVideoOrChapter(); render();
  if (window.innerWidth <= 768 && !cinemaMode) toggleCinema();
  if (devMode) openDevPanel();
}

function sendWatchEvent(isPaused) {
  const tc = getTimecodes()[currentVideo.id] || 0;
  watchChannel.send({ type: 'broadcast', event: 'sync', payload: { timecode: Math.floor(tc), videoId: currentVideo.id, sentAt: Date.now(), isPaused } });
}

// ─── Suivant / Overlay ──────────────────────────────────────────────────────
function getNextChapterOrVideo() {
  if (!currentVideo || !currentCreator || !currentCategory) return null;
  const vids = data[currentCreator].categories[currentCategory].videos;
  const vidIdx = vids.findIndex(v => v.id === currentVideo.id);
  if (vidIdx !== -1 && vidIdx < vids.length - 1) return { type: 'video', video: vids[vidIdx + 1], chapterIndex: 0 };
  const chapters = getChapters(currentVideo);
  const timecodes = getTimecodes();
  const currentIdx = findCurrentChapterIndex(timecodes[currentVideo.id] || 0, chapters);
  if (currentIdx < chapters.length - 1) return { type: 'chapter', video: currentVideo, chapterIndex: currentIdx + 1, chapter: chapters[currentIdx + 1] };
  return null;
}
function checkNextVideoOrChapter() {
  const btn = document.getElementById("headerNextBtn"), overlay = document.getElementById("nextOverlay");
  const next = getNextChapterOrVideo();
  if (!next) { btn.style.display = "none"; overlay.style.display = "none"; return; }
  btn.style.display = "block"; btn.textContent = next.type === 'chapter' ? 'Chapitre suivant →' : 'Épisode suivant →';
  document.getElementById("nextTitle").textContent = next.type === 'chapter' ? next.chapter.title : next.video.title;
}
function showNextOverlay() {
  if (!currentVideo || !currentCreator || !currentCategory) return;
  const vids = data[currentCreator].categories[currentCategory].videos;
  const idx = vids.findIndex(v => v.id === currentVideo.id);
  if (idx !== -1 && idx < vids.length - 1) {
    document.getElementById("nextOverlay").querySelector('p').textContent = 'ÉPISODE SUIVANT';
    document.getElementById("nextTitle").textContent = vids[idx + 1].title;
    document.getElementById("nextOverlay").style.display = "block";
  } else document.getElementById("nextOverlay").style.display = "none";
}
function loadNextVideoOrChapter() {
  document.getElementById("nextOverlay").style.display = "none";
  const next = getNextChapterOrVideo();
  if (!next) return;
  if (next.type === 'video') {
    if (currentVideo) { const t = getTimecodes(); delete t[currentVideo.id]; localStorage.setItem(TIMECODE_KEY, JSON.stringify(t)); let w = getWatched(); if (!w.includes(currentVideo.id)) { w.push(currentVideo.id); localStorage.setItem(WATCHED_KEY, JSON.stringify(w)); } saveWithSync(); }
    creator = currentCreator; category = currentCategory; loadVideo(next.video, 0);
  } else skipToChapter(next.chapterIndex);
}

// ─── Cinéma ─────────────────────────────────────────────────────────────────
function toggleCinema() {
  cinemaMode = !cinemaMode;
  document.getElementById("list").classList.toggle("hidden", cinemaMode);
  document.getElementById("searchBarArea").classList.toggle("cinema-hidden", cinemaMode);
  document.getElementById("cinemaBtnHeader").textContent = cinemaMode ? "⊟" : "⊞";
}