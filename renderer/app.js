// HAMMS Studios Launcher — UI
const api = window.hamms;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  games: [],
  pc: null,
  view: { name: 'store' },
  progress: {}, // id -> { phase, percent, done, total, label }
  launcherUpdateReady: false,
  offline: false,
  heroIndex: 0,
  lightbox: { list: [], i: 0 },
};
let heroTimer = null;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const url = (u) => (u ? `url('${String(u).replace(/'/g, '%27').replace(/"/g, '%22')}')` : 'none');
function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 5000);
}
const game = (id) => state.games.find((g) => g.id === id);
const isOwned = (g) => !!g.installedVersion || (g.type === 'web' && g.status === 'web');
const buildLabel = (b) => (b === 'lite' ? 'Low Spec' : 'High');

function statusLine(g) {
  const p = state.progress[g.id];
  if (p?.phase === 'download') return p.percent != null ? `Downloading ${p.percent}%` : 'Downloading…';
  if (p?.phase === 'extract') return 'Installing…';
  if (p?.phase === 'prepare') return p.label || 'Optimizing shaders';
  if (g.status === 'coming-soon') return 'Coming soon';
  if (state.launcherUpdateReady || g.launcherTooOld) return 'Restart launcher to play';
  return {
        'not-installed': g.onDevice ? 'Already on this PC · add it, no download' : g.size ? `Not installed · ${fmtBytes(g.size)}` : 'Not installed',
    'update-available': `Update required · v${g.version}`,
    'switch-build': `Switching to ${buildLabel(g.selectedBuild)}`,
    installed: `v${g.installedVersion} · ${buildLabel(g.installedBuild)}`,
    web: 'Plays in launcher',
    running: 'Playing now',
    working: 'Working…',
  }[g.status] || '';
}

// ---------- the main action button (same everywhere) ----------
function actionButton(g, { compact = false } = {}) {
  const p = state.progress[g.id];
  if (p && ['download', 'extract', 'prepare'].includes(p.phase)) {
    const label = p.phase === 'download' ? (g.installedVersion ? 'Updating' : 'Downloading') : p.phase === 'extract' ? 'Installing' : (p.label || 'Optimizing shaders');
    const right = p.phase === 'download' && p.total ? `${fmtBytes(p.done)} / ${fmtBytes(p.total)}` : '';
    const indet = p.percent == null || p.phase !== 'download';
    return `<div class="progress">
        <div class="progress-top"><b>${esc(label)}${p.phase === 'download' && p.percent != null ? ` ${p.percent}%` : '…'}</b><span>${esc(right)}</span></div>
        <div class="bar ${indet ? 'indeterminate' : ''}"><div style="width:${p.percent || 0}%"></div></div>
      </div>
      ${p.phase === 'download' && !compact ? '<button class="btn ghost small" data-act="cancel" style="margin-top:10px;width:100%">Cancel</button>' : ''}`;
  }
  if (g.status === 'coming-soon') return `<button class="btn soon" disabled>Coming soon</button>`;
  if (state.launcherUpdateReady || g.launcherTooOld) return `<button class="btn update" data-act="restart">Restart to update</button>`;
  switch (g.status) {
    case 'not-installed': return g.onDevice ? `<button class="btn play" data-act="install">Add to library</button>` : `<button class="btn play" data-act="install">Install</button>`;
    case 'update-available': return `<button class="btn update" data-act="install">Update</button>`;
    case 'switch-build': return `<button class="btn update" data-act="install">Download ${buildLabel(g.selectedBuild)}</button>`;
    case 'running': return `<button class="btn play" disabled>Playing</button>`;
    default: return `<button class="btn play" data-act="play">Play</button>`;
  }
}

// ---------- STORE ----------
function renderStore() {
  const games = state.games;
  const originals = games.filter((g) => !g.partner);
  const partners = games.filter((g) => g.partner);
  let featured = games.filter((g) => g.featured && g.media.banner);
  if (!featured.length) featured = games.filter((g) => g.media.banner).slice(0, 4);
  if (state.heroIndex >= featured.length) state.heroIndex = 0;

  const card = (g) => `
    <button class="card" data-open="${esc(g.id)}">
      <div class="art">
        <img src="${esc(g.media.cover)}" alt="" loading="lazy" />
        ${g.status === 'coming-soon' ? '<span class="badge">Coming soon</span>' : g.status === 'update-available' ? '<span class="badge amber">Update</span>' : isOwned(g) ? '<span class="badge cyan">In library</span>' : ''}
      </div>
      <div class="meta"><div class="name">${esc(g.title)}</div><div class="sub">${esc((g.genres || []).slice(0, 2).join(' · '))}</div></div>
    </button>`;

  $('#view').innerHTML = `
    <section class="hero">
      ${featured.map((g, i) => `
        <div class="hero-slide ${i === state.heroIndex ? 'on' : ''}" data-i="${i}">
          <div class="bg" style="background-image:${url(g.media.hero)}${g.media.logoInBanner ? ';background-position:center top' : g.media.hero !== g.media.banner ? ';background-position:right center' : ''}"></div>
          <div class="hero-content">
            <div class="chips">
              <span class="badge cyan">${g.status === 'coming-soon' ? 'Coming soon' : g.partner ? 'Partner' : 'HAMMS Original'}</span>
              ${(g.genres || []).slice(0, 2).map((x) => `<span class="badge">${esc(x)}</span>`).join('')}
            </div>
            ${g.media.logoInBanner ? '<div class="hero-spacer"></div>' : g.media.logo ? `<img class="hero-logo" src="${esc(g.media.logo)}" alt="${esc(g.title)}" />` : `<h1 class="hero-title">${esc(g.title)}</h1>`}
            <p class="hero-tag">${esc(g.tagline || '')}</p>
            <div class="hero-actions">
              <div style="min-width:210px">${actionButton(g, { compact: true }).replace(/data-act=/g, `data-id="${esc(g.id)}" data-act=`)}</div>
              <button class="btn glass" data-open="${esc(g.id)}">View game</button>
            </div>
          </div>
        </div>`).join('')}
      <div class="hero-thumbs">
        ${featured.map((g, i) => `<button class="hero-thumb ${i === state.heroIndex ? 'on' : ''}" data-hero="${i}" style="background-image:${url(g.media.banner)}" aria-label="${esc(g.title)}"><span class="t"></span></button>`).join('')}
      </div>
    </section>
    ${state.offline ? '<div class="offline">You\'re offline. Showing the last store we loaded. Installed games still play.</div>' : ''}

    <section class="section">
      <div class="section-head"><h2>HAMMS Originals</h2><p>Made by HAMMS Studios</p><span class="line"></span></div>
      <div class="grid">${originals.map(card).join('')}</div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Play now</h2><p>Jump straight in</p><span class="line"></span></div>
      <div class="wide-grid">
        ${(games.filter((g) => g.status !== 'coming-soon').length ? games.filter((g) => g.status !== 'coming-soon') : originals.slice(0, 3)).map((g) => `
          <button class="wcard" data-open="${esc(g.id)}" style="background-image:${url(g.media.screenshots[1] || g.media.banner)}">
            <div class="in">${g.media.logo ? `<img src="${esc(g.media.logo)}" alt="${esc(g.title)}" />` : `<b>${esc(g.title)}</b>`}<span class="badge">${esc(g.players || '')}</span></div>
          </button>`).join('')}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Partner Games</h2><p>Games from studios we roll with</p><span class="line"></span></div>
      ${partners.length ? `<div class="grid">${partners.map(card).join('')}</div>` : `
        <div class="partner-empty">
          <img src="brand/hamms-emblem.png" alt="" />
          <div><h3>Partner games are on the way</h3><p>Games from affiliate studios will show up right here. Building something? HAMMS Studios is looking for partners.</p></div>
        </div>`}
    </section>

    <section class="section">
      <div class="section-head"><h2>The Studio</h2><p>Who's behind HAMMS</p><span class="line"></span></div>
      <div class="studio">
        <div class="studio-intro">
          <img src="brand/hamms-logo.png" alt="HAMMS Studios" />
          <p>HAMMS Studios is an independent game studio founded by brothers Kyle and Derwin Hammonds, combining feature-film visual effects with military IT expertise to build games that look and play like the big leagues.</p>
        </div>
        <div class="founders">
          <div class="founder"><div class="mono">KH</div><div><b>Kyle Hammonds</b><span>Co-founder · Creative Director</span><p>Visual effects artist with work across a variety of feature films. Drives the look, feel and story of every HAMMS game.</p></div></div>
          <div class="founder"><div class="mono">DH</div><div><b>Derwin Hammonds</b><span>Co-owner · Game Developer</span><p>Brings deep military IT experience to the studio's engineering, networking and online play.</p></div></div>
        </div>
      </div>
    </section>

    <footer class="store-foot"><img src="brand/hamms-logo.png" alt="" /><span>© HAMMS Studios · Kyle &amp; Derwin Hammonds</span></footer>`;

  clearInterval(heroTimer);
  if (featured.length > 1) heroTimer = setInterval(() => setHero((state.heroIndex + 1) % featured.length), 8000);
}

function setHero(i) {
  state.heroIndex = i;
  $$('.hero-slide').forEach((s) => s.classList.toggle('on', +s.dataset.i === i));
  $$('.hero-thumb').forEach((t) => { t.classList.remove('on'); void t.offsetWidth; t.classList.toggle('on', +t.dataset.hero === i); });
}

// ---------- GAME PAGE ----------
function renderGame(id) {
  const g = game(id);
  if (!g) return navigate({ name: 'store' });
  const b = g.builds || {};
  const hasLite = !!b.lite, hasStd = !!b.standard;
  const rec = g.recommendedBuild;
  const pcc = g.pcCheck || { rating: 'unknown' };
  const verdict = {
    great: ['great', 'Your PC runs this great', 'Meets the recommended specs.'],
    ok: ['ok', 'Your PC can play this', hasLite ? 'Meets minimum specs. The Low Spec build will run smoother.' : 'Meets minimum specs. Lower the graphics settings for the best frame rate.'],
    low: ['low', 'Below minimum specs', hasLite ? 'We recommend the Low Spec build for this PC.' : 'This game may not run well on this PC. A Low Spec build may come later.'],
  }[pcc.rating];
  const req = g.requirements || {};
  const pc = state.pc || {};
  const row = (label, key, youVal, failKey) => {
    const failed = (pcc.fails || []).includes(failKey);
    const cls = !failKey || pcc.rating === 'unknown' ? '' : failed ? (pcc.rating === 'low' ? 's-bad' : 's-warn') : 's-ok';
    return `<tr><td>${label}</td><td>${esc(req.minimum?.[key] || '—')}</td><td>${esc(req.recommended?.[key] || '—')}</td><td class="you ${cls}">${esc(youVal || '—')}</td></tr>`;
  };
  const shots = g.media.screenshots.length ? g.media.screenshots : [g.media.banner].filter(Boolean);
  const notes = g.patchNotes || [];

  $('#view').innerHTML = `
    <section class="gp-hero">
      <div class="bg" style="background-image:${url(g.media.hero)}${g.media.logoInBanner ? ';background-position:center top' : g.media.hero !== g.media.banner ? ';background-position:right center' : ''}"></div>
      <button class="btn glass small back" data-nav="back">← Back</button>
      <div class="gp-head">
        <div>
          <div class="chips">
            <span class="badge cyan">${g.partner ? 'Partner' : 'HAMMS Original'}</span>
            ${(g.genres || []).map((x) => `<span class="badge">${esc(x)}</span>`).join('')}
          </div>
          ${g.media.logoInBanner ? `<h1 class="gp-title">${esc(g.title)}</h1>` : g.media.logo ? `<img class="gp-title-logo" src="${esc(g.media.logo)}" alt="${esc(g.title)}" />` : `<h1 class="gp-title">${esc(g.title)}</h1>`}
          <div class="gp-by">by <b>${esc(g.publisher || 'HAMMS Studios')}</b>${g.tagline ? ` · ${esc(g.tagline)}` : ''}</div>
        </div>
        <div class="action-card">
          ${g.type !== 'web' && (hasLite || hasStd) ? `
            <div class="build-pick">
              <div class="lbl"><span>Version</span>${hasLite && hasStd && pcc.rating !== 'unknown' ? `<span style="color:var(--cyan-2)">${rec === 'lite' ? 'Low Spec' : 'High'} recommended for your PC</span>` : ''}</div>
              <div class="seg">
                <button data-build="standard" class="${g.selectedBuild === 'standard' ? 'on' : ''}" ${hasStd ? '' : 'disabled'}>High<small>${hasStd ? `Full graphics · ${fmtBytes(b.standard.size)}` : 'Not available'}</small></button>
                <button data-build="lite" class="${g.selectedBuild === 'lite' ? 'on' : ''}" ${hasLite ? '' : 'disabled'}>Low Spec<small>${hasLite ? `Older PCs · ${fmtBytes(b.lite.size)}` : 'Not available yet'}</small></button>
              </div>
            </div>` : ''}
          ${actionButton(g)}
          <div class="ac-note">
            ${g.status === 'update-available' ? `<span class="hot">v${esc(g.installedVersion)} → v${esc(g.version)} · required to play</span>` :
              g.status === 'coming-soon' ? `<span>Follow along. It'll show up here the moment it drops.</span>` :
              g.installedVersion ? `<span>Installed <b>v${esc(g.installedVersion)}</b> · ${buildLabel(g.installedBuild)}</span>` :
              g.type === 'web' ? `<span>Plays inside the launcher, nothing to install</span>` :
              g.onDevice ? `<span>Another account on this PC installed it. Adding it doesn't download anything.</span>` :
              `<span>Download <b>${esc(fmtBytes(g.size) || '—')}</b></span>`}
            ${g.needsPrepare ? '<span class="hot">Shaders rebuild on launch</span>' : ''}
          </div>
        </div>
      </div>
    </section>

    <section class="gp-body">
      <div>
        <h3>About</h3>
        <p class="gp-desc">${esc(g.description || '')}</p>
        ${(g.features || []).length ? `<ul class="features">${g.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}

        <h3>${g.media.trailer ? 'Trailer &amp; screenshots' : 'Screenshots'}</h3>
        <div class="gallery">
          ${g.media.trailer ? `<button class="vid" data-trailer="1" style="background-image:${url(g.media.trailerPoster || g.media.banner)}" aria-label="Play trailer"><span class="playico"></span><span class="badge">Trailer</span></button>` : ''}
          ${shots.slice(0, g.media.trailer ? 6 : 7).map((s, i) => `<button data-shot="${i}" style="background-image:${url(s)}" aria-label="Screenshot ${i + 1}"></button>`).join('')}
          ${shots.length > (g.media.trailer ? 6 : 7) ? `<button class="more" data-shot="${g.media.trailer ? 6 : 7}">+${shots.length - (g.media.trailer ? 6 : 7)} more</button>` : ''}
        </div>

        <h3>Patch notes</h3>
        <div class="notes">${notes.length ? notes.map((n) => `<h4>v${esc(n.version)} ${n.date ? `<span>· ${esc(n.date)}</span>` : ''}</h4><ul>${(n.changes || []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`).join('') : '<span style="color:var(--muted)">Patch notes show up here with every update.</span>'}</div>

        <h3>System requirements</h3>
        ${verdict && g.type !== 'web' ? `<div class="pc-verdict ${verdict[0]}"><span class="dot"></span><div><b>${verdict[1]}</b><small>${verdict[2]}</small></div></div>` : ''}
        <table class="specs">
          <tr><th></th><th>Minimum</th><th>Recommended</th><th>Your PC</th></tr>
          ${row('OS', 'os', pc.os)}
          ${row('Processor', 'cpu', pc.cpu ? `${pc.cpu} (${pc.cores} threads)` : '', 'cpu')}
          ${row('Memory', 'ram', pc.ramGB ? `${pc.ramGB} GB` : '', 'ram')}
          ${row('Graphics', 'gpu', pc.gpu, 'gpu')}
          ${row('Storage', 'storage', pc.freeDiskGB != null ? `${pc.freeDiskGB} GB free` : '')}
        </table>
      </div>
      <aside class="side">
        <div class="info">
          <div><span>Developer</span><span>${esc(g.publisher || 'HAMMS Studios')}</span></div>
          <div><span>Players</span><span>${esc(g.players || '—')}</span></div>
          <div><span>Engine</span><span>${esc(g.engine || '—')}</span></div>
          <div><span>Latest version</span><span>${g.version ? `v${esc(g.version)}` : '—'}</span></div>
          ${b.standard ? `<div><span>High build</span><span>${esc(fmtBytes(b.standard.size))}</span></div>` : ''}
          ${b.lite ? `<div><span>Low Spec build</span><span>${esc(fmtBytes(b.lite.size))}</span></div>` : ''}
          <div><span>Status</span><span>${g.status === 'coming-soon' ? 'Coming soon' : 'Available'}</span></div>
        </div>
        ${g.installedVersion ? `<div class="side-actions">
          <button class="btn ghost small" data-act="folder">Open folder</button>
          <button class="btn ghost small" data-act="repair">Repair</button>
          <button class="btn ghost small" data-act="uninstall">Uninstall</button>
        </div>` : ''}
        <button class="btn ghost small" data-nav="device" style="margin-top:10px;width:100%">Games on this PC</button>
      </aside>
    </section>`;
  state.pageShots = shots;
  state.pageTrailer = g.media.trailer || '';
}

// ---------- LIBRARY ----------
function renderLibrary() {
  const owned = state.games.filter(isOwned);
  $('#view').innerHTML = `
    <section class="lib">
      <div class="lib-head"><h1>Library</h1><div class="lib-head-btns"><button class="btn ghost small" data-nav="device">Games on this PC</button><button class="btn ghost small" data-nav="store">Browse the store</button></div></div>
      ${owned.length ? owned.map((g) => `
        <div class="lrow">
          <div class="thumb" data-open="${esc(g.id)}" style="background-image:${url(g.media.banner)}"></div>
          <div>
            <div class="t" data-open="${esc(g.id)}">${esc(g.title)}</div>
            <div class="s"><span class="${g.status === 'update-available' ? 'hot' : ''}">${esc(statusLine(g))}</span>${g.type !== 'web' && g.size ? `<span>${esc(fmtBytes(g.size))}</span>` : ''}</div>
          </div>
          <div class="acts" data-id="${esc(g.id)}">${actionButton(g, { compact: true })}</div>
        </div>`).join('') : `
        <div class="empty">
          <img src="brand/hamms-emblem.png" alt="" />
          <h2>YOUR LIBRARY IS EMPTY</h2>
          <p>Install a game from the store and it lives here.</p>
          <button class="btn play" data-nav="store" style="margin-top:14px">Go to store</button>
        </div>`}
    </section>`;
}

// ---------- GAMES ON THIS PC ----------
// Every game installed here, by any HAMMS account, with its size and an uninstall button.
async function renderDevice() {
  $('#view').innerHTML = `<section class="lib"><div class="lib-head"><h1>Games on this PC</h1></div><div class="empty"><p>Checking your games…</p></div></section>`;
  const dev = await api.deviceGames();
  if (state.view.name !== 'device') return;
  const total = dev.games.reduce((n, g) => n + (g.sizeBytes || 0), 0);
  const who = (g) => g.mine && g.otherAccounts ? `In your library and ${g.otherAccounts === 1 ? '1 other account' : `${g.otherAccounts} other accounts`}`
    : g.mine ? 'In your library' : `Installed by ${g.otherAccounts === 1 ? 'another account' : `${g.otherAccounts} other accounts`} on this PC`;
  $('#view').innerHTML = `
    <section class="lib">
      <div class="lib-head"><h1>Games on this PC</h1><button class="btn ghost small" data-nav="library">Back to library</button></div>
      <div class="dev-sum"><span>${dev.games.length} ${dev.games.length === 1 ? 'game' : 'games'} · <b>${esc(fmtBytes(total) || '0 B')}</b> used</span>${dev.freeBytes != null ? `<span>${esc(fmtBytes(dev.freeBytes))} free on this drive</span>` : ''}</div>
      ${dev.games.length ? dev.games.map((g) => `
        <div class="lrow">
          <div class="thumb" style="background-image:${url(g.banner)}"></div>
          <div>
            <div class="t">${esc(g.title)}</div>
            <div class="s"><span>v${esc(g.version)} · ${esc(buildLabel(g.build))}</span><span>${esc(fmtBytes(g.sizeBytes) || '—')}</span><span class="${g.mine ? '' : 'hot'}">${esc(who(g))}</span></div>
          </div>
          <div class="acts" data-id="${esc(g.id)}">
            <button class="btn ghost small" data-act="folder">Open folder</button>
            <button class="btn ghost small danger" data-act="uninstall-device" ${g.running || g.busy ? 'disabled' : ''}>${g.running ? 'Close the game first' : g.busy ? 'Updating…' : 'Uninstall from this PC'}</button>
          </div>
        </div>`).join('') : `
        <div class="empty">
          <img src="brand/hamms-emblem.png" alt="" />
          <h2>NO GAMES ON THIS PC</h2>
          <p>Games you install from the store show up here.</p>
        </div>`}
    </section>`;
}

// ---------- routing ----------
const navStack = [];
function navigate(view, { push = true } = {}) {
  if (push && (state.view.name !== view.name || view.id !== state.view.id)) navStack.push(state.view);
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.nav === (['library', 'device'].includes(view.name) ? 'library' : 'store')));
  render();
  $('#view').scrollTop = 0;
}
function render() {
  if (state.view.name !== 'store') clearInterval(heroTimer);
  if (state.view.name === 'store') renderStore();
  else if (state.view.name === 'library') renderLibrary();
  else if (state.view.name === 'device') renderDevice();
  else if (state.view.name === 'game') renderGame(state.view.id);
  renderChrome();
}
// Re-render without losing scroll position (progress ticks, status changes).
function refresh() {
  const sc = $('#view').scrollTop;
  if (state.view.name === 'store') {
    // keep the carousel running; only refresh action areas + badges
    $$('.hero-actions').forEach((el, i) => {
      const id = el.querySelector('[data-open]')?.dataset.open; const g = game(id);
      if (g) el.firstElementChild.innerHTML = actionButton(g, { compact: true }).replace(/data-act=/g, `data-id="${esc(g.id)}" data-act=`);
    });
  } else render();
  $('#view').scrollTop = sc;
  renderChrome();
}

function renderChrome() {
  const owned = state.games.filter(isOwned).length;
  $('#lib-count').textContent = owned || '';
  const pc = state.pc;
  $('#pc-chip').innerHTML = pc ? `<span>Your PC</span><b>${esc(shortGpu(pc.gpu))}</b><span>${pc.ramGB} GB</span>` : 'Your PC';
  const active = Object.entries(state.progress).find(([, p]) => p.phase === 'download' || p.phase === 'extract');
  const chip = $('#dl-chip');
  if (active) {
    const [id, p] = active; const g = game(id);
    chip.classList.remove('hidden');
    chip.innerHTML = `<span>${esc(g?.title || '')}</span><span class="mini-bar"><i style="width:${p.percent || 0}%"></i></span><b>${p.phase === 'extract' ? 'Installing' : (p.percent ?? 0) + '%'}</b>`;
  } else chip.classList.add('hidden');
}
const shortGpu = (s) => String(s || 'Unknown graphics').replace(/^(NVIDIA|AMD|Intel\(R\))\s+/i, '').replace(/\(R\)|\(TM\)/g, '').trim().slice(0, 28);

// ---------- data ----------
async function load(refreshCatalog = false) {
  const lib = await api.getLibrary(refreshCatalog);
  state.games = lib.games;
  state.pc = lib.pc;
  state.launcherUpdateReady = lib.launcherUpdateReady;
  state.offline = lib.offline && lib.storeConfigured;
  $('#auto-update').checked = !!lib.settings.autoUpdate;
  $('#drawer-meta').innerHTML = `HAMMS Studios Launcher v${esc(lib.launcherVersion)}<br>${lib.offline ? 'Offline: showing saved store' : 'Connected to the HAMMS store'}<br>${lib.pc ? `${esc(lib.pc.cpu)}<br>${esc(lib.pc.gpu)} · ${lib.pc.ramGB} GB RAM` : ''}`;
  if (state.launcherUpdateReady) showLauncherBar({ state: 'ready' });
  return lib;
}

function showLauncherBar(u) {
  $('#update-bar').classList.remove('hidden');
  if (u.state === 'ready') {
    $('#update-text').textContent = 'A launcher update is ready. Restart to finish updating.';
    $('#update-restart').classList.remove('hidden');
  } else {
    $('#update-text').textContent = `Downloading launcher update${u.percent != null ? ` ${u.percent}%` : '…'}`;
  }
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    const to = nav.dataset.nav;
    if (to === 'back') return navigate(navStack.pop() || { name: 'store' }, { push: false });
    return navigate({ name: to });
  }
  const hero = e.target.closest('[data-hero]');
  if (hero) return setHero(+hero.dataset.hero);
  const tr = e.target.closest('button[data-trailer]');
  if (tr) return openTrailer(state.pageTrailer);
  const shot = e.target.closest('button[data-shot]');
  if (shot) return openLightbox(state.pageShots || [], +shot.dataset.shot);
  const buildBtn = e.target.closest('[data-build]');
  if (buildBtn && !buildBtn.disabled) { await api.setBuild(state.view.id, buildBtn.dataset.build); return; }

  const act = e.target.closest('[data-act]');
  if (act) {
    const id = act.dataset.id || act.closest('[data-id]')?.dataset.id || state.view.id;
    const a = act.dataset.act;
    if (a === 'install' || a === 'repair') {
      state.progress[id] = { phase: 'download', percent: 0 };
      refresh();
      const r = await api.install(id);
      if (r && r.ok === false && r.error) toast(r.error);
    } else if (a === 'play') {
      act.disabled = true; act.textContent = 'Checking…';
      const r = await api.play(id);
      if (r && !r.ok && r.error) toast(r.error);
      await load(); refresh();
    } else if (a === 'cancel') api.cancel(id);
    else if (a === 'uninstall') { const r = await api.uninstall(id); if (r?.ok) toast(r.removedFiles ? 'Uninstalled from this PC.' : 'Removed from your library.'); }
    else if (a === 'uninstall-device') { const r = await api.uninstallFromDevice(id); if (r?.ok) { toast('Uninstalled from this PC.'); render(); } else if (r?.error) toast(r.error); }
    else if (a === 'folder') api.openFolder(id);
    else if (a === 'restart') api.restartToUpdate();
    return;
  }
  const open = e.target.closest('[data-open]');
  if (open) return navigate({ name: 'game', id: open.dataset.open });
});

$('#settings-btn').addEventListener('click', () => $('#settings').classList.remove('hidden'));
$('#pc-chip').addEventListener('click', () => $('#settings').classList.remove('hidden'));
$('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings' || e.target.closest('[data-close]')) $('#settings').classList.add('hidden'); });
$('#auto-update').addEventListener('change', (e) => api.saveSettings({ autoUpdate: e.target.checked }));
$('#manage-games').addEventListener('click', () => { $('#settings').classList.add('hidden'); navigate({ name: 'device' }); });
$('#check').addEventListener('click', async () => { $('#check').textContent = 'Checking…'; await api.checkUpdates(); $('#check').textContent = 'Check for updates now'; });
$('#update-restart').addEventListener('click', () => api.restartToUpdate());

function openLightbox(list, i) { state.lightbox = { list, i }; $('#lb-video').classList.add('hidden'); $('#lb-img').classList.remove('hidden'); $$('.lb-nav').forEach((b) => b.classList.remove('hidden')); $('#lb-img').src = list[i]; $('#lightbox').classList.remove('hidden'); }
function openTrailer(src) {
  const v = $('#lb-video'); v.src = src; v.classList.remove('hidden'); $('#lb-img').classList.add('hidden');
  $$('.lb-nav').forEach((b) => b.classList.add('hidden')); $('#lightbox').classList.remove('hidden'); v.play().catch(() => {});
}
function closeLightbox() { const v = $('#lb-video'); v.pause(); v.removeAttribute('src'); v.load(); $('#lightbox').classList.add('hidden'); }
function lbStep(d) { const lb = state.lightbox; lb.i = (lb.i + d + lb.list.length) % lb.list.length; $('#lb-img').src = lb.list[lb.i]; }
$('#lightbox').addEventListener('click', (e) => {
  if (e.target.closest('.prev')) return lbStep(-1);
  if (e.target.closest('.next')) return lbStep(1);
  if (e.target.id !== 'lb-img' && e.target.id !== 'lb-video') closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if ($('#lightbox').classList.contains('hidden')) { if (e.key === 'Escape') $('#settings').classList.add('hidden'); return; }
  if (e.key === 'ArrowLeft') lbStep(-1); else if (e.key === 'ArrowRight') lbStep(1); else if (e.key === 'Escape') closeLightbox();
});

api.onProgress((p) => {
  if (p.phase === 'done' || p.phase === 'error') {
    delete state.progress[p.id];
    const g = game(p.id);
    if (p.phase === 'error') toast(`${g ? g.title : 'Game'}: ${p.message}`);
    else if (g) toast(`${g.title} is ready to play.`);
  } else state.progress[p.id] = p;
  refresh();
});
api.onLibraryChanged(async () => { await load(); refresh(); });
api.onLauncherUpdate((u) => { if (u.state === 'ready') state.launcherUpdateReady = true; showLauncherBar(u); refresh(); });

// ---------- intro (HAMMS ident) ----------
function runIntro() {
  const el = $('#intro'), cv = $('#embers'), ctx = cv.getContext('2d');
  let w, h; const resize = () => { w = cv.width = innerWidth * devicePixelRatio; h = cv.height = innerHeight * devicePixelRatio; };
  resize();
  const embers = Array.from({ length: 70 }, () => ({ x: Math.random(), y: 1 + Math.random() * 0.4, s: 0.6 + Math.random() * 1.8, v: 0.0006 + Math.random() * 0.0016, d: (Math.random() - 0.5) * 0.0004, a: 0.3 + Math.random() * 0.6 }));
  const t0 = performance.now(); let raf;
  const tick = (t) => {
    const k = (t - t0) / 1000;
    ctx.clearRect(0, 0, w, h);
    const fade = Math.min(1, Math.max(0, (k - 1.2) / 0.8));
    for (const e of embers) {
      e.y -= e.v; e.x += e.d; if (e.y < -0.05) { e.y = 1.05; e.x = Math.random(); }
      const g = ctx.createRadialGradient(e.x * w, e.y * h, 0, e.x * w, e.y * h, e.s * 6 * devicePixelRatio);
      g.addColorStop(0, `rgba(140,225,255,${e.a * fade})`); g.addColorStop(1, 'rgba(46,197,255,0)');
      ctx.fillStyle = g; ctx.fillRect(e.x * w - 20, e.y * h - 20, 40, 40);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const done = () => { el.classList.add('out'); setTimeout(() => { cancelAnimationFrame(raf); el.remove(); }, 750); };
  const timer = setTimeout(done, 3600);
  el.addEventListener('click', () => { clearTimeout(timer); done(); }, { once: true });
}

// ---------- HAMMS account ----------
const auth = { mode: 'in', state: null };
function showAuth(note) {
  const off = auth.state && !auth.state.configured;
  $('#auth').classList.remove('hidden');
  $('#auth-form').classList.toggle('hidden', off);
  $('.auth-tabs').classList.toggle('hidden', off);
  $('#auth-off').classList.toggle('hidden', !off);
  const n = $('#auth-launch-note');
  n.classList.toggle('hidden', !note); if (note) n.textContent = note;
  setTimeout(() => (auth.mode === 'up' ? $('#f-name') : $('#f-email')).focus(), 50);
}
function setAuthMode(mode) {
  auth.mode = mode;
  $$('.auth-tab').forEach((t) => t.classList.toggle('on', t.dataset.authTab === mode));
  $$('.up-only').forEach((el) => el.classList.toggle('hidden', mode !== 'up'));
  $$('.in-only').forEach((el) => el.classList.toggle('hidden', mode !== 'in'));
  $('#auth-submit').textContent = mode === 'up' ? 'Create account' : 'Sign in';
  $('#f-pass').autocomplete = mode === 'up' ? 'new-password' : 'current-password';
  authMsg();
}
function authMsg(err, info) {
  $('#auth-error').classList.toggle('hidden', !err); $('#auth-error').textContent = err || '';
  $('#auth-info').classList.toggle('hidden', !info); $('#auth-info').textContent = info || '';
}
function renderMe() {
  const p = auth.state?.profile;
  $('#me-chip').classList.toggle('hidden', !p);
  if (p) {
    $('.me-name').textContent = p.username || p.email;
    $('.me-ava').textContent = (p.username || p.email || '?').slice(0, 2).toUpperCase();
    $('#acct-name').textContent = p.username || '—';
    $('#acct-email').textContent = p.email || '';
  }
}
$$('.auth-tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.authTab)));
let nameTimer;
$('#f-name').addEventListener('input', () => {
  const v = $('#f-name').value.trim(), hint = $('#name-hint');
  clearTimeout(nameTimer); hint.className = 'hint';
  if (!/^[A-Za-z0-9_]{3,16}$/.test(v)) { hint.textContent = '3–16 letters, numbers or _'; if (v.length >= 3) hint.classList.add('bad'); return; }
  hint.textContent = 'Checking…';
  nameTimer = setTimeout(async () => {
    const r = await api.auth.nameFree(v);
    if ($('#f-name').value.trim() !== v) return;
    if (!r.ok) { hint.textContent = r.error; hint.classList.add('bad'); }
    else if (r.free) { hint.textContent = `${v} is available`; hint.classList.add('good'); }
    else { hint.textContent = `${v} is taken`; hint.classList.add('bad'); }
  }, 350);
});
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#auth-submit'), label = btn.textContent;
  btn.disabled = true; btn.textContent = auth.mode === 'up' ? 'Creating…' : 'Signing in…'; authMsg();
  const body = { email: $('#f-email').value.trim(), password: $('#f-pass').value, username: $('#f-name').value.trim() };
  const r = auth.mode === 'up' ? await api.auth.signUp(body) : await api.auth.signIn(body);
  btn.disabled = false; btn.textContent = label;
  if (!r.ok) return authMsg(r.error);
  if (r.needsConfirmation) { setAuthMode('in'); return authMsg(null, 'Almost there. We sent a link to your email. Confirm it, then sign in.'); }
  $('#f-pass').value = '';
  await afterSignIn(r.state);
});
$('#auth-forgot').addEventListener('click', async () => {
  const r = await api.auth.reset({ email: $('#f-email').value.trim() });
  if (!r.ok) return authMsg(r.error);
  authMsg(null, 'Check your email for a link to reset your password.');
});
$('#me-chip').addEventListener('click', () => $('#settings').classList.remove('hidden'));
$('#sign-out').addEventListener('click', async () => {
  await api.auth.signOut();
  $('#settings').classList.add('hidden');
  auth.state = await api.auth.state(); renderMe(); setAuthMode('in'); showAuth();
});

// A game was opened directly (or the launcher was asked to play one): check updates, then line up Play.
async function handleLaunchRequest(id) {
  if (!id) return;
  await api.checkUpdates();
  await load(true);
  const g = game(id);
  if (!g) return toast("That game isn't in the HAMMS store yet.");
  navigate({ name: 'game', id });
  if (g.status === 'update-available' || g.status === 'switch-build') {
    toast(`${g.title} needs an update before you can play. Downloading now.`);
    state.progress[id] = { phase: 'download', percent: 0 }; refresh();
    const r = await api.install(id); if (r && r.ok === false && r.error) toast(r.error);
  } else if (g.status === 'not-installed') {
    toast(`Install ${g.title} to play.`);
  } else if (g.status === 'installed') {
    toast(`${g.title} is up to date. Press Play.`);
    $('[data-act="play"]')?.classList.add('pulse');
  }
}

async function afterSignIn(st) {
  auth.state = st || (await api.auth.state());
  renderMe();
  $('#auth').classList.add('hidden');
  const id = await api.takePendingLaunch();
  if (id) handleLaunchRequest(id);
}

api.auth.onChange((st) => { auth.state = st; renderMe(); });
api.onLaunchRequest(async (id) => {
  auth.state = await api.auth.state();
  if (!auth.state.signedIn) { const g = game(id); return showAuth(`Sign in to play ${g ? g.title : 'your game'}.`); }
  const pending = await api.takePendingLaunch();
  handleLaunchRequest(pending || id);
});

(async () => {
  runIntro();
  auth.state = await api.auth.state();
  await load();
  render();
  setAuthMode('in');
  setTimeout(async () => {
    if (auth.state.signedIn) return afterSignIn(auth.state);
    const g = auth.state.pendingLaunch && game(auth.state.pendingLaunch);
    showAuth(g ? `Sign in to play ${g.title}.` : null);
  }, 3300);
})();
