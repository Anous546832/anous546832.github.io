// ─── Variables mode dev ──────────────────────────────────────────────────────
let devMode = false;
let devChapters = {};

function loadDevChapters() {
  const saved = localStorage.getItem("sv_dev_chapters");
  if (saved) devChapters = JSON.parse(saved);
}
function saveDevChapters() { localStorage.setItem("sv_dev_chapters", JSON.stringify(devChapters)); }

function toggleDevMode() {
  devMode = !devMode;
  document.getElementById("devBadge").classList.toggle("active", devMode);
  if (!devMode) document.getElementById("devPanel").classList.remove("active");
  else openDevPanel();
}
function closeDevPanel() { devMode = false; document.getElementById("devPanel").classList.remove("active"); document.getElementById("devBadge").classList.remove("active"); }
function openDevPanel() {
  document.getElementById("devPanel").classList.add("active");
  const devTitle = document.getElementById("devPanelTitleText");
  devTitle.innerHTML = `🛠 Ajouter un chapitre <span style="font-size:8px;opacity:0.5;margin-left:8px;word-break:break-all;">ID: ${syncId}</span>`;
  const grabBtn = document.getElementById("devTimeInput").nextElementSibling;
  const addBtn = document.querySelector('.btn-dev-add');
  const timeInput = document.getElementById("devTimeInput"), titleInput = document.getElementById("devTitleInput");
  const chapterList = document.getElementById("devChapterList"), clearBtn = document.querySelector('.dev-actions .btn-dev-close');
  if (currentVideo) {
    timeInput.disabled = false; timeInput.placeholder = "00:00"; titleInput.disabled = false; titleInput.placeholder = "Nom du chapitre (ex: Épisode 4)";
    if (grabBtn) { grabBtn.disabled = false; grabBtn.style.opacity = "1"; }
    if (addBtn) { addBtn.disabled = false; addBtn.style.opacity = "1"; }
    if (clearBtn) { clearBtn.disabled = false; clearBtn.style.opacity = "1"; }
    chapterList.style.opacity = "1";
    renderDevChapters();
  } else {
    timeInput.disabled = true; timeInput.placeholder = "Aucune vidéo"; titleInput.disabled = true; titleInput.placeholder = "Lance une vidéo d'abord";
    if (grabBtn) { grabBtn.disabled = true; grabBtn.style.opacity = "0.4"; }
    if (addBtn) { addBtn.disabled = true; addBtn.style.opacity = "0.4"; }
    if (clearBtn) { clearBtn.disabled = true; clearBtn.style.opacity = "0.4"; }
    chapterList.innerHTML = `<div style="color:var(--text-dim);font-size:11px;padding:12px;text-align:center;">Lance une vidéo pour gérer les chapitres</div>`;
    chapterList.style.opacity = "0.5";
  }
}
function grabCurrentTime() {
  if (!player || !currentVideo) return;
  const currentTime = getTimecodes()[currentVideo.id] || 0;
  document.getElementById("devTimeInput").value = formatSeconds(Math.floor(currentTime)) || "0:00";
}
function addChapter() {
  if (!currentVideo) return;
  const timeInput = document.getElementById("devTimeInput").value.trim();
  const titleInput = document.getElementById("devTitleInput").value.trim();
  if (!titleInput) { alert("Veuillez entrer un nom de chapitre"); return; }
  const seconds = timeInput ? parseTimeToSeconds(timeInput) : 0;
  if (!devChapters[currentVideo.id]) devChapters[currentVideo.id] = [];
  if ((devChapters[currentVideo.id] || []).some(ch => ch.start === seconds) || (currentVideo.chapters || []).some(ch => ch.start === seconds)) {
    alert("Un chapitre existe déjà à ce timecode"); return;
  }
  devChapters[currentVideo.id].push({ title: titleInput, start: seconds });
  devChapters[currentVideo.id].sort((a, b) => a.start - b.start);
  saveDevChapters(); renderDevChapters(); document.getElementById("devTitleInput").value = "";
}
function deleteDevChapterFull(videoId, start, source) {
  if (source === 'local') { if (devChapters[videoId]) { devChapters[videoId] = devChapters[videoId].filter(ch => ch.start !== start); if (!devChapters[videoId].length) delete devChapters[videoId]; } saveDevChapters(); }
  else if (source === 'data' && currentVideo?.chapters) { currentVideo.chapters = currentVideo.chapters.filter(ch => ch.start !== start); if (!currentVideo.chapters.length) delete currentVideo.chapters; }
  renderDevChapters();
  if (player) { const chapters = getChapters(currentVideo); const currentTime = (getTimecodes()[currentVideo.id] || 0); const idx = findCurrentChapterIndex(currentTime, chapters); updateChapterDisplay(chapters[idx] || chapters[0], chapters); }
}
function renderDevChapters() {
  if (!currentVideo) return;
  const list = document.getElementById("devChapterList");
  const videoId = currentVideo.id;
  const originalChapters = currentVideo.chapters || [];
  const localChapters = devChapters[videoId] || [];
  const allChapters = [...originalChapters.map(ch => ({ ...ch, source: 'data' })), ...localChapters.map(ch => ({ ...ch, source: 'local' }))].sort((a, b) => (a.start || 0) - (b.start || 0));
  const unique = []; const seen = new Set();
  allChapters.forEach(ch => { if (!seen.has(ch.start)) { seen.add(ch.start); unique.push(ch); } });
  if (!unique.length) { list.innerHTML = `<div style="color:var(--text-dim);font-size:11px;padding:12px;text-align:center;">Aucun chapitre</div>`; return; }
  list.innerHTML = unique.map((ch, i) => `<div class="dev-chapter-item" style="${ch.source==='local'?'border-left:2px solid #ff8800;':''}">
    <span style="color:${ch.source==='local'?'#ff8800':'var(--text-dim)'};font-weight:600;">#${i+1}</span> <span class="dev-chapter-time">${formatSeconds(ch.start)}</span> <span class="dev-chapter-name">${ch.title}</span>
    ${ch.source==='local'?'<span style="font-size:8px;color:#ff8800;">LOCAL</span>':''}
    <button class="dev-chapter-delete" onclick="deleteDevChapterFull('${videoId}',${ch.start},'${ch.source}')">✕</button></div>`).join('');
}
function clearDevChapters() {
  if (!currentVideo) return;
  if (!confirm("Supprimer TOUS les chapitres (data.json ET locaux) ?")) return;
  if (currentVideo.chapters) delete currentVideo.chapters;
  delete devChapters[currentVideo.id]; saveDevChapters(); renderDevChapters();
  if (player) { const chapters = getChapters(currentVideo); updateChapterDisplay(chapters[0], chapters); }
}

// ─── Export data.json / Progression ──────────────────────────────────────────
function exportDataJson() {
  if (!confirm("Générer un fichier data.json avec vos chapitres ?")) return;
  const exportData = JSON.parse(JSON.stringify(data));
  Object.keys(devChapters).forEach(videoId => {
    Object.keys(exportData).forEach(creatorKey => Object.keys(exportData[creatorKey].categories).forEach(catKey => {
      exportData[creatorKey].categories[catKey].videos.forEach((video, idx) => {
        if (video.id !== videoId) return;
        const existing = video.chapters || [];
        const local = devChapters[videoId] || [];
        const merged = [...existing];
        local.forEach(ch => { if (!merged.some(m => m.start === ch.start)) merged.push(ch); });
        merged.sort((a, b) => (a.start || 0) - (b.start || 0));
        if (merged.length) exportData[creatorKey].categories[catKey].videos[idx].chapters = merged;
      });
    }));
  });
  const minify = confirm("Minifier ? (OK = compact, Annuler = formaté)");
  let jsonStr = JSON.stringify(exportData, null, 2);
  if (minify) {
    jsonStr = jsonStr.replace(/"arcIds": \[\s*\n((?:\s*"[^"]*",?\s*\n)*)\s*\]/g, (m, c) => '"arcIds": [' + (c.match(/"[^"]*"/g) || []).join(', ') + ' ]');
    jsonStr = jsonStr.replace(/\{\s*\n\s*"title": ("[^"]*"),\s*\n\s*("arcIds": \[[^\]]*\])\s*\n\s*\}/g, '{ "title": $1, $2 }');
    jsonStr = jsonStr.replace(/(\s*)\{\s*\n\1\s*"id": ("[^"]*"),\s*\n\1\s*"title": ("[^"]*"),\s*\n\1\s*"startEp": (\d+),\s*\n\1\s*"endEp": (\d+),\s*\n\1\s*"chapters":/g, '$1{ "id": $2, "title": $3, "startEp": $4, "endEp": $5, "chapters":');
    jsonStr = jsonStr.replace(/(\s*)(\{(?:\s*"[^"]+":\s*(?:"[^"]*"|\d+|true|false|null),\s*)*\s*"[^"]+":\s*(?:"[^"]*"|\d+|true|false|null)\s*\})/g, (match, spaces, obj) => spaces + obj.replace(/\n\s*/g, ' ').replace(/,\s*/g, ', ').replace(/\s+/g, ' ').trim());
    jsonStr = jsonStr.replace(/\n\s*\n/g, '\n');
  }
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'data.json'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  if (confirm("Export réussi ! Effacer les chapitres locaux ?")) { devChapters = {}; saveDevChapters(); if (currentVideo) renderDevChapters(); }
}
function copyProgress() {
  const progress = { resume: getResume(), watched: getWatched(), timecodes: getTimecodes() };
  const jsonStr = JSON.stringify(progress);
  navigator.clipboard.writeText(jsonStr).then(() => alert("✅ Progression copiée !"))
    .catch(() => { const ta = document.createElement('textarea'); ta.value = jsonStr; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); alert("✅ Progression copiée !"); });
}
function importProgress() {
  const input = prompt("Colle ici ta progression sauvegardée :");
  if (!input) return;
  try {
    const progress = JSON.parse(input);
    if (!progress.resume && !progress.watched && !progress.timecodes) throw new Error("Format invalide");
    if (confirm("⚠ Remplacer toute ta progression actuelle ?")) {
      if (progress.resume) localStorage.setItem(RESUME_KEY, JSON.stringify(progress.resume));
      if (progress.watched) localStorage.setItem(WATCHED_KEY, JSON.stringify(progress.watched));
      if (progress.timecodes) localStorage.setItem(TIMECODE_KEY, JSON.stringify(progress.timecodes));
      alert("✅ Progression importée ! Rechargement..."); location.reload();
    }
  } catch(e) { alert("❌ Format invalide."); }
}