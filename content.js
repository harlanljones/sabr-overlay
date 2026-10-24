// SABR Overlay: live sabermetrics panels over MLB broadcasts on YouTube TV.
// Data: MLB StatsAPI (live feed, win probability, season + sabermetric splits) and Baseball Savant percentiles.
(() => {
  if (window.__sabrOverlay) return;
  window.__sabrOverlay = true;

  // ---------- data access ----------
  const hasExt = typeof browser !== "undefined" && browser.runtime?.sendMessage;
  const api = (path) =>
    hasExt
      ? browser.runtime.sendMessage({ type: "api", path })
      : fetch("https://statsapi.mlb.com/api/" + path).then((r) => {
          if (!r.ok) throw new Error(`StatsAPI ${r.status}`);
          return r.json();
        });

  // Baseball Savant percentile rankings (CSV, one row per qualified player).
  const savantCsv = (kind, season) =>
    hasExt
      ? browser.runtime.sendMessage({ type: "savant", kind, season })
      : fetch(`https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=${kind}&year=${season}&csv=true`).then((r) => r.text());

  // ---------- constants ----------
  // Run expectancy by base state (bit 1 = 1st, 2 = 2nd, 4 = 3rd) and outs. MLB 2010s averages.
  const RE24 = [
    [0.481, 0.254, 0.098], [0.859, 0.509, 0.224], [1.100, 0.664, 0.319], [1.437, 0.884, 0.429],
    [1.350, 0.950, 0.353], [1.784, 1.130, 0.478], [1.964, 1.376, 0.580], [2.292, 1.541, 0.752],
  ];
  const BASE_LABEL = ["Empty", "1st", "2nd", "1st & 2nd", "3rd", "1st & 3rd", "2nd & 3rd", "Loaded"];
  const WHIFF = new Set(["S", "W", "M", "Q"]);
  const SWING = new Set(["S", "W", "M", "Q", "F", "T", "L", "R", "O", "X", "D", "E"]);
  const PANELS = {
    situation: { title: "Situation", col: "L" },
    matchup: { title: "Matchup", col: "L" },
    winprob: { title: "Win Probability", col: "L" },
    pitches: { title: "At-Bat Pitches", col: "R" },
    arsenal: { title: "Pitcher Today", col: "R" },
    batted: { title: "Batted Balls", col: "R" },
  };
  const RENDER = {};

  // ---------- settings ----------
  const KEY = "sabrOverlay.v1";
  const defaults = () => ({
    visible: true, gamePk: "auto", delay: 0, opacity: 0.9, scale: 1,
    panels: Object.fromEntries(Object.keys(PANELS).map((id) => [id, { on: true, x: null, y: null, min: false }])),
  });
  let settings = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved) settings = { ...settings, ...saved, panels: { ...settings.panels, ...saved.panels } };
  } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {} };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = (v) => (v === undefined || v === null || v === "" || v === "-.--" ? NaN : Number(v));
  const f3 = (v) => { const n = num(v); return isNaN(n) ? "—" : n.toFixed(3).replace(/^0(?=\.)/, ""); };
  const f2 = (v) => { const n = num(v); return isNaN(n) ? "—" : n.toFixed(2); };
  const f1 = (v) => { const n = num(v); return isNaN(n) ? "—" : n.toFixed(1); };
  const f0 = (v) => { const n = num(v); return isNaN(n) ? "—" : Math.round(n).toString(); };
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "—");
  const lastName = (n) => String(n || "").split(" ").slice(1).join(" ") || n;
  const localDate = (offsetDays = 0) => {
    const d = new Date(Date.now() + offsetDays * 864e5);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const isBarrel = (ev, la) => {
    if (!(ev >= 98)) return false;
    const lo = Math.max(8, 26 - (ev - 98));
    const hi = ev < 99 ? 30 : ev < 100 ? 31 : Math.min(50, 33 + (ev - 100) * (17 / 16));
    return la >= lo && la <= hi;
  };
  // Savant convention: percentile vs MLB where 100 = best for that player, coloured blue → grey → red.
  const SAVANT_STOPS = [[0, [50, 94, 172]], [50, [168, 168, 168]], [100, [214, 41, 52]]];
  const pctColor = (p) => {
    const [[p0, c0], [p1, c1]] = p <= 50 ? [SAVANT_STOPS[0], SAVANT_STOPS[1]] : [SAVANT_STOPS[1], SAVANT_STOPS[2]];
    const t = (p - p0) / (p1 - p0);
    return `rgb(${c0.map((v, i) => Math.round(v + (c1[i] - v) * t)).join(",")})`;
  };
  // Normal-approximation percentile from a league mean/spread, for stats Savant doesn't rank.
  const erf = (x) => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  };
  const estPct = (v, mean, sd, higherIsGood = true) => {
    const n = num(v);
    if (isNaN(n)) return null;
    const z = ((n - mean) / sd) * (higherIsGood ? 1 : -1);
    return { p: Math.max(1, Math.min(100, Math.round(50 * (1 + erf(z / Math.SQRT2))))), est: true };
  };
  const bubble = (pc) =>
    pc ? `<i class="pb${pc.est ? " est" : ""}" style="background:${pctColor(pc.p)}" title="${pc.est ? "Estimated percentile (league avg)" : "Baseball Savant percentile"}">${pc.p}</i>` : "";
  const pctStyle = (pc) => (pc ? `style="color:${pctColor(pc.p)}"` : "");

  // ---------- state ----------
  let games = [];
  let activePk = null;
  let snapshots = []; // [{t, feed}]
  let wp = [];
  let shown = null; // feed currently rendered
  let lastError = "";
  let dirty = true;
  const players = new Map(); // key -> {data} | {pending}

  const playerStats = (kind, id, season) => {
    const key = `${kind}:${id}:${season}`;
    if (!players.has(key)) {
      players.set(key, { pending: true });
      const path =
        kind === "hit"
          ? `v1/people/${id}/stats?stats=season,sabermetrics,statSplits&sitCodes=vl,vr&group=hitting&season=${season}`
          : `v1/people/${id}/stats?stats=season,sabermetrics&group=pitching&season=${season}`;
      api(path)
        .then((d) => {
          const out = {};
          for (const s of d.stats || []) {
            const t = s.type?.displayName;
            if (t === "statSplits") for (const sp of s.splits) out[sp.split?.code] = sp.stat;
            else if (s.splits?.[0]) out[t] = s.splits[0].stat;
          }
          players.set(key, { data: out });
          dirty = true;
        })
        .catch(() => players.set(key, { data: {} }));
    }
    return players.get(key).data;
  };
  const savantRows = {}; // "kind:season" -> {pending} | Map(playerId -> row)
  const savantPct = (kind, season, id, col) => {
    const key = `${kind}:${season}`;
    if (!savantRows[key]) {
      savantRows[key] = { pending: true };
      savantCsv(kind, season)
        .then((text) => { savantRows[key] = parseCsv(text); dirty = true; })
        .catch(() => { savantRows[key] = new Map(); });
    }
    const v = savantRows[key] instanceof Map ? num(savantRows[key].get(String(id))?.[col]) : NaN;
    return isNaN(v) ? null : { p: v, est: false };
  };
  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') field += '"', i++;
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") row.push(field), (field = "");
      else if (ch === "\n") row.push(field), rows.push(row), (row = []), (field = "");
      else if (ch !== "\r" && ch !== "\uFEFF") field += ch;
    }
    if (field || row.length) row.push(field), rows.push(row);
    const head = rows.shift() || [];
    const map = new Map();
    for (const r of rows) map.set(r[1], Object.fromEntries(head.map((h, i) => [h, r[i]])));
    return map;
  }
  const bvpStats = (b, p) => {
    const key = `bvp:${b}:${p}`;
    if (!players.has(key)) {
      players.set(key, { pending: true });
      api(`v1/people/${b}/stats?stats=vsPlayer&opposingPlayerId=${p}&group=hitting`)
        .then((d) => {
          const tot = (d.stats || []).find((s) => s.type?.displayName === "vsPlayerTotal");
          players.set(key, { data: tot?.splits?.[0]?.stat || {} });
          dirty = true;
        })
        .catch(() => players.set(key, { data: {} }));
    }
    return players.get(key).data;
  };

  // ---------- game selection + polling ----------
  async function loadGames() {
    const days = await Promise.all([localDate(-1), localDate(0)].map((d) =>
      api(`v1/schedule?sportId=1&date=${d}`).catch(() => ({ dates: [] }))));
    games = days.flatMap((d) => d.dates.flatMap((x) => x.games));
    dirty = true;
  }

  function pickGame() {
    if (settings.gamePk !== "auto") return Number(settings.gamePk);
    const title = (document.title + " " + (document.querySelector("h1, [class*='title']")?.textContent || "")).toLowerCase();
    const score = (g) => {
      let s = 0;
      for (const side of ["away", "home"]) {
        const t = g.teams[side].team;
        const nick = (t.teamName || t.name.split(" ").pop()).toLowerCase();
        if (title.includes(nick)) s += 10;
      }
      const st = g.status.abstractGameState;
      s += st === "Live" ? 5 : st === "Preview" ? 1 : 0;
      return s;
    };
    const ranked = [...games].sort((a, b) => score(b) - score(a));
    return ranked[0]?.gamePk ?? null;
  }

  async function poll() {
    const pk = pickGame();
    if (pk !== activePk) { activePk = pk; snapshots = []; wp = []; shown = null; dirty = true; }
    if (!pk) return schedule(30000);
    try {
      const [feed, prob] = await Promise.all([
        api(`v1.1/game/${pk}/feed/live`),
        api(`v1/game/${pk}/winProbability`).catch(() => wp),
      ]);
      if (pk !== activePk) return;
      const t = feedTime(feed);
      const prev = snapshots[snapshots.length - 1];
      if (!prev || t > prev.t) snapshots.push({ t, feed });
      if (Array.isArray(prob)) wp = prob;
      lastError = "";
      dirty = true;
      const state = feed.gameData?.status?.abstractGameState;
      schedule(state === "Live" ? 5000 : 60000);
    } catch (e) {
      lastError = String(e.message || e);
      dirty = true;
      schedule(15000);
    }
  }
  let pollTimer;
  const schedule = (ms) => { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); };

  // When MLB recorded this version of the feed (metaData.timeStamp is UTC "YYYYMMDD_HHMMSS").
  // Using it instead of our fetch time removes network/poll jitter from the broadcast sync.
  function feedTime(feed) {
    const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(feed.metaData?.timeStamp || "");
    return m ? Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) : Date.now();
  }

  // Choose the newest snapshot recorded at least `delay` seconds ago, to sync with the broadcast.
  function currentFeed() {
    if (!snapshots.length) return null;
    if (!settings.delay) return snapshots[snapshots.length - 1].feed;
    const cutoff = Date.now() - settings.delay * 1000;
    let idx = 0;
    for (let i = snapshots.length - 1; i >= 0; i--) if (snapshots[i].t <= cutoff) { idx = i; break; }
    if (idx > 0) snapshots = snapshots.slice(idx), (idx = 0);
    return snapshots[idx].feed;
  }

  // ---------- UI shell ----------
  const host = document.createElement("div");
  host.id = "sabr-overlay-host";
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS()}</style><div class="layer"></div>`;
  const layer = root.querySelector(".layer");
  const mount = () => {
    const target = document.fullscreenElement && document.fullscreenElement.tagName !== "VIDEO"
      ? document.fullscreenElement : document.documentElement;
    if (host.parentNode !== target) target.appendChild(host);
  };
  document.addEventListener("fullscreenchange", mount);
  mount();

  const panelEls = {};
  for (const [id, meta] of Object.entries(PANELS)) {
    const el = document.createElement("section");
    el.className = "panel";
    el.dataset.id = id;
    el.innerHTML = `<header><span class="t">${meta.title}</span><span class="btns"><button data-act="min" title="Collapse">–</button><button data-act="close" title="Hide panel">×</button></span></header><div class="body"></div>`;
    layer.appendChild(el);
    panelEls[id] = el;
    makeDraggable(el, id);
    el.querySelector("[data-act=min]").onclick = () => { settings.panels[id].min = !settings.panels[id].min; save(); applyLayout(); };
    el.querySelector("[data-act=close]").onclick = () => { settings.panels[id].on = false; save(); applyLayout(); renderSettings(); };
  }

  const fab = document.createElement("button");
  fab.className = "fab";
  fab.innerHTML = `<span class="dot"></span>SABR`;
  fab.title = "SABR Overlay settings (Alt+Shift+S toggles panels)";
  layer.appendChild(fab);
  const settingsEl = document.createElement("section");
  settingsEl.className = "settings hidden";
  layer.appendChild(settingsEl);
  fab.onclick = () => { settingsEl.classList.toggle("hidden"); renderSettings(); };

  function makeDraggable(el, id) {
    const header = el.querySelector("header");
    header.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      header.setPointerCapture(e.pointerId);
      const rect = el.getBoundingClientRect();
      const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
      const move = (ev) => {
        const z = settings.scale;
        const x = Math.max(0, Math.min(innerWidth - 40, ev.clientX - ox));
        const y = Math.max(0, Math.min(innerHeight - 20, ev.clientY - oy));
        el.style.left = x / z + "px"; el.style.top = y / z + "px"; el.style.right = "auto";
        settings.panels[id].x = Math.round(x); settings.panels[id].y = Math.round(y);
      };
      const up = () => { header.removeEventListener("pointermove", move); header.removeEventListener("pointerup", up); save(); };
      header.addEventListener("pointermove", move);
      header.addEventListener("pointerup", up);
    });
  }

  // Dragged panels keep their saved spot; the rest stack down their column by measured height.
  function applyLayout() {
    layer.classList.toggle("off", !settings.visible);
    layer.style.setProperty("--op", settings.opacity);
    const z = settings.scale;
    const next = { L: 64, R: 64 };
    for (const [id, el] of Object.entries(panelEls)) {
      const p = settings.panels[id];
      el.style.display = p.on ? "" : "none";
      el.classList.toggle("min", p.min);
      el.style.zoom = z;
      if (!p.on) continue;
      if (p.x != null) {
        el.style.right = "auto"; el.style.left = p.x / z + "px"; el.style.top = p.y / z + "px";
        continue;
      }
      const col = PANELS[id].col;
      el.style.left = col === "L" ? 16 / z + "px" : "auto";
      el.style.right = col === "R" ? 16 / z + "px" : "auto";
      el.style.top = next[col] / z + "px";
      next[col] += el.offsetHeight * z + 10;
    }
  }

  let syncOpen = false;
  const setDelay = (sec) => {
    settings.delay = Math.max(0, Math.round(sec * 2) / 2);
    save(); dirty = true; renderSettings();
  };
  // Latest pitches at the live edge (ignoring the current delay), newest first.
  function syncList() {
    const live = snapshots[snapshots.length - 1]?.feed;
    const items = [];
    for (const play of [...(live?.liveData?.plays?.allPlays || [])].reverse()) {
      for (const e of [...(play.playEvents || [])].reverse()) {
        if (!e.isPitch || !e.startTime) continue;
        items.push({ play, e });
        if (items.length >= 6) break;
      }
      if (items.length >= 6) break;
    }
    if (!items.length) return `<p class="hint">No pitches in the live feed yet. Try again once the game is underway.</p>`;
    const ago = (iso) => Math.round((Date.now() - Date.parse(iso)) / 1000);
    return `<p class="hint">Click the pitch you <b>just saw thrown</b>:</p><div class="sync">${items.map(({ play, e }) =>
      `<button data-pitch="${esc(e.startTime)}"><span>${play.about.isTopInning ? "▲" : "▼"}${play.about.inning} ${esc(lastName(play.matchup.batter.fullName))} · ${esc(e.details.type?.code || "")} ${f1(e.pitchData?.startSpeed)} · ${esc(e.details.description)}</span><em>${ago(e.startTime)}s ago</em></button>`).join("")}</div>`;
  }

  function renderSettings() {
    if (settingsEl.classList.contains("hidden")) return;
    const opts = games.map((g) => {
      const a = g.teams.away.team.abbreviation || g.teams.away.team.name, h = g.teams.home.team.abbreviation || g.teams.home.team.name;
      return `<option value="${g.gamePk}" ${String(settings.gamePk) === String(g.gamePk) ? "selected" : ""}>${esc(g.teams.away.team.name)} @ ${esc(g.teams.home.team.name)} — ${esc(g.status.detailedState)}</option>`;
    }).join("");
    settingsEl.innerHTML = `
      <header><span class="t">Overlay settings</span><span class="btns"><button data-act="x">×</button></span></header>
      <div class="body">
        <label>Game<select data-k="gamePk"><option value="auto" ${settings.gamePk === "auto" ? "selected" : ""}>Auto-detect (live / page title)</option>${opts}</select></label>
        <label>Broadcast delay <span class="v">${settings.delay.toFixed(1)}s</span><input type="range" min="0" max="300" step="0.5" data-k="delay" value="${settings.delay}"></label>
        <div class="row"><button data-nudge="-1">−1s</button><button data-nudge="-0.5">−½s</button><button data-act="sync" class="pri">Sync to stream</button><button data-nudge="0.5">+½s</button><button data-nudge="1">+1s</button></div>
        ${syncOpen ? syncList() : `<p class="hint">Stats run ahead of the stream. Hit <b>Sync to stream</b>, then click the pitch the moment you see it thrown.</p>`}
        <label>Opacity <span class="v">${Math.round(settings.opacity * 100)}%</span><input type="range" min="0.4" max="1" step="0.05" data-k="opacity" value="${settings.opacity}"></label>
        <label>Size <span class="v">${Math.round(settings.scale * 100)}%</span><input type="range" min="0.7" max="1.5" step="0.05" data-k="scale" value="${settings.scale}"></label>
        <div class="checks">${Object.entries(PANELS).map(([id, m]) =>
          `<label class="chk"><input type="checkbox" data-p="${id}" ${settings.panels[id].on ? "checked" : ""}>${m.title}</label>`).join("")}</div>
        <div class="row"><button data-act="toggle">${settings.visible ? "Hide" : "Show"} panels</button><button data-act="reset">Reset layout</button></div>
        <p class="hint">Drag panels by their title bar. <b>Alt+Shift+S</b> hides or shows them.${lastError ? `<br><span class="err">${esc(lastError)}</span>` : ""}</p>
      </div>`;
    settingsEl.querySelector("[data-act=x]").onclick = () => settingsEl.classList.add("hidden");
    settingsEl.querySelector("[data-act=sync]").onclick = () => { syncOpen = !syncOpen; renderSettings(); };
    settingsEl.querySelectorAll("[data-nudge]").forEach((b) => (b.onclick = () => setDelay(settings.delay + Number(b.dataset.nudge))));
    settingsEl.querySelectorAll("[data-pitch]").forEach((b) => (b.onclick = () => {
      // The viewer just saw this pitch released on screen; its startTime is (roughly) MLB's release time.
      syncOpen = false;
      setDelay((Date.now() - Date.parse(b.dataset.pitch)) / 1000);
    }));
    settingsEl.querySelector("[data-act=toggle]").onclick = () => { settings.visible = !settings.visible; save(); applyLayout(); renderSettings(); };
    settingsEl.querySelector("[data-act=reset]").onclick = () => { settings.panels = defaults().panels; save(); applyLayout(); renderSettings(); };
    settingsEl.querySelectorAll("[data-k]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const k = inp.dataset.k;
        settings[k] = k === "gamePk" ? inp.value : Number(inp.value);
        const v = inp.parentElement.querySelector(".v");
        if (v) v.textContent = k === "delay" ? `${settings.delay.toFixed(1)}s` : `${Math.round(settings[k] * 100)}%`;
        save(); applyLayout(); dirty = true;
        if (k === "gamePk") poll();
      });
    });
    settingsEl.querySelectorAll("[data-p]").forEach((inp) => {
      inp.onchange = () => { settings.panels[inp.dataset.p].on = inp.checked; save(); applyLayout(); };
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.code === "KeyS") {
      settings.visible = !settings.visible; save(); applyLayout(); renderSettings();
    }
  }, true);

  // ---------- render ----------
  function context(feed) {
    const gd = feed.gameData, ld = feed.liveData;
    const all = ld.plays.allPlays || [];
    const cur = ld.plays.currentPlay || all[all.length - 1];
    const curIdx = cur?.about?.atBatIndex ?? -1;
    return {
      feed, gd, ld, all, cur, curIdx,
      season: gd.game?.season || new Date().getFullYear(),
      away: gd.teams.away, home: gd.teams.home,
      wp: wp.filter((p) => p.about.atBatIndex <= curIdx && p.about.isComplete !== false),
      status: gd.status,
    };
  }

  function render() {
    const feed = currentFeed();
    if (!dirty && feed === shown) return;
    dirty = false; shown = feed;
    fab.querySelector(".dot").className = "dot " + (lastError ? "bad" : feed?.gameData?.status?.abstractGameState === "Live" ? "live" : "");
    if (!feed) {
      const msg = activePk ? "Loading game feed…" : games.length ? "No game selected." : "Looking for today's games…";
      for (const el of Object.values(panelEls)) el.querySelector(".body").innerHTML = `<div class="empty">${lastError ? esc(lastError) : msg}</div>`;
      applyLayout();
      return;
    }
    const ctx = context(feed);
    for (const [id, el] of Object.entries(panelEls)) {
      if (!settings.panels[id].on) continue;
      try { el.querySelector(".body").innerHTML = RENDER[id](ctx); }
      catch (e) { el.querySelector(".body").innerHTML = `<div class="empty">Render error: ${esc(e.message)}</div>`; }
    }
    applyLayout();
    // Don't rebuild settings under the user while they're dragging a slider or picking a game.
    if (!root.activeElement?.matches("input, select")) renderSettings();
  }

  // Situation: score, base/out state, RE24, win probability, leverage.
  RENDER.situation = (c) => {
    const ls = c.ld.linescore, off = ls.offense || {};
    const bases = (off.first ? 1 : 0) | (off.second ? 2 : 0) | (off.third ? 4 : 0);
    const outs = Math.min(ls.outs ?? 0, 2);
    const count = c.cur?.count || { balls: 0, strikes: 0 };
    const live = c.status.abstractGameState === "Live";
    const half = ls.isTopInning ? "▲" : "▼";
    const last = c.wp[c.wp.length - 1];
    const homeWP = last ? last.homeTeamWinProbability : 50;
    const li = last?.leverageIndex;
    const liPc = li == null ? null : { p: Math.max(1, Math.min(100, Math.round(50 + 35 * Math.log2(li)))) };
    const re = live && (ls.outs ?? 0) < 3 ? RE24[bases][outs] : null;
    const dot = (on, cls) => `<i class="pip ${on ? cls : ""}"></i>`;
    const pips = (n, max, cls) => Array.from({ length: max }, (_, i) => dot(i < n, cls)).join("");
    const base = (on, x, y) => `<rect x="${x}" y="${y}" width="16" height="16" transform="rotate(45 ${x + 8} ${y + 8})" class="${on ? "on" : ""}"/>`;
    return `
      <div class="score">
        <div><b>${esc(c.away.abbreviation)}</b><span>${ls.teams?.away?.runs ?? 0}</span></div>
        <div class="inn">${live ? `${half} ${esc(ls.currentInningOrdinal || "")}` : esc(c.status.detailedState)}</div>
        <div><span>${ls.teams?.home?.runs ?? 0}</span><b>${esc(c.home.abbreviation)}</b></div>
      </div>
      <div class="sit">
        <svg viewBox="0 0 70 50" class="diamond">${base(bases & 2, 27, 4)}${base(bases & 4, 7, 22)}${base(bases & 1, 47, 22)}</svg>
        <div class="cnt">
          <div><span class="lbl">B</span>${pips(count.balls, 3, "ball")}</div>
          <div><span class="lbl">S</span>${pips(count.strikes, 2, "strike")}</div>
          <div><span class="lbl">O</span>${pips(ls.outs ?? 0, 2, "out")}</div>
        </div>
      </div>
      <div class="kv">
        <div><span>Run expectancy</span><b>${re == null ? "—" : re.toFixed(2)}</b><em>${BASE_LABEL[bases]}, ${outs} out</em></div>
        <div><span>Leverage index</span><b ${pctStyle(liPc)}>${li == null ? "—" : f2(li)}</b><em>${li == null ? "" : li >= 2 ? "high" : li >= 0.85 ? "medium" : "low"}</em></div>
      </div>
      <div class="wpbar" title="Win probability">
        <div class="a" style="width:${100 - homeWP}%"><span>${esc(c.away.abbreviation)} ${(100 - homeWP).toFixed(1)}%</span></div>
        <div class="h"><span>${(+homeWP).toFixed(1)}% ${esc(c.home.abbreviation)}</span></div>
      </div>`;
  };

  // Matchup: season sabermetrics for batter and pitcher, platoon split, career head-to-head.
  RENDER.matchup = (c) => {
    const m = c.cur?.matchup;
    if (!m) return `<div class="empty">Waiting for first batter. Probable starters:<br>${esc(c.gd.probablePitchers?.away?.fullName || "TBD")} vs ${esc(c.gd.probablePitchers?.home?.fullName || "TBD")}</div>`;
    const b = playerStats("hit", m.batter.id, c.season) || {};
    const p = playerStats("pit", m.pitcher.id, c.season) || {};
    const bvp = bvpStats(m.batter.id, m.pitcher.id) || {};
    const bs = b.season || {}, bx = b.sabermetrics || {}, split = b[m.pitchHand.code === "L" ? "vl" : "vr"] || {};
    const ps = p.season || {}, px = p.sabermetrics || {};
    const box = (side, id) => c.ld.boxscore?.teams?.[side]?.players?.["ID" + id]?.stats || {};
    const batSide = c.cur.about.isTopInning ? "away" : "home", pitSide = batSide === "away" ? "home" : "away";
    const bToday = box(batSide, m.batter.id).batting?.summary, pToday = box(pitSide, m.pitcher.id).pitching;
    const pa = num(bs.plateAppearances), bf = num(ps.battersFaced);
    const iso = num(bs.slg) - num(bs.avg);
    const kPct = (100 * num(ps.strikeOuts)) / bf, bbPct = (100 * num(ps.baseOnBalls)) / bf;
    const cell = (label, val, pc) => `<div><span>${label}</span><b>${val}</b>${bubble(pc)}</div>`;
    const sv = (kind, id, col) => savantPct(kind, c.season, id, col);
    const bK = (100 * num(bs.strikeOuts)) / pa, bBB = (100 * num(bs.baseOnBalls)) / pa;
    const bvpLine = num(bvp.plateAppearances) > 0
      ? `${bvp.hits}-${bvp.atBats}, ${bvp.homeRuns} HR, ${bvp.baseOnBalls} BB, ${bvp.strikeOuts} K · ${f3(bvp.avg)}/${f3(bvp.obp)}/${f3(bvp.slg)} in ${bvp.plateAppearances} PA`
      : "No career meetings";
    return `
      <div class="mu">
        <div class="who"><b>${esc(m.batter.fullName)}</b><em>Bats ${m.batSide.code} · ${bToday ? esc(bToday) : "—"}</em></div>
        <div class="slash">${f3(bs.avg)} / ${f3(bs.obp)} / ${f3(bs.slg)} <em>${f0(pa)} PA</em></div>
        <div class="grid">
          ${cell("wOBA", f3(bx.woba), estPct(bx.woba, 0.315, 0.033))}
          ${cell("wRC+", f0(bx.wRcPlus), estPct(bx.wRcPlus, 100, 22))}
          ${cell("ISO", f3(iso), estPct(iso, 0.16, 0.05))}
          ${cell("K%", pct(num(bs.strikeOuts), pa), sv("batter", m.batter.id, "k_percent") || estPct(bK, 22.5, 5.5, false))}
          ${cell("BB%", pct(num(bs.baseOnBalls), pa), sv("batter", m.batter.id, "bb_percent") || estPct(bBB, 8.5, 2.7))}
          ${cell("BABIP", f3(bs.babip))}
          ${cell("WAR", f1(bx.war), estPct(bx.war, 1.5, 1.8))}
          ${cell(`OPS v${m.pitchHand.code}`, f3(split.ops), estPct(split.ops, 0.72, 0.09))}
        </div>
      </div>
      <div class="mu">
        <div class="who"><b>${esc(m.pitcher.fullName)}</b><em>Throws ${m.pitchHand.code} · ${pToday ? `${esc(pToday.inningsPitched)} IP, ${pToday.numberOfPitches ?? pToday.pitchesThrown ?? 0} P` : "—"}</em></div>
        <div class="grid">
          ${cell("ERA", f2(ps.era), estPct(ps.era, 4.1, 0.9, false))}
          ${cell("FIP", f2(px.fip), estPct(px.fip, 4.1, 0.7, false))}
          ${cell("xFIP", f2(px.xfip), estPct(px.xfip, 4.05, 0.55, false))}
          ${cell("WHIP", f2(ps.whip), estPct(ps.whip, 1.28, 0.16, false))}
          ${cell("K%", isNaN(kPct) ? "—" : kPct.toFixed(1) + "%", sv("pitcher", m.pitcher.id, "k_percent") || estPct(kPct, 22.5, 5))}
          ${cell("BB%", isNaN(bbPct) ? "—" : bbPct.toFixed(1) + "%", sv("pitcher", m.pitcher.id, "bb_percent") || estPct(bbPct, 8.3, 2, false))}
          ${cell("K−BB%", isNaN(kPct) ? "—" : (kPct - bbPct).toFixed(1) + "%", estPct(kPct - bbPct, 14, 5.5))}
          ${cell("WAR", f1(px.war), estPct(px.war, 1.2, 1.5))}
        </div>
      </div>
      <div class="bvp"><span>Career H2H</span> ${esc(bvpLine)}</div>
      <p class="legend"><span class="ramp"></span> percentile, red = good for player · <i class="pb mini"></i> Savant <i class="pb mini est"></i> est. · ${esc(c.season)} reg. season</p>`;
  };

  const pitchClass = (code) =>
    WHIFF.has(code) ? "whiff" : code === "C" ? "called" : ["F", "T", "L", "R", "O"].includes(code) ? "foul" : ["X", "D", "E"].includes(code) ? "inplay" : "ball";

  // At-bat pitches: strike-zone plot (catcher's view) + pitch-by-pitch Statcast.
  RENDER.pitches = (c) => {
    let play = c.cur, note = "";
    let pitches = (play?.playEvents || []).filter((e) => e.isPitch);
    if (!pitches.length) {
      play = [...c.all].reverse().find((p) => p.about.isComplete && p.playEvents?.some((e) => e.isPitch));
      pitches = (play?.playEvents || []).filter((e) => e.isPitch);
      note = play ? `Previous PA: ${esc(play.matchup.batter.fullName)} — ${esc(play.result.event)}` : "";
    }
    if (!pitches.length) return `<div class="empty">No pitches yet.</div>`;
    const top = pitches.find((p) => p.pitchData?.strikeZoneTop)?.pitchData.strikeZoneTop ?? 3.4;
    const bot = pitches.find((p) => p.pitchData?.strikeZoneBottom)?.pitchData.strikeZoneBottom ?? 1.6;
    // SVG units: 1 ft = 40 px; x range -1.6..1.6 ft, z range 0.6..4.4 ft (clamped so wild pitches stay visible).
    const X = (px) => (Math.max(-1.5, Math.min(1.5, px)) + 1.6) * 40, Z = (pz) => (4.4 - Math.max(0.7, Math.min(4.3, pz))) * 40;
    const dots = pitches.map((p, i) => {
      const d = p.pitchData?.coordinates;
      if (d?.pX == null) return "";
      return `<g class="pd ${pitchClass(p.details.code)}"><circle cx="${X(d.pX)}" cy="${Z(d.pZ)}" r="8"/><text x="${X(d.pX)}" y="${Z(d.pZ) + 3.5}">${i + 1}</text></g>`;
    }).join("");
    const rows = pitches.map((p, i) => {
      const pd = p.pitchData || {}, br = pd.breaks || {};
      return `<tr><td><i class="sw ${pitchClass(p.details.code)}"></i>${i + 1}</td><td>${esc(p.details.type?.code || "")}</td><td>${f1(pd.startSpeed)}</td><td>${f0(br.spinRate)}</td><td>${f1(br.breakVerticalInduced)}</td><td>${f1(br.breakHorizontal)}</td><td class="res">${esc(p.details.description)}</td></tr>`;
    }).join("");
    return `
      ${note ? `<div class="note">${note}</div>` : `<div class="note">${esc(play.matchup.pitcher.fullName)} → ${esc(play.matchup.batter.fullName)}</div>`}
      <div class="pz">
        <svg viewBox="0 0 128 160" class="zone">
          <rect x="${X(-0.708)}" y="${Z(top)}" width="${0.708 * 80}" height="${(top - bot) * 40}" class="sz"/>
          ${[1, 2].map((k) => `<line x1="${X(-0.708 + (k * 1.416) / 3)}" x2="${X(-0.708 + (k * 1.416) / 3)}" y1="${Z(top)}" y2="${Z(bot)}"/><line x1="${X(-0.708)}" x2="${X(0.708)}" y1="${Z(top - (k * (top - bot)) / 3)}" y2="${Z(top - (k * (top - bot)) / 3)}"/>`).join("")}
          <path d="M${X(-0.708)} 150 L${X(0.708)} 150 L${X(0.708)} 154 L64 159 L${X(-0.708)} 154Z" class="plate"/>
          ${dots}
        </svg>
        <table class="pt"><thead><tr><th>#</th><th>Type</th><th>MPH</th><th>Spin</th><th title="Induced vertical break (in)">IVB</th><th title="Horizontal break (in)">HB</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
      <p class="legend"><i class="sw ball"></i>ball <i class="sw called"></i>called K <i class="sw whiff"></i>whiff <i class="sw foul"></i>foul <i class="sw inplay"></i>in play · catcher's view</p>`;
  };

  // Pitcher today: line + arsenal (usage, velo, spin, whiff%, CSW%) from every pitch in this game.
  RENDER.arsenal = (c) => {
    const m = c.cur?.matchup;
    if (!m) return `<div class="empty">No pitcher yet.</div>`;
    const pid = m.pitcher.id;
    const mix = {};
    let total = 0, strikes = 0;
    for (const play of c.all) {
      if (play.matchup.pitcher.id !== pid) continue;
      for (const e of play.playEvents || []) {
        if (!e.isPitch) continue;
        const type = e.details.type?.description || e.details.type?.code || "Unknown";
        const r = (mix[type] ||= { n: 0, v: [], spin: [], ivb: [], swing: 0, whiff: 0, csw: 0 });
        r.n++; total++;
        if (e.details.isStrike || e.details.isInPlay) strikes++;
        const pd = e.pitchData || {};
        if (pd.startSpeed) r.v.push(pd.startSpeed);
        if (pd.breaks?.spinRate) r.spin.push(pd.breaks.spinRate);
        if (pd.breaks?.breakVerticalInduced != null) r.ivb.push(pd.breaks.breakVerticalInduced);
        const code = e.details.code;
        if (SWING.has(code)) r.swing++;
        if (WHIFF.has(code)) r.whiff++, r.csw++;
        if (code === "C") r.csw++;
      }
    }
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
    const side = c.cur.about.isTopInning ? "home" : "away";
    const line = c.ld.boxscore?.teams?.[side]?.players?.["ID" + pid]?.stats?.pitching || {};
    const tot = Object.values(mix).reduce((a, r) => ({ sw: a.sw + r.swing, wh: a.wh + r.whiff, csw: a.csw + r.csw }), { sw: 0, wh: 0, csw: 0 });
    const rows = Object.entries(mix).sort((a, b) => b[1].n - a[1].n).map(([t, r]) =>
      `<tr><td>${esc(t)}</td><td>${r.n}</td><td>${pct(r.n, total)}</td><td>${f1(avg(r.v))}</td><td>${f1(Math.max(...r.v))}</td><td>${f0(avg(r.spin))}</td><td>${f1(avg(r.ivb))}</td><td>${pct(r.whiff, r.swing)}</td><td>${pct(r.csw, r.n)}</td></tr>`).join("");
    return `
      <div class="note"><b>${esc(m.pitcher.fullName)}</b> · ${esc(line.inningsPitched ?? "0.0")} IP, ${line.hits ?? 0} H, ${line.runs ?? 0} R, ${line.earnedRuns ?? 0} ER, ${line.baseOnBalls ?? 0} BB, ${line.strikeOuts ?? 0} K</div>
      <div class="kv tight">
        <div><span>Pitches</span><b>${total}</b></div>
        <div><span>Strike%</span><b>${pct(strikes, total)}</b>${bubble(total >= 10 && estPct((100 * strikes) / total, 64, 3))}</div>
        <div><span>Whiff%</span><b>${pct(tot.wh, tot.sw)}</b>${bubble(tot.sw >= 5 && estPct((100 * tot.wh) / tot.sw, 25, 5.5))}</div>
        <div><span>CSW%</span><b>${pct(tot.csw, total)}</b>${bubble(total >= 10 && estPct((100 * tot.csw) / total, 28.5, 3))}</div>
      </div>
      ${total ? `<table class="pt"><thead><tr><th>Pitch</th><th>#</th><th>Use</th><th>Velo</th><th>Max</th><th>Spin</th><th>IVB</th><th>Whiff</th><th>CSW</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">No pitches thrown yet.</div>`}`;
  };

  // Batted balls: recent contact quality and team-level exit velocity / hard-hit / barrels.
  RENDER.batted = (c) => {
    const balls = [];
    for (const play of c.all) {
      for (const e of play.playEvents || []) {
        const h = e.hitData;
        if (!h || h.launchSpeed == null) continue;
        balls.push({ team: play.about.isTopInning ? "away" : "home", batter: play.matchup.batter.fullName, ev: h.launchSpeed, la: h.launchAngle, dist: h.totalDistance, res: play.result?.event || e.details?.description });
      }
    }
    if (!balls.length) return `<div class="empty">No balls in play yet.</div>`;
    const sum = (side) => {
      const b = balls.filter((x) => x.team === side);
      return { n: b.length, ev: b.length ? b.reduce((s, x) => s + x.ev, 0) / b.length : NaN, hard: b.filter((x) => x.ev >= 95).length, brl: b.filter((x) => isBarrel(x.ev, x.la)).length, max: Math.max(0, ...b.map((x) => x.ev)) };
    };
    const A = sum("away"), H = sum("home");
    const tag = (b) => (isBarrel(b.ev, b.la) ? `<em class="tag brl">Barrel</em>` : b.ev >= 95 ? `<em class="tag hard">Hard</em>` : b.ev < 80 ? `<em class="tag weak">Weak</em>` : "");
    const recent = balls.slice(-6).reverse().map((b) =>
      `<tr><td>${esc(lastName(b.batter))}</td><td ${pctStyle(estPct(b.ev, 89, 9))}>${f1(b.ev)}</td><td>${f0(b.la)}°</td><td>${f0(b.dist)}</td><td class="res">${esc(b.res)} ${tag(b)}</td></tr>`).join("");
    return `
      <table class="pt team"><thead><tr><th></th><th>BIP</th><th>Avg EV</th><th>Max EV</th><th>Hard%</th><th>Barrels</th></tr></thead><tbody>
        <tr><td><b>${esc(c.away.abbreviation)}</b></td><td>${A.n}</td><td>${f1(A.ev)}</td><td>${A.n ? f1(A.max) : "—"}</td><td>${pct(A.hard, A.n)}</td><td>${A.brl}</td></tr>
        <tr><td><b>${esc(c.home.abbreviation)}</b></td><td>${H.n}</td><td>${f1(H.ev)}</td><td>${H.n ? f1(H.max) : "—"}</td><td>${pct(H.hard, H.n)}</td><td>${H.brl}</td></tr>
      </tbody></table>
      <table class="pt"><thead><tr><th>Batter</th><th>EV</th><th>LA</th><th>Dist</th><th>Result</th></tr></thead><tbody>${recent}</tbody></table>`;
  };

  // Win probability: home WP over the game + biggest swings (WPA).
  RENDER.winprob = (c) => {
    if (!c.wp.length) return `<div class="empty">Win probability appears after the first plate appearance.</div>`;
    const W = 300, Hh = 90, n = c.wp.length;
    const x = (i) => (n === 1 ? W : (i / (n - 1)) * W), y = (v) => Hh - (v / 100) * Hh;
    const pts = c.wp.map((p, i) => `${x(i).toFixed(1)},${y(p.homeTeamWinProbability).toFixed(1)}`).join(" ");
    const innTicks = c.wp.map((p, i) => (i > 0 && p.about.inning !== c.wp[i - 1].about.inning ? `<line x1="${x(i)}" x2="${x(i)}" y1="0" y2="${Hh}" class="tick"/><text x="${x(i) + 2}" y="${Hh - 3}" class="tl">${p.about.inning}</text>` : "")).join("");
    const swings = [...c.wp].sort((a, b) => Math.abs(b.homeTeamWinProbabilityAdded) - Math.abs(a.homeTeamWinProbabilityAdded)).slice(0, 2);
    const last = c.wp[n - 1].homeTeamWinProbability;
    return `
      <svg viewBox="0 0 ${W} ${Hh}" class="wp" preserveAspectRatio="none">
        <rect x="0" y="0" width="${W}" height="${Hh / 2}" class="hz"/>
        ${innTicks}
        <line x1="0" x2="${W}" y1="${Hh / 2}" y2="${Hh / 2}" class="mid"/>
        <polyline points="0,${Hh / 2} ${pts}" class="line"/>
        <circle cx="${x(n - 1)}" cy="${y(last)}" r="3" class="end"/>
      </svg>
      <div class="wplab"><span>${esc(c.home.abbreviation)} ↑</span><span>${esc(c.away.abbreviation)} ↓</span></div>
      <div class="swings">${swings.map((p) => {
        const d = p.homeTeamWinProbabilityAdded, team = d >= 0 ? c.home.abbreviation : c.away.abbreviation;
        return `<div><b class="${d >= 0 ? "hh" : "aa"}">${esc(team)} +${Math.abs(d).toFixed(1)}%</b> <em>${p.about.isTopInning ? "▲" : "▼"}${p.about.inning}</em> ${esc(p.result.description)}</div>`;
      }).join("")}</div>`;
  };

  // ---------- boot ----------
  applyLayout();
  loadGames().then(poll);
  setInterval(loadGames, 10 * 60 * 1000);
  setInterval(render, 1000);
  // Auto-detect may change when YouTube TV navigates between channels.
  let lastTitle = document.title;
  setInterval(() => { if (document.title !== lastTitle) { lastTitle = document.title; if (settings.gamePk === "auto") poll(); } }, 3000);
  window.__sabrOverlayDebug = { get settings() { return settings; }, get games() { return games; }, poll, render: () => { dirty = true; render(); } };

  function CSS() {
    return `
    :host { all: initial; }
    .layer { --op: .9; --bg: rgba(12,15,20,var(--op)); --line: rgba(255,255,255,.1); --fg: #e8ecf1; --mut: #8a94a3;
      --hot: #e8545c; --hot2: #d62934; --cold: #6f97d8; --cold2: #325eac; --acc: #f5c542;
      font: 12px/1.35 "Inter", "SF Pro Text", system-ui, sans-serif; color: var(--fg); font-variant-numeric: tabular-nums; }
    .layer.off .panel { display: none !important; }
    .panel, .settings { position: fixed; pointer-events: auto; width: 320px; background: var(--bg); border: 1px solid var(--line);
      border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.45); backdrop-filter: blur(8px); overflow: hidden; }
    .panel.min .body { display: none; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px 6px 10px; cursor: grab;
      border-bottom: 1px solid var(--line); user-select: none; touch-action: none; }
    header:active { cursor: grabbing; }
    header .t { font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; color: var(--acc); font-weight: 700; }
    header button { all: unset; cursor: pointer; color: var(--mut); width: 18px; text-align: center; font-size: 14px; line-height: 14px; }
    header button:hover { color: var(--fg); }
    .body { padding: 8px 10px 10px; }
    .empty { color: var(--mut); padding: 6px 0; }
    .note { color: var(--mut); margin-bottom: 6px; } .note b { color: var(--fg); }
    em { font-style: normal; color: var(--mut); }
    .hot1 { color: var(--hot); } .hot2 { color: var(--hot2); } .cold1 { color: var(--cold); } .cold2 { color: var(--cold2); }
    .score { display: flex; justify-content: space-between; align-items: center; font-size: 20px; font-weight: 700; }
    .score > div { display: flex; gap: 8px; align-items: center; } .score b { font-size: 14px; color: var(--mut); }
    .score .inn { font-size: 12px; color: var(--acc); font-weight: 600; }
    .sit { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; }
    .diamond { width: 84px; height: 60px; } .diamond rect { fill: none; stroke: var(--mut); stroke-width: 1.5; } .diamond rect.on { fill: var(--acc); stroke: var(--acc); }
    .cnt > div { display: flex; align-items: center; gap: 4px; height: 17px; } .lbl { width: 12px; color: var(--mut); font-weight: 700; }
    .pip { display: inline-block; width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--mut); box-sizing: border-box; }
    .pip.ball { background: #3ecf8e; border-color: #3ecf8e; } .pip.strike { background: var(--hot2); border-color: var(--hot2); } .pip.out { background: var(--acc); border-color: var(--acc); }
    .kv { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; } .kv.tight { grid-template-columns: repeat(4,1fr); margin-bottom: 8px; }
    .kv > div { background: rgba(255,255,255,.04); border-radius: 6px; padding: 5px 7px; display: flex; flex-direction: column; }
    .kv span { color: var(--mut); font-size: 10.5px; } .kv b { font-size: 16px; } .kv em { font-size: 10.5px; }
    .wpbar { display: flex; height: 20px; margin-top: 8px; border-radius: 5px; overflow: hidden; font-size: 10.5px; font-weight: 700; }
    .wpbar > div { display: flex; align-items: center; padding: 0 6px; white-space: nowrap; overflow: hidden; }
    .wpbar .a { background: #3a4458; } .wpbar .h { flex: 1; background: #6b5a1f; justify-content: flex-end; }
    .mu { margin-bottom: 8px; } .who { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; } .who b { font-size: 13px; }
    .slash { font-size: 15px; font-weight: 600; margin: 2px 0 4px; } .slash em { font-size: 11px; font-weight: 400; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
    .grid > div, .kv > div { position: relative; }
    .grid > div { background: rgba(255,255,255,.04); border-radius: 5px; padding: 3px 5px; display: flex; flex-direction: column; }
    i.pb { position: absolute; top: 4px; right: 4px; min-width: 19px; height: 19px; padding: 0 2px; box-sizing: border-box; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; font: 700 9.5px/1 system-ui, sans-serif; font-style: normal; color: #fff;
      border: 1.5px solid rgba(255,255,255,.85); text-shadow: 0 0 2px rgba(0,0,0,.35); }
    i.pb.est { border: 1.5px dashed rgba(255,255,255,.45); opacity: .88; }
    .kv i.pb { top: 6px; right: 6px; }
    .legend i.pb.mini { position: static; display: inline-block; min-width: 9px; height: 9px; vertical-align: -1px; margin-left: 4px; background: rgb(214,41,52); }
    .legend i.pb.mini.est { background: rgb(168,168,168); }
    .ramp { display: inline-block; width: 34px; height: 7px; border-radius: 4px; vertical-align: 0; background: linear-gradient(90deg, rgb(50,94,172), rgb(168,168,168), rgb(214,41,52)); }
    .grid span { color: var(--mut); font-size: 10px; } .grid b { font-size: 13px; }
    .bvp { border-top: 1px solid var(--line); padding-top: 6px; } .bvp span { color: var(--acc); font-weight: 600; margin-right: 4px; }
    .legend { color: var(--mut); font-size: 10px; margin: 6px 0 0; }
    .pz { display: flex; gap: 8px; align-items: flex-start; } .zone { width: 116px; flex: none; }
    .zone .sz { fill: rgba(255,255,255,.04); stroke: var(--fg); stroke-width: 1.2; } .zone line { stroke: rgba(255,255,255,.18); }
    .zone .plate { fill: rgba(255,255,255,.25); }
    .pd circle { stroke: rgba(0,0,0,.6); stroke-width: 1; } .pd text { font-size: 9px; text-anchor: middle; fill: #000; font-weight: 700; }
    .ball circle, i.sw.ball { fill: #3ecf8e; background: #3ecf8e; } .called circle, i.sw.called { fill: var(--hot2); background: var(--hot2); }
    .whiff circle, i.sw.whiff { fill: #ff9f1c; background: #ff9f1c; } .foul circle, i.sw.foul { fill: #ffd84d; background: #ffd84d; }
    .inplay circle, i.sw.inplay { fill: var(--cold); background: var(--cold); }
    i.sw { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 3px; vertical-align: 1px; }
    .legend i.sw { margin-left: 4px; }
    table.pt { width: 100%; border-collapse: collapse; font-size: 11px; }
    .pt th { color: var(--mut); font-weight: 600; text-align: right; padding: 2px 3px; border-bottom: 1px solid var(--line); font-size: 10px; }
    .pt td { text-align: right; padding: 2px 3px; white-space: nowrap; }
    .pt th:first-child, .pt td:first-child { text-align: left; } .pt td.res, .pt th:last-child { text-align: left; white-space: normal; color: var(--mut); }
    .pt.team { margin-bottom: 8px; } .pt.team td { font-size: 12px; } .pt.team th:last-child { text-align: right; }
    .panel[data-id=pitches] { width: 380px; } .panel[data-id=arsenal] { width: 380px; } .panel[data-id=batted] { width: 340px; }
    .tag { font-size: 9.5px; font-weight: 700; padding: 0 4px; border-radius: 3px; margin-left: 2px; }
    .tag.brl { background: var(--hot2); color: #fff; } .tag.hard { background: rgba(255,122,89,.25); color: var(--hot); } .tag.weak { background: rgba(90,169,255,.18); color: var(--cold); }
    svg.wp { width: 100%; height: 90px; display: block; } .wp .hz { fill: rgba(245,197,66,.06); } .wp .mid { stroke: rgba(255,255,255,.3); stroke-dasharray: 3 3; }
    .wp .tick { stroke: rgba(255,255,255,.08); } .wp .tl { fill: var(--mut); font-size: 8px; }
    .wp .line { fill: none; stroke: var(--acc); stroke-width: 1.8; vector-effect: non-scaling-stroke; } .wp .end { fill: var(--acc); }
    .wplab { display: flex; justify-content: space-between; color: var(--mut); font-size: 10px; margin: 2px 0 6px; }
    .swings > div { padding: 3px 0; border-top: 1px solid var(--line); color: var(--mut); font-size: 11px; }
    .swings b.hh { color: var(--acc); } .swings b.aa { color: #9fb3d9; }
    .fab { all: unset; position: fixed; right: 16px; top: 16px; pointer-events: auto; cursor: pointer; background: var(--bg);
      border: 1px solid var(--line); border-radius: 999px; padding: 5px 11px; font: 700 11px/1 system-ui, sans-serif; letter-spacing: .1em; color: var(--acc);
      display: flex; align-items: center; gap: 6px; opacity: .55; transition: opacity .15s; }
    .fab:hover { opacity: 1; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--mut); } .dot.live { background: #3ecf8e; box-shadow: 0 0 6px #3ecf8e; } .dot.bad { background: var(--hot2); }
    .settings { right: 16px; top: 50px; width: 300px; } .settings.hidden { display: none; } .settings header { cursor: default; }
    .settings label { display: block; margin-bottom: 9px; color: var(--mut); } .settings .v { float: right; color: var(--fg); }
    .settings select, .settings input[type=range] { display: block; width: 100%; margin-top: 4px; box-sizing: border-box; }
    .settings select { background: #1c222c; color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 5px; font: inherit; }
    .settings input[type=range] { accent-color: var(--acc); }
    .checks { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; margin: 4px 0 8px; } .settings .chk { margin: 0; color: var(--fg); display: flex; gap: 6px; align-items: center; }
    .checks input { accent-color: var(--acc); margin: 0; }
    .row { display: flex; gap: 6px; } .row button { all: unset; cursor: pointer; flex: 1; text-align: center; padding: 6px; border-radius: 6px; background: rgba(255,255,255,.07); color: var(--fg); }
    .row button:hover { background: rgba(255,255,255,.13); }
    .row + .row, label + .row { margin-bottom: 9px; } .row button.pri { flex: 2.5; background: rgba(245,197,66,.18); color: var(--acc); font-weight: 600; }
    .sync { display: flex; flex-direction: column; gap: 3px; margin-bottom: 9px; }
    .sync button { all: unset; cursor: pointer; display: flex; justify-content: space-between; gap: 6px; padding: 5px 7px; border-radius: 5px; background: rgba(255,255,255,.05); font-size: 11px; }
    .sync button:hover { background: rgba(245,197,66,.18); } .sync em { white-space: nowrap; }
    .hint { color: var(--mut); font-size: 10.5px; margin: -4px 0 9px; } .row + .hint { margin-top: 9px; } .err { color: var(--hot2); }
    `;
  }
})();
