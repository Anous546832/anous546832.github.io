// ─── État ─────────────────────────────────────────────────────────────────────
let data = {};
let view = "creators", creator = null, category = null;
let isSearching = false;
let openSagas = {};
let skipAutoScroll = false;

// Cache pour les lookups lowercase (évite de muter les objets data)
const _lcCache = new WeakMap();
function _getLower(obj, key) {
  let cache = _lcCache.get(obj);
  if (!cache) { _lcCache.set(obj, cache = {}); }
  return cache[key] ?? (cache[key] = String(obj[key]).toLowerCase());
}

// ─── Chargement ──────────────────────────────────────────────────────────────
async function loadDatabase() {
  try {
    const r = await fetch('data/data.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
    // Migration anciennes clés
    ["nf_res_v21", "nf_wat_v21", "nf_time_v21"].forEach((k, i) => {
      const newKey = [RESUME_KEY, WATCHED_KEY, TIMECODE_KEY][i];
      const old = localStorage.getItem(k);
      if (old && !localStorage.getItem(newKey)) localStorage.setItem(newKey, old);
    });
    render();
    const last = Object.values(getResume()).sort((a, b) => b.time - a.time)[0];
    if (last?.creator && last?.category && last?.video) {
      creator = last.creator; category = last.category; view = "videos";
      loadVideo(last.video, last.chapterIndex || 0);
    }
  } catch (e) {
    document.getElementById("sidebarScroll").innerHTML = `<div style="color:var(--red);padding:20px;">⚠ ${e.message}</div>`;
  }
}

// ─── Render principal ────────────────────────────────────────────────────────
function render() {
  if (isSearching) return;
  renderBreadcrumb();
  const scroll = document.getElementById("sidebarScroll");
  const watched = getWatched(), resume = getResume(), timecodes = getTimecodes();
  scroll.innerHTML = "";

  if (view === "creators") {
    // Reprendre
    const recents = Object.entries(resume).sort((a, b) => b[1].time - a[1].time).slice(0, 4);
    if (recents.length) {
      const resumeLabel = document.createElement("div");
      resumeLabel.className = "section-label";
      resumeLabel.textContent = "Reprendre";
      scroll.appendChild(resumeLabel);

      recents.forEach(([k, item]) => {
        const catData = data[item.creator]?.categories[item.category];
        const icon = catData ? getCategoryIcon(item.category, catData) : '📁';
        const card = document.createElement("div");
        card.className = "resume-card";
        card.innerHTML = `<div class="resume-thumb" style="overflow:hidden;">${icon}</div>
          <div class="resume-info"><div class="resume-title">${item.video.title}</div><div class="resume-sub">${item.creatorName} · ${item.categoryName}</div></div>
          <button class="resume-delete">✕</button>`;
        card.onclick = () => { creator = item.creator; category = item.category; view = "videos"; loadVideo(item.video, item.chapterIndex || 0); };
        card.querySelector('.resume-delete').onclick = (e) => { e.stopPropagation(); deleteFromResume(k); render(); };
        scroll.appendChild(card);
      });

      const divider = document.createElement("div");
      divider.className = "divider";
      scroll.appendChild(divider);
    }

    // Créateurs
    const creatorsLabel = document.createElement("div");
    creatorsLabel.className = "section-label";
    creatorsLabel.textContent = "Créateurs";
    scroll.appendChild(creatorsLabel);

    Object.keys(data).forEach(k => {
      const el = document.createElement("div");
      el.className = "item";
      const catCount = Object.keys(data[k].categories).length;
      el.innerHTML = `<div class="item-left"><div class="item-icon">👤</div><div><div class="item-title">${data[k].name}</div><div class="search-result-sub">${catCount} série${catCount>1?'s':''}</div></div></div><span style="color:var(--text-dim);">›</span>`;
      el.onclick = () => { creator = k; view = "categories"; render(); };
      scroll.appendChild(el);
    });
  }
  else if (view === "categories") {
    scroll.innerHTML = `<button class="back-btn">← Retour</button><div class="section-label">${data[creator].name}</div>`;
    scroll.querySelector('.back-btn').onclick = () => { view = "creators"; creator = null; render(); };
    const grid = document.createElement("div"); grid.className = "cat-grid";
    Object.keys(data[creator].categories).forEach(k => {
      const cat = data[creator].categories[k];
      const total = cat.videos.length;
      const watchedCount = cat.videos.filter(v => watched.includes(v.id)).length;
      const card = document.createElement("div");
      card.className = "cat-card";
      card.innerHTML = `<div class="cat-card-icon">${getCategoryIcon(k, cat)}</div><div class="cat-card-info"><div class="cat-card-title">${cat.title}</div><div class="cat-card-count">${total} vidéos${watchedCount>0?` · ${watchedCount} vus`:''}</div></div>`;
      card.onclick = () => { category = k; view = "videos"; render(); };
      grid.appendChild(card);
    });
    scroll.appendChild(grid);
  }
  else if (view === "videos") {
    const catData = data[creator].categories[category];
    const videos = catData.videos;
    scroll.innerHTML = `<button class="back-btn">← ${data[creator].name}</button><div class="section-label">${catData.title}</div>`;
    scroll.querySelector('.back-btn').onclick = () => { view = "categories"; category = null; render(); };

    if (catData.sagas?.length) {
      // Construit sagaVideoIds en même temps qu'on render les sagas (évite la double boucle)
      const sagaVideoIds = new Set();

      catData.sagas.forEach(saga => {
        const sagaArcs = (catData.arcs && saga.arcIds)
          ? saga.arcIds.map(id => catData.arcs.find(a => a.id === id)).filter(Boolean)
          : [];
        const sagaVideos = sagaArcs.length
          ? videos.filter(v => v.startEp && sagaArcs.some(arc => v.startEp <= arc.endEp && v.endEp >= arc.startEp))
          : [...videos];
        if (!sagaVideos.length) return;

        sagaVideos.forEach(v => sagaVideoIds.add(v.id));

        const sagaHeader = document.createElement("div");
        sagaHeader.className = "saga-header";
        sagaHeader.innerHTML = `<span class="saga-icon">▶</span><div class="saga-info"><div class="saga-title">${saga.title}</div><div class="saga-count">${sagaVideos.length} vidéo${sagaVideos.length>1?'s':''}${sagaArcs.length ? ` · ${sagaArcs[0].startEp}-${sagaArcs[sagaArcs.length-1].endEp}` : ''}</div></div>`;
        const sagaContent = document.createElement("div");
        sagaContent.className = "saga-content";
        const sagaKey = creator + "__" + category + "__" + saga.title;
        const isCurrentCat = currentVideo && currentCreator === creator && currentCategory === category;
        const hasResumeVideo = sagaVideos.some(v => Object.values(resume).some(r => r.video?.id === v.id));
        const shouldOpen = openSagas[sagaKey] || (isCurrentCat && sagaVideos.some(v => v.id === currentVideo.id)) || (!isCurrentCat && hasResumeVideo);
        if (shouldOpen) { sagaHeader.classList.add("open"); sagaContent.classList.add("open"); openSagas[sagaKey] = true; }
        sagaHeader.onclick = () => {
          const isOpen = sagaContent.classList.contains("open");
          sagaContent.classList.toggle("open", !isOpen);
          sagaHeader.classList.toggle("open", !isOpen);
          openSagas[sagaKey] = !isOpen;
        };
        if (sagaArcs.length) {
          let lastArcId = null;
          sagaVideos.forEach(v => {
            const arc = getArcForEpisode(sagaArcs, v.startEp);
            if (arc && arc.id !== lastArcId) { sagaContent.appendChild(createArcHeaderElement(arc, catData)); lastArcId = arc.id; }
            const el = createVideoElement(v, catData, watched, timecodes, resume);
            el.classList.add("saga-indented");
            sagaContent.appendChild(el);
          });
        } else {
          sagaVideos.forEach(v => {
            const el = createVideoElement(v, catData, watched, timecodes, resume);
            el.classList.add("saga-indented");
            sagaContent.appendChild(el);
          });
        }
        scroll.appendChild(sagaHeader);
        scroll.appendChild(sagaContent);
      });

      // Vidéos hors saga — appendChild au lieu de innerHTML+= pour préserver les event listeners
      const remaining = videos.filter(v => !sagaVideoIds.has(v.id));
      if (remaining.length) {
        const hLabel = document.createElement("div");
        hLabel.className = "section-label";
        hLabel.style.marginTop = "16px";
        hLabel.textContent = "Hors saga";
        scroll.appendChild(hLabel);
        remaining.forEach(v => scroll.appendChild(createVideoElement(v, catData, watched, timecodes, resume)));
      }
    } else if (catData.arcs?.length) {
      let lastArcId = null;
      videos.forEach(v => {
        const arc = v.startEp ? getArcForEpisode(catData.arcs, v.startEp) : null;
        if (arc && arc.id !== lastArcId) { scroll.appendChild(createArcHeaderElement(arc, catData)); lastArcId = arc.id; }
        scroll.appendChild(createVideoElement(v, catData, watched, timecodes, resume));
      });
    } else {
      videos.forEach(v => scroll.appendChild(createVideoElement(v, catData, watched, timecodes, resume)));
    }

    const resetBtn = document.createElement("button");
    resetBtn.className = "reset-btn";
    resetBtn.textContent = "♻ Réinitialiser la série";
    resetBtn.onclick = unmarkAllInCategory;
    scroll.appendChild(resetBtn);

    setTimeout(() => {
      if (skipAutoScroll) { skipAutoScroll = false; return; }
      const sidebar = document.getElementById("sidebarScroll");
      let targetEl = scroll.querySelector('.item.active');
      if (!targetEl) {
        const resumeKey = creator + "__" + category;
        const catResume = resume[resumeKey];
        if (catResume?.video) targetEl = scroll.querySelector(`[data-video-id="${catResume.video.id}"]`);
      }
      if (targetEl) sidebar.scrollTop = Math.max(0, targetEl.offsetTop - sidebar.clientHeight * 0.25);
    }, 50);
  }
}

// ─── Breadcrumb ─────────────────────────────────────────────────────────────
function renderBreadcrumb() {
  const bc = document.getElementById("breadcrumb");
  if (isSearching) { bc.innerHTML = `<span class="crumb active">Recherche</span>`; return; }
  let parts = [`<span class="crumb ${view==='creators'?'active':''}" onclick="goTo('creators')">Accueil</span>`];
  if (view !== "creators" && creator) parts.push(`<span class="crumb-sep">›</span>`, `<span class="crumb ${view==='categories'?'active':''}" onclick="goTo('categories')">${data[creator]?.name||''}</span>`);
  if (view === "videos" && category) parts.push(`<span class="crumb-sep">›</span>`, `<span class="crumb active">${data[creator]?.categories[category]?.title||''}</span>`);
  bc.innerHTML = parts.join('');
}
function goTo(targetView) {
  if (targetView === 'creators') { view = "creators"; creator = null; category = null; }
  else if (targetView === 'categories') { view = "categories"; category = null; }
  render();
}

// ─── Recherche ─────────────────────────────────────────────────────────────
let searchTimeout = null;

function deepSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(_deepSearch, 150);
}

function _deepSearch() {
  const val = document.getElementById("searchInput").value.toLowerCase().trim();
  document.getElementById("clearSearchBtn").style.display = val ? "block" : "none";
  if (!val) { isSearching = false; render(); return; }
  isSearching = true;

  const scroll = document.getElementById("sidebarScroll");
  scroll.innerHTML = "";
  const label = document.createElement("div");
  label.className = "section-label";
  label.textContent = "Résultats";
  scroll.appendChild(label);

  let count = 0;

  // Utiliser creatorObj/catObj pour éviter de shadower les variables globales creator/category
  // (un shadow + assignation sur un const provoquerait un TypeError au clic)
  outer: for (const cK in data) {
    const creatorObj = data[cK];
    const creatorName = _getLower(creatorObj, 'name');
    for (const catK in creatorObj.categories) {
      const catObj = creatorObj.categories[catK];
      const categoryTitle = _getLower(catObj, 'title');
      const videos = catObj.videos;
      for (let i = 0; i < videos.length; i++) {
        const v = videos[i];
        const title = _getLower(v, 'title');
        if (title.includes(val) || creatorName.includes(val) || categoryTitle.includes(val)) {
          const el = document.createElement("div");
          el.className = "item";
          el.innerHTML = `
            <div class="item-left">
              <div class="item-icon">▶</div>
              <div>
                <div class="item-title">${v.title}</div>
                <div class="search-result-sub">${creatorObj.name} · ${catObj.title}${v.chapters?.length ? ` · ${v.chapters.length} chapitres` : ''}</div>
              </div>
            </div>`;
          el.onclick = () => { creator = cK; category = catK; view = "videos"; clearSearch(); loadVideo(v); };
          scroll.appendChild(el);
          if (++count >= 100) break outer;
        }
      }
    }
  }

  if (!count) {
    const noResult = document.createElement("div");
    noResult.style.cssText = "color:var(--text-dim);padding:16px 6px;";
    noResult.textContent = `Aucun résultat pour "${val}"`;
    scroll.appendChild(noResult);
  }
  renderBreadcrumb();
}

function clearSearch() {
  document.getElementById("searchInput").value = "";
  document.getElementById("clearSearchBtn").style.display = "none";
  isSearching = false;
  render();
}

// ─── Helpers Sagas/Arcs ──────────────────────────────────────────────────────
function getArcForEpisode(arcs, ep) {
  if (!arcs || !ep) return null;
  for (const arc of arcs) if (ep >= arc.startEp && ep <= arc.endEp) return arc;
  return null;
}
function createArcHeaderElement(arc, cat) {
  const header = document.createElement("div");
  header.className = "arc-header";
  const arcVideos = cat.videos.filter(v => v.startEp && v.startEp <= arc.endEp && v.endEp >= arc.startEp);
  header.innerHTML = `<span style="background:${arc.color};width:8px;height:8px;border-radius:50%;flex-shrink:0;box-shadow:0 0 8px ${arc.color}44;"></span>
    <span class="arc-header-title" style="border-color:${arc.color}33;color:${arc.color};">${arc.title}</span>
    <span class="arc-header-count">${arcVideos.length} vidéo${arcVideos.length>1?'s':''}</span><span class="arc-header-line"></span>`;
  return header;
}
function createVideoElement(v, catData, watched, timecodes, resume) {
  if (!watched) watched = getWatched();
  if (!timecodes) timecodes = getTimecodes();
  if (!resume) resume = getResume();
  const isW = watched.includes(v.id), isCurrent = currentVideo?.id === v.id;
  const tc = timecodes[v.id], displayTime = formatSeconds(tc);
  const isInResume = Object.values(resume).some(r => r.video?.id === v.id);
  const chapterCount = v.chapters?.length || 0;
  const el = document.createElement("div");
  el.className = `item ${isCurrent?'active':''} ${isW?'watched':''} ${isInResume && !isCurrent?'resume-marked':''}`;
  el.setAttribute('data-video-id', v.id);
  let nextArcDot = '';
  if (catData?.arcs && v.startEp && v.endEp) {
    const colors = [];
    catData.arcs.forEach(arc => { if (v.startEp <= arc.endEp && v.endEp >= arc.startEp) colors.push(arc); });
    if (colors.length > 1) nextArcDot = `<span style="display:inline-flex;align-items:center;gap:3px;margin-left:5px;font-size:9px;color:${colors[1].color};opacity:0.7;" title="${colors[1].title} (débute à l'épisode ${colors[1].startEp})"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${colors[1].color};box-shadow:0 0 5px ${colors[1].color}66;"></span>ép.${colors[1].startEp}</span>`;
  }
  el.innerHTML = `<div class="item-left"><div class="item-icon">${isCurrent?'▶':isW?'✓':'·'}</div><div><div class="item-title">${v.title}${nextArcDot}</div>${chapterCount?`<div class="search-result-sub">${chapterCount} chapitres</div>`:''}</div></div>
    <div class="item-right"><input type="text" class="time-input" placeholder="${isW?'✓':'—'}" value="${isW?'':displayTime}" onclick="event.stopPropagation()" onblur="saveTimecode('${v.id}', this.value)" ${isW?'disabled':''} style="${isW?'opacity:0.4;pointer-events:none;':''}"><div class="status-icon" title="${isW?'Marquer non vu':'Marquer vu'}">${isW?'✓':'+'}</div></div>`;
  el.onclick = () => loadVideo(v);
  el.querySelector('.status-icon').onclick = (e) => toggleWatched(v.id, e);
  return el;
}
function deleteFromResume(key) {
  const r = getResume();
  delete r[key];
  localStorage.setItem(RESUME_KEY, JSON.stringify(r));
}
function unmarkAllInCategory() {
  if (!confirm("Réinitialiser les épisodes vus de cette série ?")) return;
  const ids = new Set(data[creator].categories[category].videos.map(v => v.id));
  const w = getWatched().filter(id => !ids.has(id));
  localStorage.setItem(WATCHED_KEY, JSON.stringify(w));
  render();
}
