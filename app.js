/* ============ 音樂庫 — encrypted static player ============ */
"use strict";
const $ = id => document.getElementById(id);
function makeAudio() {
  const a = new Audio();
  a.preload = "auto"; a.preservesPitch = true;
  if ("webkitPreservesPitch" in a) a.webkitPreservesPitch = true;
  a.onplay  = () => { playing = true;  $("playBtn").textContent = "❚❚"; tick(); };
  a.onpause = () => { playing = false; $("playBtn").textContent = "▶"; render(true); };
  a.ontimeupdate = () => render();
  a.onended = () => { if (cur) logPlay(cur, a.currentTime, true);
    if (!loopOn) { if (nextTrack(true)) return; }
    render(true); };
  a.onloadedmetadata = () => { if (pendingSeek > 0 && pendingSeek < a.duration) a.currentTime = pendingSeek; render(true); };
  return a;
}
let audio = makeAudio();
let shuffleOn = false;
try { shuffleOn = localStorage.getItem("ma_shuf") === "1"; } catch (e) {}

let KEY = null;                       // CryptoKey after unlock
let CAT = null;                       // decrypted catalog
let TRACKS = [];                      // flat [{id,title,artist,album,dur,file,lrc,cover,albumId,artistId}]
let cur = null, queue = [], lines = [], curLine = -1, seeking = false;
let key = 0, loopOn = false, playing = false, lyrOff = 0, pendingSeek = 0;
const SPD = [0.5,0.6,0.7,0.8,0.9,1,1.1,1.2]; let spdIdx = 5;
let userScrollUntil = 0, renderToken = 0;
const blobCache = {}, coverCache = {};
const encKeyCache = {};               // "trackId|key" → objectURL (pitch-rendered)

/* ---------- crypto ---------- */
const te = new TextEncoder();
async function deriveKey(pass) {
  const hint = await (await fetch("keyhint.json")).json();
  const pm = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: Uint8Array.from(hint.salt.match(/../g).map(h => parseInt(h, 16))),
      iterations: hint.iter, hash: "SHA-256" }, pm,
    { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}
async function decFile(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const iv = new Uint8Array(buf, 0, 12);
  return await crypto.subtle.decrypt({ name: "AES-GCM", iv }, KEY, buf.slice(12));
}
const mediaBlob = async url => {
  if (blobCache[url]) return blobCache[url];
  const data = await decFile(url);
  const ext = url.endsWith(".lrc.enc") ? "text/plain" : "audio/mpeg";
  return blobCache[url] = URL.createObjectURL(new Blob([data], { type: ext }));
};

/* ---------- unlock ---------- */
async function unlock() {
  const pass = $("passIn").value;
  $("lockErr").textContent = "";
  if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
    $("lockErr").textContent = "✗ 此連線不是 HTTPS — 解密功能無法運作。請改用 https://… （GitHub Pages）網址";
    return;
  }
  try {
    KEY = await deriveKey(pass);
    const json = await decFile("data/manifest.enc");
    CAT = JSON.parse(new TextDecoder().decode(json));
    if ($("remember").checked) localStorage.setItem("ma_pass", pass);   // store in this profile
    buildIndex();
    $("lock").style.display = "none";
    $("app").hidden = false;
    renderView();
    showResume();
    loadAiResults();
  } catch (e) {
    localStorage.removeItem("ma_pass");                                  // stale/failed → forget
    $("lockErr").textContent =
      e.name === "OperationError" ? "密碼錯誤 ✗" :
      e instanceof TypeError ? "載入失敗 — 找不到加密檔（檢查網址路徑）" :
      ("載入失敗：" + (e.message || e));
  }
}
async function autoUnlock() {
  const saved = localStorage.getItem("ma_pass");
  if (!saved) return;
  $("remember").checked = true;
  $("passIn").value = saved;
  await unlock();
}
$("unlockBtn").onclick = unlock;
$("passIn").addEventListener("keydown", e => { if (e.key === "Enter") unlock(); });
$("lockBtn2").onclick = () => { localStorage.removeItem("ma_pass"); location.reload(); };  // 🔒 = forget + lock

/* ---------- index & search ---------- */
const norm = s => s.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}]/gu, "");
function buildIndex() {
  TRACKS = [];
  for (const a of CAT.artists) for (const al of a.albums) for (const t of al.tracks)
    TRACKS.push({ ...t, artist: a.name, artistId: a.id, album: al.title, albumId: al.id,
      cover: al.cover || null, hay: norm(t.title + " " + a.name + " " + al.title) });
}
function search(q) {
  q = norm(q); if (!q) return null;
  const out = TRACKS.filter(t => t.hay.includes(q));
  out.sort((a, b) => a.title.length - b.title.length);
  return out;
}

function showResume() {
  try {
    const last = JSON.parse(localStorage.getItem("ma_last") || "null");
    const t = last && TRACKS.find(x => x.id === last.id);
    if (t && last.t > 10) {
      $("resumeTxt").textContent = `${t.title} — ${t.artist} @ ${fmt(last.t)}`;
      $("resumeBar").hidden = false;
      $("resumeBar").onclick = () => {
        $("resumeBar").hidden = true;
        pendingSeek = last.t;
        playQueue([t]);
      };
    }
  } catch (e) {}
}

/* ---------- library view ---------- */
let drillArtist = null, drillAlbum = null;
const hue = id => parseInt(id, 16) % 360;
function coverEl(cover, albumId, size) {
  if (cover) {
    const img = document.createElement("img");
    img.className = "cover";
    if (coverCache[cover]) img.src = coverCache[cover];
    else mediaBlob(cover).then(u => { img.src = coverCache[cover] = u; }).catch(() => {});
    return img;
  }
  const d = document.createElement("div");
  d.className = "cover";
  d.style.cssText = `width:${size}px;height:${size}px;background:linear-gradient(135deg,hsl(${hue(albumId)},45%,32%),hsl(${(hue(albumId)+40)%360},45%,18%))`;
  d.textContent = "♪";
  return d;
}
function renderView() {
  const q = $("searchIn").value.trim();
  const v = document.querySelector("#nav .on").dataset.v;
  $("libView").hidden = v !== "lib"; $("aiView").hidden = v !== "ai";
  $("plView").hidden = v !== "pl"; $("histView").hidden = v !== "hist";
  if (v === "ai") renderAiView();
  if (v === "lib") renderLib(q);
  else if (v === "pl") renderPl();
  else renderHist();
}
function renderLib(q) {
  const el = $("libView"); el.innerHTML = "";
  if (q) {                                       // search results
    const res = search(q) || [];
    el.appendChild(Object.assign(document.createElement("div"),
      { className: "backLink", textContent: `找到 ${res.length} 首`, onclick: () => { $("searchIn").value = ""; renderView(); } }));
    res.forEach(t => el.appendChild(trackRow(t)));
    return;
  }
  if (drillAlbum) {                              // album track list
    const a = CAT.artists.find(x => x.id === drillArtist), al = a.albums.find(x => x.id === drillAlbum);
    const back = Object.assign(document.createElement("span"),
      { className: "backLink", textContent: `‹ ${a.name}` });
    back.onclick = () => { drillAlbum = null; renderView(); };
    el.appendChild(back);
    const head = document.createElement("div"); head.className = "albumHead";
    head.appendChild(coverEl(al.cover, al.id, 84));
    const meta = document.createElement("div");
    meta.innerHTML = `<b>${al.title}</b><span>${a.name}${al.year ? " · " + al.year : ""} · ${al.tracks.length} 首</span>`;
    head.appendChild(meta);
    const playAll = Object.assign(document.createElement("button"),
      { className: "btn", textContent: "▶ 全部播放" });
    playAll.onclick = () => playQueue(al.tracks.map(t => findTrack(t.id)));
    head.appendChild(playAll);
    el.appendChild(head);
    al.tracks.forEach(t => el.appendChild(trackRow(findTrack(t.id))));
  } else if (drillArtist) {                      // albums of artist
    const a = CAT.artists.find(x => x.id === drillArtist);
    const back = Object.assign(document.createElement("span"),
      { className: "backLink", textContent: "‹ 歌手" });
    back.onclick = () => { drillArtist = null; renderView(); };
    el.appendChild(back);
    a.albums.forEach(al => {
      const row = document.createElement("div"); row.className = "artistRow";
      row.appendChild(coverEl(al.cover, al.id, 52));
      const m = document.createElement("div");
      m.innerHTML = `<b>${al.title}</b><span>${al.tracks.length} 首${al.year ? " · " + al.year : ""}</span>`;
      row.appendChild(m);
      row.onclick = () => { drillAlbum = al.id; renderView(); };
      el.appendChild(row);
    });
  } else {                                       // artist list
    CAT.artists.forEach(a => {
      const n = a.albums.reduce((m, al) => m + al.tracks.length, 0);
      const row = document.createElement("div"); row.className = "artistRow";
      row.appendChild(coverEl(a.albums[0].cover, a.id, 52));
      const m = document.createElement("div");
      m.innerHTML = `<b>${a.name}</b><span>${a.albums.length} 張專輯 · ${n} 首</span>`;
      row.appendChild(m);
      row.onclick = () => { drillArtist = a.id; renderView(); };
      el.appendChild(row);
    });
  }
}
const findTrack = id => TRACKS.find(t => t.id === id);
function trackRow(t) {
  const row = document.createElement("div"); row.className = "trackRow";
  row.innerHTML = `<div class="no">${t.no || "♪"}</div>
    <div class="tt"><b>${t.title}</b><span>${t.artist} · ${fmt(t.dur)}${t.lrc ? " · ♪" : ""}</span></div>`;
  const add = Object.assign(document.createElement("button"),
    { className: "addPl", textContent: "＋", title: "加入清單" });
  add.onclick = e => { e.stopPropagation(); pickPlaylist(t.id); };
  row.appendChild(add);
  row.onclick = () => playQueue([t]);
  return row;
}
$("searchIn").addEventListener("input", () => { if (!$("libView").hidden) renderLib($("searchIn").value); });
$("nav").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#nav button").forEach(x => x.classList.toggle("on", x === b));
  if (b.dataset.v === "np") {                                  // 播放中 page
    if (cur) { $("player").hidden = false; render(true); }
    else { ["libView","plView","histView"].forEach(id => $(id).hidden = id !== "libView");
      document.querySelector('#nav [data-v="lib"]').classList.add("on");
      alert("尚未播放任何歌曲"); }
    return;
  }
  renderView();
});

/* ---------- playlists (phone-local) ---------- */
const plGet = () => JSON.parse(localStorage.getItem("ma_pl") || "[]");
const plSet = p => localStorage.setItem("ma_pl", JSON.stringify(p));
function renderPl() {
  const el = $("plView"); el.innerHTML = "";
  const bar = document.createElement("div"); bar.className = "newPl";
  const inp = Object.assign(document.createElement("input"), { placeholder: "新清單名稱…" });
  const btn = Object.assign(document.createElement("button"), { className: "btn", textContent: "建立" });
  btn.onclick = () => { const n = inp.value.trim(); if (!n) return;
    plSet([...plGet(), { id: Date.now().toString(36), name: n, tracks: [] }]); inp.value = ""; renderPl(); };
  bar.append(inp, btn); el.appendChild(bar);
  for (const p of plGet()) {
    const row = document.createElement("div"); row.className = "plRow";
    row.innerHTML = `<b>${p.name}</b><span>${p.tracks.length} 首</span>`;
    row.onclick = () => plDetail(p.id);
    el.appendChild(row);
  }
}
function plDetail(pid) {
  const el = $("plView"); el.innerHTML = "";
  const p = plGet().find(x => x.id === pid);
  const back = Object.assign(document.createElement("span"), { className: "backLink", textContent: "‹ 清單" });
  back.onclick = renderPl; el.appendChild(back);
  const bar = document.createElement("div"); bar.className = "histBar";
  const play = Object.assign(document.createElement("button"), { className: "btn", textContent: "▶ 播放" });
  play.onclick = () => playQueue(p.tracks.map(findTrack).filter(Boolean));
  const del = Object.assign(document.createElement("button"),
    { className: "chip", textContent: "刪除清單" });
  del.onclick = () => { plSet(plGet().filter(x => x.id !== pid)); renderPl(); };
  const exp = Object.assign(document.createElement("button"), { className: "chip", textContent: "匯出" });
  exp.onclick = () => download(`${p.name}.json`, JSON.stringify(p, null, 1), "application/json");
  bar.append(play, exp, del); el.appendChild(bar);
  p.tracks.forEach((id, i) => {
    const t = findTrack(id); if (!t) return;
    const row = trackRow(t);
    row.onclick = () => playQueue(p.tracks.slice(i).map(findTrack).filter(Boolean));
    el.appendChild(row);
  });
}
function pickPlaylist(trackId) {
  const pls = plGet();
  const name = pls.length
    ? prompt("加入清單：\n" + pls.map((p, i) => `${i + 1}. ${p.name}`).join("\n") + "\n或輸入新名稱建立")
    : prompt("新清單名稱：");
  if (name == null) return;
  const n = parseInt(name) - 1;
  const p = pls[n] || null;
  if (p) { p.tracks.push(trackId); plSet(pls); }
  else { const nm = p ? "" : name.trim(); if (nm) plSet([...pls, { id: Date.now().toString(36), name: nm, tracks: [trackId] }]); }
  if (!$("plView").hidden) renderPl();
}

/* ---------- history ---------- */
const histGet = () => JSON.parse(localStorage.getItem("ma_hist") || "[]");
function logPlay(t, secs, done) {
  const h = histGet();
  h.push({ ts: Date.now(), id: t.id, title: t.title, artist: t.artist, album: t.album,
           secs: Math.round(secs), done: done ? 1 : 0 });
  localStorage.setItem("ma_hist", JSON.stringify(h.slice(-5000)));
}
function renderHist() {
  const el = $("histView"); el.innerHTML = "";
  const h = histGet().slice().reverse();
  const bar = document.createElement("div"); bar.className = "histBar";
  const j = Object.assign(document.createElement("button"), { className: "btn", textContent: "匯出 JSON" });
  j.onclick = () => download("history.json", JSON.stringify(histGet(), null, 1), "application/json");
  const c = Object.assign(document.createElement("button"), { className: "btn", textContent: "匯出 CSV" });
  c.onclick = () => download("history.csv",
    "time,title,artist,album,seconds,completed\n" +
    histGet().map(r => `${new Date(r.ts).toISOString()},"${r.title}","${r.artist}","${r.album}",${r.secs},${r.done}`).join("\n"),
    "text/csv");
  bar.append(j, c); el.appendChild(bar);
  const total = histGet().reduce((s, r) => s + r.secs, 0);
  el.appendChild(Object.assign(document.createElement("div"),
    { className: "backLink", textContent: `共 ${h.length} 次播放 · 累計 ${fmt(total)}` }));
  h.slice(0, 200).forEach(r => {
    const row = document.createElement("div"); row.className = "histRow";
    row.innerHTML = `<b>${r.title}</b><small>${r.artist} · ${new Date(r.ts).toLocaleString("zh-Hant")} · ${fmt(r.secs)}${r.done ? " ✓" : ""}</small>`;
    row.onclick = () => { const t = findTrack(r.id); if (t) playQueue([t]); };
    el.appendChild(row);
  });
}
function download(name, data, mime) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: mime }));
  a.download = name; a.click();
}

/* ---------- player engine (native <audio> → iOS background-safe) ---------- */
function fmt(s) { s = Math.max(0, s || 0); return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`; }
let ctx = null;
const getCtx = () => ctx || (ctx = new (window.AudioContext || window.webkitAudioContext)());
async function decode(url) {
  const ab = await (await fetch(url)).arrayBuffer();
  return await new Promise((res, rej) => getCtx().decodeAudioData(ab, res, rej));
}
function toWav(L, R, sr) {
  const n = L.length, buf = new ArrayBuffer(44 + n*4), v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o+i, s.charCodeAt(i)); };
  ws(0,"RIFF"); v.setUint32(4,36+n*4,true); ws(8,"WAVE"); ws(12,"fmt ");
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,2,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*4,true); v.setUint16(32,4,true);
  v.setUint16(34,16,true); ws(36,"data"); v.setUint32(40,n*4,true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    v.setInt16(o, Math.max(-1, Math.min(1, L[i]))*32767, true); o += 2;
    v.setInt16(o, Math.max(-1, Math.min(1, R[i]))*32767, true); o += 2;
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
async function renderKeyed(url, k, onProg) {
  const st = new SoundTouch(); st.pitchSemitones = k;
  const buffer = await decode(url);
  const filter = new SimpleFilter(new WebAudioBufferSource(buffer), st);
  const CH = 16384, chunk = new Float32Array(2*CH);
  const out = new Float32Array(2*(buffer.length + CH)), sr = buffer.sampleRate;
  let w = 0, n, doneP = 0;
  while ((n = filter.extract(chunk, CH)) > 0) {
    out.set(chunk.subarray(0, 2*n), w); w += 2*n; doneP += n;
    if (onProg && (doneP & 65535) < CH) { onProg(doneP/buffer.length);
      await new Promise(r => setTimeout(r)); }
  }
  const frames = w/2, L = new Float32Array(frames), R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { L[i] = out[2*i]; R[i] = out[2*i+1]; }
  return toWav(L, R, sr);
}
function applyAudioState() { audio.loop = loopOn; audio.playbackRate = SPD[spdIdx]; }

async function playQueue(list) {
  queue = list.filter(Boolean);
  if (!queue.length) return;
  $("player").hidden = false;
  await loadTrack(queue[0], true);
}
async function loadTrack(t, autoplay) {
  cur = t; curLine = -1; pendingSeek = 0;
  $("pName").textContent = t.title; $("pArtist").textContent = `${t.artist} · ${t.album}`;
  lyrOff = parseFloat(localStorage.getItem("ma_off_" + t.id)) || 0;
  setOffLbl();
  const url = t.aiUrl ? t.aiUrl
    : (key !== 0 && encKeyCache[`${t.id}|${key}`] ? encKeyCache[`${t.id}|${key}`] : await mediaBlob(t.file));
  audio.src = url; applyAudioState(); applyVol();
  lines = t.lrc ? parseLRC(await (await fetch(await mediaBlob(t.lrc))).text()) : [];
  buildLyrics();
  if (autoplay) audio.play().catch(()=>{});
  mediaSession(t);
  logPlay(t, 0, false);                       // session start row
}
$("playBtn").onclick = () => audio.paused ? audio.play().catch(()=>{}) : audio.pause();
$("backBtn").onclick = () => { $("player").hidden = true; render(true); };

/* key (offline pre-render per track+key, cached in session) */
function setKeyUI() { const l = $("keyLbl");
  l.textContent = key === 0 ? "原調" : (key > 0 ? "+"+key : "−"+Math.abs(key));
  l.classList.toggle("on", key !== 0); }
async function applyKey(k) {
  k = Math.max(-8, Math.min(8, k));
  const token = ++renderToken; key = k; setKeyUI();
  if (!cur) return;
  if (k === 0) { const was = !audio.paused, t = audio.currentTime;
    audio.src = await mediaBlob(cur.file); applyAudioState();
    pendingSeek = t; if (was) audio.play().catch(()=>{}); return; }
  const ck = `${cur.id}|${k}`;
  if (!encKeyCache[ck]) {
    $("keyLbl").textContent = "…";
    try { encKeyCache[ck] = await renderKeyed(await mediaBlob(cur.file), k,
      p => $("keyLbl").textContent = Math.round(p*100) + "%"); }
    catch (e) { key = 0; setKeyUI(); return; }
  }
  if (token !== renderToken) return;
  setKeyUI();
  const was = !audio.paused, t = audio.currentTime;
  audio.src = encKeyCache[ck]; applyAudioState();
  pendingSeek = t; if (was) audio.play().catch(()=>{});
}
$("keyDown").onclick = () => applyKey(key-1);
$("keyUp").onclick   = () => applyKey(key+1);
$("keyLbl").onclick  = () => applyKey(0);

/* speed */
$("spdBar").oninput = e => { spdIdx = +e.target.value;
  audio.playbackRate = SPD[spdIdx];
  const l = $("spdLbl"); l.textContent = SPD[spdIdx]+"×"; l.classList.toggle("hot", SPD[spdIdx] !== 1); };
$("loopBtn").onclick = () => { loopOn = !loopOn; applyAudioState(); $("loopBtn").classList.toggle("on", loopOn); };
$("shufBtn").onclick = () => {
  shuffleOn = !shuffleOn;
  $("shufBtn").classList.toggle("on", shuffleOn);
  try { localStorage.setItem("ma_shuf", shuffleOn ? "1" : ""); } catch (e) {}
};
if (shuffleOn) $("shufBtn").classList.add("on");

$("addPlBtn").onclick = () => cur && pickPlaylist(cur.id);

/* lyrics */
function parseLRC(text) {
  return text.trim().split("\n").map(l => {
    const m = l.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    return m ? { t: +m[1]*60 + +m[2], text: m[3].trim() } : null; }).filter(Boolean);
}
function buildLyrics() {
  $("lyrics").innerHTML = lines.length
    ? lines.map((l,i)=>`<div class="line${l.text?"":" gap"}" data-i="${i}">${l.text||"♪ ♪ ♪"}</div>`).join("")
    : `<div class="line active">（此歌暫無歌詞）</div>`;
  curLine = -1; render(true);
}
function center(i, instant) { const el = $("lyrics").children[i]; if (!el) return;
  $("lyricsWrap").scrollTo({ top: el.offsetTop - $("lyricsWrap").clientHeight/2 + el.clientHeight/2,
    behavior: instant ? "auto" : "smooth" }); }
let lastSaveT = 0;
function render(force) {
  if (cur && playing && audio.currentTime > 3 && Date.now() - lastSaveT > 5000) {
    lastSaveT = Date.now();
    try { localStorage.setItem("ma_last", JSON.stringify({ id: cur.id, t: audio.currentTime })); } catch (e) {}
  }
  if (lines.length) {
    const t = audio.currentTime + 0.15 + lyrOff;
    let i = 0; while (i+1 < lines.length && lines[i+1].t <= t) i++;
    if (i !== curLine || force) { curLine = i;
      [...$("lyrics").children].forEach((el,k) => el.classList.toggle("active", k === i));
      if (Date.now() > userScrollUntil) center(i, force); } }
  if (!seeking) $("bar").value = audio.duration ? audio.currentTime/audio.duration*1000 : 0;
  $("time").textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
}
function tick() { render(); if (playing && !document.hidden) requestAnimationFrame(tick); }
$("bar").oninput = () => seeking = true;
$("bar").onchange = e => { audio.currentTime = e.target.value/1000*(audio.duration||0); seeking = false; };
$("lyrics").onclick = e => { const el = e.target.closest(".line");
  if (el && lines[+el.dataset.i]) { audio.currentTime = lines[+el.dataset.i].t - lyrOff; audio.play().catch(()=>{}); } };

/* lyric sync fine-tune */
function setOffLbl() { $("lyrOffLbl").textContent = (lyrOff >= 0 ? "+" : "") + lyrOff.toFixed(2) + "s"; }
function adjOff(d) { lyrOff = Math.round((lyrOff+d)*100)/100;
  if (cur) localStorage.setItem("ma_off_" + cur.id, lyrOff);
  setOffLbl(); render(true); }
$("syncBtn").onclick = () => $("syncRow").hidden = !$("syncRow").hidden;
$("lyrMinus").onclick = () => adjOff(-0.25);
$("lyrPlus").onclick  = () => adjOff(0.25);
$("lyrReset").onclick = () => adjOff(-lyrOff);

/* media session (lock screen) */
function mediaSession(t) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album,
      artwork: t.cover && coverCache[t.cover] ? [{ src: coverCache[t.cover], sizes: "600x600" }] : [] });
    navigator.mediaSession.setActionHandler("play",  () => audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("seekbackward", () => audio.currentTime -= 10);
    navigator.mediaSession.setActionHandler("seekforward", () => audio.currentTime += 10);
  } catch (e) {}
}

/* ═══ Unified FX engine: 🎤 伴奏 (L−R vocal cancel) + 📏 穩定 (real-time AGC) ═══
   One shared WebAudio graph (an element allows only one MediaElementSource):
     src → dry ──────────────┐
     src → karaDSP → karaWet ┼→ stabGain → limiter → destination
     src → analyser (AGC tap) ┘
   iOS background safety: page-hide tears the graph down and hot-swaps a fresh
   un-routed <audio> element (vocals+volume return, playback continues).        */
let karaOn = false, stabOn = false;
let fxCtx = null, fxSrc = null, fxEl = null, fxN = null, stabTimer = null, stabLvl = 1;
const LOUD_ANCHOR = 0.115;
try { karaOn = localStorage.getItem("ma_kara") === "1";
  stabOn = localStorage.getItem("ma_stab") === "1"; } catch (e) {}

function buildFx() {
  fxCtx = new (window.AudioContext || window.webkitAudioContext)();
  fxSrc = fxCtx.createMediaElementSource(audio);
  fxEl = audio;
  const dry = fxCtx.createGain();
  const karaWet = fxCtx.createGain();
  const stabGain = fxCtx.createGain();
  const limiter = fxCtx.createDynamicsCompressor();
  limiter.threshold.value = -1; limiter.ratio.value = 20; limiter.knee.value = 0;
  const analyser = fxCtx.createAnalyser();
  analyser.fftSize = 2048;
  // karaoke DSP chain (built once, muted when off)
  const split = fxCtx.createChannelSplitter(2);
  const merge = fxCtx.createChannelMerger(2);
  const g = v => { const n = fxCtx.createGain(); n.gain.value = v; return n; };
  split.connect(g(1), 0).connect(merge, 0, 0);
  split.connect(g(-1), 1).connect(merge, 0, 0);
  split.connect(g(-1), 0).connect(merge, 0, 1);
  split.connect(g(1), 1).connect(merge, 0, 1);
  const lp = fxCtx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 140;
  split.connect(lp, 0); split.connect(lp, 1);
  lp.connect(merge, 0, 0); lp.connect(merge, 0, 1);
  merge.connect(karaWet);
  fxSrc.connect(split);
  fxSrc.connect(dry);
  dry.connect(stabGain); karaWet.connect(stabGain);
  stabGain.connect(limiter); limiter.connect(fxCtx.destination);
  fxSrc.connect(analyser);
  fxN = { dry, karaWet, stabGain, analyser };
}
function ensureFx() {
  if (fxN && fxEl !== audio) {                      // element was swapped → rebuild
    try { fxCtx.close(); } catch (e) {}
    fxCtx = null; fxN = null;
  }
  if (!fxN) buildFx();
  if (fxCtx.state === "suspended") fxCtx.resume();
}
function applyFx() {
  if (fxN) {
    fxN.dry.gain.value = karaOn ? 0 : 1;
    fxN.karaWet.gain.value = karaOn ? 1 : 0;
    if (!stabOn) { fxN.stabGain.gain.setTargetAtTime(1, fxCtx.currentTime, 0.05); stabLvl = 1; }
  }
  if (stabOn) {
    ensureFx();
    if (stabTimer) clearInterval(stabTimer);
    stabTimer = setInterval(agcTick, 200);
  } else if (stabTimer) { clearInterval(stabTimer); stabTimer = null; }
}
function agcTick() {
  if (!fxN || !stabOn) return;
  const d = new Float32Array(fxN.analyser.fftSize);
  fxN.analyser.getFloatTimeDomainData(d);
  let s = 0;
  for (let i = 0; i < d.length; i++) s += d[i] * d[i];
  const rms = Math.sqrt(s / d.length) || 1e-6;
  const want = Math.max(0.25, Math.min(4, LOUD_ANCHOR / rms));
  stabLvl += (want - stabLvl) * 0.15;               // gentle ride, no pumping
  fxN.stabGain.gain.setTargetAtTime(stabLvl, fxCtx.currentTime, 0.2);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (karaOn || stabOn)) swapToDryAudio();
});
function swapToDryAudio() {
  const t = audio.currentTime, was = !audio.paused, src = audio.src;
  if (stabTimer) { clearInterval(stabTimer); stabTimer = null; }
  try { fxCtx && fxCtx.close(); } catch (e) {}
  fxCtx = null; fxN = null; karaOn = false; stabOn = false; stabLvl = 1;
  $("karaBtn").classList.remove("on"); $("stabBtn").classList.remove("on");
  try { localStorage.removeItem("ma_kara"); localStorage.removeItem("ma_stab"); } catch (e) {}
  audio.pause();
  audio = makeAudio();
  audio.src = src; audio.loop = loopOn; audio.playbackRate = SPD[spdIdx]; applyVol();
  pendingSeek = t;
  if (was) audio.play().catch(()=>{});
}
$("karaBtn").hidden = false;
if (isDesktopAI) { $("aiBtn2").hidden = false; $("aiNav").hidden = false; }
$("karaBtn").onclick = () => {
  karaOn = !karaOn;
  $("karaBtn").classList.toggle("on", karaOn);
  try { localStorage.setItem("ma_kara", karaOn ? "1" : ""); } catch (e) {}
  ensureFx(); applyFx();
};
$("stabBtn").onclick = () => {
  stabOn = !stabOn;
  $("stabBtn").classList.toggle("on", stabOn);
  try { localStorage.setItem("ma_stab", stabOn ? "1" : ""); } catch (e) {}
  ensureFx(); applyFx();
};
if (karaOn) $("karaBtn").classList.add("on");
if (stabOn) $("stabBtn").classList.add("on");

/* 🔊 manual volume (audio.volume; iOS ignores — hardware keys there) */
let userVol = 1;
try { userVol = +localStorage.getItem("ma_vol") || 1; } catch (e) {}
function applyVol() {
  if (!audio) return;
  audio.volume = Math.max(0, Math.min(1, userVol));
}
$("volBar").value = Math.round(userVol * 100);
$("volLbl").textContent = Math.round(userVol * 100);
$("volBar").addEventListener("input", e => {
  userVol = +e.target.value / 100;
  $("volLbl").textContent = e.target.value;
  try { localStorage.setItem("ma_vol", userVol); } catch (err) {}
  applyVol();
});

/* next / prev track (queue order → library order; shuffle-aware) */
function pickNext() {
  if (!cur) return null;
  if (shuffleOn) {
    const pool = (queue.length > 1 ? queue : TRACKS).filter(q => q.id !== cur.id);
    return pool[Math.floor(Math.random() * pool.length)];
  }
  const li = TRACKS.findIndex(x => x.id === cur.id);          // whole-library order, always
  return TRACKS[(li + 1) % TRACKS.length];
}
function pickPrev() {
  if (!cur) return null;
  if (shuffleOn) {
    const pool = (queue.length > 1 ? queue : TRACKS).filter(q => q.id !== cur.id);
    return pool[Math.floor(Math.random() * pool.length)];
  }
  const li = TRACKS.findIndex(x => x.id === cur.id);
  return TRACKS[(li - 1 + TRACKS.length) % TRACKS.length];
}
function nextTrack() {
  const n = pickNext();
  if (n) { loadTrack(n, true); return true; }
  return false;
}
$("nextBtn").onclick = () => nextTrack();
$("prevBtn").onclick = () => {
  if (!cur) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }   // standard: tap ⏮ early = restart
  const p = pickPrev();
  if (p) loadTrack(p, true);
};

/* ═══ 🤖 AI伴奏 — background processing + dedicated results page ═══
   Desktop only. Click 🤖 on any song → it queues and processes while you keep
   using the app. Results (IndexedDB-persisted) list on the AI伴奏 tab with
   play / download / delete.                                              */
const isDesktopAI = matchMedia("(pointer: fine)").matches;
if (isDesktopAI) { $("aiNav").hidden = false; }
let aiProc = null, aiQueue = [], aiBusy = false, aiWake = null;
const aiResults = {};                                  // trackId → {t, url, blob, took}

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("musicapp-ai", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("inst");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbOp(op, key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("inst", op === "get" ? "readonly" : "readwrite").objectStore("inst")[op](val !== undefined ? val : key, key !== undefined && op !== "get" ? key : undefined);
    tx.onsuccess = () => res(tx.result); tx.onerror = () => rej(tx.error);
  });
}

$("aiBtn2").onclick = () => enqueueAI(cur);            // (button created in player row below)
function enqueueAI(t) {
  if (!t || !isDesktopAI) return;
  if (aiResults[t.id]) { toastAI(); return; }
  if (aiQueue.find(q => q.id === t.id)) { toastAI(); return; }
  aiQueue.push({ ...t, progress: 0, status: "等待中" });
  toastAI(true);
  renderAiView();
  aiRunner();
}
function toastAI(fresh) {
  const b = $("aiBtn2");
  b.textContent = fresh ? "🤖 已排隊" : "🤖 已有";
  setTimeout(() => b.textContent = "🤖 伴奏", 1500);
}

async function ensureModel() {
  if (!window.ort) await new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.all.min.js";
    sc.onload = res; sc.onerror = () => rej(new Error("ORT CDN fail")); document.head.appendChild(sc);
  });
  ort.env.wasm.numThreads = 1;
  const { DemucsProcessor, CONSTANTS } = await import("./dwsrc/index.js");
  if (aiProc) return { DemucsProcessor, CONSTANTS };
  const cache = await caches.open("demucs-model");
  let modelURL;
  const hit = await cache.match("/htdemucs");
  if (hit) modelURL = URL.createObjectURL(await hit.blob());
  else {
    const urls = [CONSTANTS.DEFAULT_MODEL_URL,
                  CONSTANTS.DEFAULT_MODEL_URL.replace("huggingface.co", "hf-mirror.com")];
    let blob = null;
    for (const u of urls) {
      try {
        const r = await fetch(u);
        if (!r.ok) continue;
        const total = +(r.headers.get("content-length") || 172000000);
        const reader = r.body.getReader();
        const chunks = []; let got = 0;
        for (;;) { const { done, value } = await reader.read();
          if (done) break; chunks.push(value); got += value.length;
          aiQueue[0].status = `模型 ${(got / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)}MB`; renderAiView(); }
        blob = new Blob(chunks); break;
      } catch (e) {}
    }
    if (!blob) throw new Error("模型下載失敗");
    try { await cache.put("/htdemucs", new Response(blob)); } catch (e) {}
    modelURL = URL.createObjectURL(blob);
  }
  aiProc = new DemucsProcessor({ ort,
    onProgress: p => {
      const q = aiQueue[0]; if (!q) return;
      if (typeof p === "number") q.status = "模型 " + Math.round(p * 100) + "%";
      else q.status = `處理 ${p.currentSegment}/${p.totalSegments}`;
      renderAiView();
    }, onLog: () => {} });
  await aiProc.loadModel(modelURL);
  return { DemucsProcessor, CONSTANTS };
}

async function aiRunner() {
  if (aiBusy || !aiQueue.length) return;
  aiBusy = true;
  try { aiWake = await navigator.wakeLock?.request("screen"); } catch (e) {}
  while (aiQueue.length) {
    const q = aiQueue[0];
    try {
      q.status = "準備…"; renderAiView();
      await ensureModel();
      const srcUrl = key !== 0 && encKeyCache[`${q.id}|${key}`] ? encKeyCache[`${q.id}|${key}`] : await mediaBlob(q.file);
      const buf = await decode(srcUrl);
      const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
      q.status = "處理中…"; renderAiView();
      const t0 = performance.now();
      const res = await aiProc.separate(L, R);
      const n = res.drums.left.length;
      const oL = new Float32Array(n), oR = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        oL[i] = res.drums.left[i] + res.bass.left[i] + res.other.left[i];
        oR[i] = res.drums.right[i] + res.bass.right[i] + res.other.right[i];
      }
      const blob = new Blob([wavBytes(oL, oR, buf.sampleRate)], { type: "audio/wav" });
      const took = ((performance.now() - t0) / 60000).toFixed(1);
      aiResults[q.id] = { t: q, blob, url: URL.createObjectURL(blob), took };
      try { await idbOp("put", q.id, { t: q, blob, took }); } catch (e) {}
    } catch (e) {
      q.status = "✗ " + String(e.message || e).slice(0, 24);
      renderAiView();
      await new Promise(z => setTimeout(z, 800));
    }
    aiQueue.shift();
    renderAiView();
  }
  try { aiWake && aiWake.release(); } catch (e) {}
  aiBusy = false;
}

function wavBytes(L, R, sr) {                            // reuse toWav logic, returns Uint8Array
  const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + n * 4, true); ws(8, "WAVE"); ws(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true);
  v.setUint16(34, 16, true); ws(36, "data"); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    v.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true); o += 2;
    v.setInt16(o, Math.max(-1, Math.min(1, R[i])) * 32767, true); o += 2;
  }
  return new Uint8Array(buf);
}

function renderAiView() {
  const el = $("aiView"); if (!el) return;
  let html = "";
  for (const q of aiQueue)
    html += `<div class="histRow">⏳ <b>${q.title}</b> <small>${q.artist} · ${q.status}</small></div>`;
  const done = Object.values(aiResults).reverse();
  for (const r of done)
    html += `<div class="histRow" data-ai="${r.t.id}"><b>${r.t.title} (AI伴奏)</b>
      <small>${r.t.artist} · ${r.took}分 · <a href="#" class="aiPlay">▶ 播放</a> ·
      <a href="#" class="aiDl">⤓ 下載</a> · <a href="#" class="aiDel">✕</a></small></div>`;
  el.innerHTML = html || "<div class='backLink'>尚無 AI 伴奏 — 在播放器按 🤖 伴奏 排隊處理（背景執行）</div>";
  el.querySelectorAll(".aiPlay").forEach(a => a.onclick = e => { e.preventDefault(); playAIResult(a.closest("[data-ai]").dataset.ai); });
  el.querySelectorAll(".aiDl").forEach(a => a.onclick = e => {
    e.preventDefault();
    const r = aiResults[a.closest("[data-ai]").dataset.ai]; if (!r) return;
    const dl = document.createElement("a"); dl.href = r.url;
    dl.download = r.t.title.replace(/[\\/:*?"<>|]/g, "_") + " (AI伴奏).wav"; dl.click();
  });
  el.querySelectorAll(".aiDel").forEach(a => a.onclick = async e => {
    e.preventDefault();
    const id = a.closest("[data-ai]").dataset.ai;
    delete aiResults[id];
    try { await idbOp("delete", id); } catch (err) {}
    renderAiView();
  });
}
async function loadAiResults() {                        // restore persisted results on boot
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const rq = db.transaction("inst", "readonly").objectStore("inst").openCursor();
      rq.onsuccess = () => { const c = rq.result;
        if (c) { aiResults[c.value.t.id] = { t: c.value.t, blob: c.value.blob,
          url: URL.createObjectURL(c.value.blob), took: c.value.took }; c.continue(); }
        else res(); };
      rq.onerror = () => rej(rq.error);
    });
  } catch (e) {}
  renderAiView();
}
function playAIResult(id) {
  const r = aiResults[id]; if (!r) return;
  const pseudo = { ...r.t, id: "ai:" + r.t.id, title: r.t.title + " (AI伴奏)", aiUrl: r.url };
  $("player").hidden = false;
  loadTrack(pseudo, true);
}

/* fullscreen */
if (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen) {
  const b = $("fsBtn2"); b.hidden = false;
  b.onclick = () => { const d = document.documentElement, doc = document;
    if (doc.fullscreenElement || doc.webkitFullscreenElement)
      (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
    else (d.requestFullscreen || d.webkitRequestFullscreen).call(d); };
}
["touchstart","pointerdown","wheel"].forEach(ev =>
  $("lyricsWrap").addEventListener(ev, () => userScrollUntil = Date.now()+2500, { passive: true }));
["resize","orientationchange"].forEach(ev =>
  window.addEventListener(ev, () => setTimeout(() => render(true), 300)));
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(true); });

/* boot: try stored key first */
autoUnlock();
