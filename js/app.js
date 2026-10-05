// ============ THE QUOTEBOOK ============
// Static single-page app: GitHub Pages for hosting, Firebase Auth + Firestore for logins and data.
// Permissions are enforced for real in firestore.rules — the checks in here only decide which buttons to show.

import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_VERSION = "10.12.2";
const ROLES = ["owner", "admin", "contributor", "enjoyer"];
const ROLE_INFO = {
  owner: "Everything. Can lock quotes so nobody else can delete them.",
  admin: "Add quotes, manage contributors' quotes, lock quotes. Can't touch owners' or admins' work.",
  contributor: "Add quotes. Can edit/delete only their own.",
  enjoyer: "Read only. Can send requests for new quotes."
};

const configured = !String(firebaseConfig.apiKey || "").includes("PASTE_ME");

// ---------- state ----------

const state = {
  authReady: false,
  user: null,
  profile: null,
  quotes: [],
  quotesReady: false,
  users: [],
  requests: []
};
const ui = { lists: {}, spotlight: null, authMode: "signin", seed: Math.random() };
let fb = null;          // firebase modules + instances
let pendingName = null; // display name typed on the sign-up form
let unsubs = [];

const $app = document.getElementById("app");
const $nav = document.getElementById("nav");
const $who = document.getElementById("who");
const $modal = document.getElementById("modal-root");
const $toasts = document.getElementById("toast-root");

// ---------- helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = encodeURIComponent;
const keyOf = (name) => String(name).trim().toLowerCase();
const millis = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : typeof ts === "number" ? ts : 0);
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
const fmtSaidOn = (s) => (s ? new Date(s + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

function splitList(str, lower = false) {
  const seen = new Set();
  const out = [];
  for (let part of String(str || "").split(",")) {
    part = part.trim().replace(/\s+/g, " ");
    if (lower) part = part.toLowerCase();
    if (!part || part.length > 60 || seen.has(part.toLowerCase())) continue;
    seen.add(part.toLowerCase());
    out.push(part);
  }
  return out;
}

function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  $toasts.appendChild(el);
  setTimeout(() => el.remove(), isErr ? 6000 : 3000);
}

function fail(e) {
  console.error(e);
  const denied = e && (e.code === "permission-denied" || String(e.message).includes("permission"));
  toast(denied ? "NOPE — you don't have permission to do that." : (e.message || String(e)), true);
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------- roles & permissions (UI only; rules are the real gate) ----------

const myRole = () => state.profile?.role || "none";
const isOwner = () => myRole() === "owner";
const isStaff = () => ["owner", "admin"].includes(myRole());
const canAdd = () => ["owner", "admin", "contributor"].includes(myRole());
const roleOf = (uid) => state.users.find((u) => u.id === uid)?.role;
const isJunior = (uid) => { const r = roleOf(uid); return !r || r === "contributor" || r === "enjoyer"; };

function canModify(q) {
  if (isOwner()) return true;
  if (q.locked) return false;
  if (canAdd() && q.addedBy === state.user?.uid) return true;
  return myRole() === "admin" && isJunior(q.addedBy);
}

function canToggleLock(q) {
  if (isOwner()) return true;
  if (myRole() !== "admin") return false;
  return !(q.locked && roleOf(q.lockedBy) === "owner");
}

// ---------- derived data ----------

function peopleIndex() {
  const map = new Map();
  for (const q of state.quotes) {
    for (const name of q.people || []) {
      const k = keyOf(name);
      if (!map.has(k)) map.set(k, { key: k, name, count: 0, names: {} });
      const p = map.get(k);
      p.count++;
      p.names[name] = (p.names[name] || 0) + 1;
    }
  }
  for (const p of map.values()) p.name = Object.entries(p.names).sort((a, b) => b[1] - a[1])[0][0];
  return [...map.values()];
}

function addersIndex() {
  const map = new Map();
  for (const q of state.quotes) {
    if (!map.has(q.addedBy)) map.set(q.addedBy, { key: q.addedBy, name: q.addedByName || "Unknown", count: 0, last: 0 });
    const a = map.get(q.addedBy);
    a.count++;
    if (millis(q.createdAt) >= a.last) { a.last = millis(q.createdAt); a.name = q.addedByName || a.name; }
  }
  return [...map.values()];
}

function categoriesIndex() {
  const map = new Map();
  for (const q of state.quotes) {
    for (const c of q.categories || []) {
      if (!map.has(c)) map.set(c, { key: c, name: c, count: 0 });
      map.get(c).count++;
    }
  }
  return [...map.values()];
}

function matches(q, needle) {
  if (!needle) return true;
  const hay = [q.text, q.context, q.addedByName, q.requestedByName, ...(q.people || []), ...(q.categories || [])].join(" \u0001 ").toLowerCase();
  return needle.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function sortQuotes(list, sort) {
  const arr = [...list];
  if (sort === "old") arr.sort((a, b) => millis(a.createdAt) - millis(b.createdAt));
  else if (sort === "person") arr.sort((a, b) => keyOf(a.people?.[0] || "").localeCompare(keyOf(b.people?.[0] || "")));
  else if (sort === "random") arr.sort((a, b) => hashString(a.id + ui.seed) - hashString(b.id + ui.seed));
  else arr.sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
  return arr;
}

// ---------- firebase ----------

async function initFirebase() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`)
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  let db;
  try {
    // Local cache = fewer reads (stays inside the free tier) and the site still shows quotes offline.
    // Long-polling auto-detect helps on school / work networks that block streaming connections.
    db = fsMod.initializeFirestore(app, {
      localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }),
      experimentalAutoDetectLongPolling: true
    });
  } catch {
    db = fsMod.getFirestore(app);
  }
  const auth = authMod.getAuth(app);
  fb = { ...authMod, ...fsMod, app, db, auth };

  fb.onAuthStateChanged(auth, async (user) => {
    stopListeners();
    state.user = user;
    state.profile = null;
    state.profileMissing = false;
    state.quotes = [];
    state.quotesReady = false;
    state.users = [];
    state.requests = [];
    state.loadError = null;
    state.dataError = null;
    if (!user) {
      state.authReady = true;
      render();
      return;
    }
    try {
      await withTimeout(ensureProfile(user), 20000);
    } catch (e) {
      console.error(e);
      state.loadError = describeError(e);
      state.authReady = true;
      render();
      return;
    }
    let lastRole = null;
    unsubs.push(fb.onSnapshot(fb.doc(db, "users", user.uid), (snap) => {
      state.profile = snap.exists() ? snap.data() : null;
      state.profileMissing = !snap.exists();
      state.authReady = true;
      if (state.profile?.role !== lastRole) {
        lastRole = state.profile?.role;
        startDataListeners();
        render();
      } else {
        render("data");
      }
    }, (e) => {
      console.error(e);
      state.loadError = describeError(e);
      state.authReady = true;
      render();
    }));
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "timeout" })), ms))
  ]);
}

// Turn Firebase errors into something a person can act on.
function describeError(e) {
  const code = String(e?.code || "");
  const msg = String(e?.message || e || "");
  if (code === "permission-denied" || msg.includes("permission")) {
    return "The database refused (permission denied). An owner needs to publish the latest security rules: run <code>npx firebase-tools deploy</code>.";
  }
  if (["unavailable", "timeout", "deadline-exceeded"].includes(code) || /offline|timed out|network/i.test(msg)) {
    return "Can't reach the database. If you're on <b>school Wi-Fi or a school Chromebook</b>, it's probably blocking it. Try phone data or home Wi-Fi.";
  }
  return `Something went wrong: ${esc(code || msg)}`;
}

async function ensureProfile(user) {
  const ref = fb.doc(fb.db, "users", user.uid);
  const snap = await fb.getDoc(ref);
  if (snap.exists()) return;
  const displayName = (pendingName || user.displayName || (user.email || "anon").split("@")[0]).slice(0, 40);
  await fb.setDoc(ref, { displayName, email: user.email || "", role: "enjoyer", createdAt: fb.serverTimestamp() });
}

let dataUnsubs = [];
function startDataListeners() {
  dataUnsubs.forEach((u) => u());
  dataUnsubs = [];
  if (!state.profile) return;
  const { db } = fb;
  const opts = { serverTimestamps: "estimate" };

  dataUnsubs.push(fb.onSnapshot(fb.collection(db, "quotes"), (snap) => {
    state.quotes = snap.docs.map((d) => ({ id: d.id, ...d.data(opts) }));
    state.quotesReady = true;
    state.dataError = null;
    render("data");
  }, (e) => {
    console.error(e);
    state.dataError = describeError(e);
    state.quotesReady = true;
    render();
  }));

  if (isStaff()) {
    dataUnsubs.push(fb.onSnapshot(fb.collection(db, "users"), (snap) => {
      state.users = snap.docs.map((d) => ({ id: d.id, ...d.data(opts) }));
      render("data");
    }, fail));
    dataUnsubs.push(fb.onSnapshot(fb.collection(db, "requests"), (snap) => {
      state.requests = snap.docs.map((d) => ({ id: d.id, ...d.data(opts) }));
      render("data");
    }, fail));
  } else {
    state.users = [];
    const q = fb.query(fb.collection(db, "requests"), fb.where("requestedBy", "==", state.user.uid));
    dataUnsubs.push(fb.onSnapshot(q, (snap) => {
      state.requests = snap.docs.map((d) => ({ id: d.id, ...d.data(opts) }));
      render("data");
    }, fail));
  }
}

function stopListeners() {
  [...unsubs, ...dataUnsubs].forEach((u) => u());
  unsubs = [];
  dataUnsubs = [];
}

// ---------- routing ----------

function parseHash() {
  const raw = location.hash.slice(1) || "/";
  const [path, qs] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  return { path, parts, query: new URLSearchParams(qs || "") };
}

const VIEWS = {
  "": homeView,
  all: allView,
  people: peopleView,
  person: personView,
  adders: addersView,
  adder: adderView,
  categories: categoriesView,
  category: categoryView,
  add: addView,
  requests: requestsView,
  control: controlView
};
// Pages with forms on them don't re-render when data changes (so you don't lose what you're typing).
const STATIC_VIEWS = new Set(["add"]);

let lastPath = null;
function render(reason) {
  renderChrome();
  const { path, parts, query } = parseHash();
  const name = parts[0] || "";

  if (reason === "data" && path === lastPath && STATIC_VIEWS.has(name)) return;

  let html;
  if (!configured) html = setupView();
  else if (!state.authReady) html = loadingView();
  else if (!state.user) html = loginView();
  else if (state.loadError) html = errorView(state.loadError);
  else if (!state.profile) html = state.profileMissing
    ? errorView(`Signed in, but your member profile couldn't be created. An owner may need to publish the security rules (<code>npx firebase-tools deploy</code>).`)
    : loadingView();
  else html = (state.dataError ? `<div class="panel" role="alert"><h3>Can't load quotes</h3><p>${state.dataError}</p><button class="btn small" data-action="reload">Retry</button></div>` : "")
    + (VIEWS[name] || notFoundView)(parts.slice(1), query);

  // if a full-page loading screen hangs around, offer help instead of spinning forever
  const stuck = configured && html.startsWith('<div class="loading">');
  if (stuck && !slowTimer && !ui.slow) slowTimer = setTimeout(() => { ui.slow = true; slowTimer = null; render(); }, 12000);
  if (!stuck) { clearTimeout(slowTimer); slowTimer = null; ui.slow = false; }
  if (stuck && ui.slow) html = slowView();

  // keep focus + cursor in search boxes across re-renders
  const active = document.activeElement;
  const activeId = active && $app.contains(active) ? active.id : null;
  const caret = activeId && "selectionStart" in active ? active.selectionStart : null;

  $app.innerHTML = html;
  if (path !== lastPath) window.scrollTo(0, 0);
  lastPath = path;

  if (activeId) {
    const el = document.getElementById(activeId);
    if (el) {
      el.focus();
      if (caret != null) try { el.setSelectionRange(caret, caret); } catch { /* not a text input */ }
    }
  }
}

function renderChrome() {
  const { parts } = parseHash();
  const here = parts[0] || "";
  document.getElementById("footer-count").textContent = state.quotesReady ? `${state.quotes.length} QUOTES AND COUNTING` : "";

  if (!state.user || !state.profile) {
    $nav.innerHTML = "";
    $who.innerHTML = "";
    $menuBtn.hidden = true;
    setMenu(false);
    return;
  }
  $menuBtn.hidden = false;
  const pending = state.requests.filter((r) => r.status === "pending").length;
  const links = [
    ["", "Home"],
    ["all", "The Book"],
    ["people", "People"],
    ["adders", "Added By"],
    ["categories", "Categories"],
    ["add", canAdd() ? "+ Add" : "+ Request"]
  ];
  if (isStaff()) links.push(["requests", `Requests${pending ? ` (${pending})` : ""}`]);
  else if (!canAdd()) links.push(["requests", "My Requests"]);
  if (isStaff()) links.push(["control", "Control Room"]);

  const activeFor = { person: "people", adder: "adders", category: "categories" };
  $nav.innerHTML = links
    .map(([k, label]) => `<a href="#/${k}" class="${(activeFor[here] || here) === k ? "active" : ""}">${esc(label)}</a>`)
    .join("");

  const whoHtml = `
    <button class="linkish" data-action="rename" title="Change your display name">${esc(state.profile.displayName)}</button>
    <span class="role-badge ${esc(myRole())}">${esc(myRole())}</span>
    <button class="btn small" data-action="signout">Sign out</button>`;
  $who.innerHTML = whoHtml;
  // on phones the name / sign out live at the bottom of the slide-down menu
  $nav.insertAdjacentHTML("beforeend", `<div class="nav-who">${whoHtml}</div>`);
}

// ---------- phone menu ----------

const $menuBtn = document.getElementById("menu-btn");
function setMenu(open) {
  document.body.classList.toggle("nav-open", open);
  $menuBtn.setAttribute("aria-expanded", String(open));
  $menuBtn.querySelector(".menu-label").textContent = open ? "CLOSE" : "MENU";
}
$menuBtn.addEventListener("click", () => setMenu(!document.body.classList.contains("nav-open")));
$nav.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });

window.addEventListener("hashchange", () => { setMenu(false); render(); });

// ---------- shared view pieces ----------

let slowTimer = null;

function errorView(msg) {
  return `
    <div class="empty" role="alert">
      <strong>CAN'T LOAD</strong>
      <p style="max-width:520px;margin:0 auto 18px;line-height:1.6">${msg}</p>
      <div class="row" style="justify-content:center">
        <button class="btn solid" data-action="reload">Try again</button>
        ${state.user ? `<button class="btn" data-action="signout">Sign out</button>` : ""}
      </div>
    </div>`;
}

function slowView() {
  return `
    <div class="loading">LOADING<span class="blink">_</span></div>
    ${errorView(`This is taking way too long. Usually that means the network is blocking the database. <b>School Wi-Fi and school Chromebooks</b> are the usual suspects: try phone data or home Wi-Fi.`)
      .replace("CAN'T LOAD", "STILL LOADING…")}`;
}

function loadingView() {
  return `<div class="loading">LOADING<span class="blink">_</span></div>`;
}

function notFoundView() {
  return `<div class="empty"><strong>404</strong>Nothing here. <a href="#/">Go home</a>.</div>`;
}

function emptyBox(title, msg) {
  return `<div class="empty"><strong>${esc(title)}</strong>${msg}</div>`;
}

// "No. 017" — quotes are numbered in the order they were added.
let numberCache = { quotes: null, map: new Map() };
function quoteNo(q) {
  if (numberCache.quotes !== state.quotes) {
    const ordered = [...state.quotes].sort((a, b) => millis(a.createdAt) - millis(b.createdAt) || a.id.localeCompare(b.id));
    numberCache = { quotes: state.quotes, map: new Map(ordered.map((x, i) => [x.id, i + 1])) };
  }
  return String(numberCache.map.get(q.id) || 0).padStart(3, "0");
}

function pageHead(kicker, title, sub) {
  return `
    <div class="kicker">${kicker}</div>
    <h1 class="page-title">${esc(title)}</h1>
    ${sub ? `<p class="page-sub">${sub}</p>` : ""}`;
}

function quoteCard(q) {
  const people = (q.people || []).map((p) => `<a href="#/person/${enc(keyOf(p))}">${esc(p)}</a>`).join(" &amp; ");
  const cats = (q.categories || []).map((c) => `<a class="chip" href="#/category/${enc(c)}">${esc(c)}</a>`).join("");
  const bits = [`added by <a href="#/adder/${enc(q.addedBy)}">${esc(q.addedByName || "someone")}</a>`];
  if (q.requestedByName) bits.push(`requested by ${esc(q.requestedByName)}`);
  const when = q.saidOn ? `said ${fmtSaidOn(q.saidOn)}` : q.createdAt ? fmtDate(millis(q.createdAt)) : "";

  const actions = [];
  if (canModify(q)) {
    actions.push(`<button class="btn small" data-action="edit" data-id="${esc(q.id)}">Edit</button>`);
    actions.push(`<button class="btn small" data-action="delete" data-id="${esc(q.id)}">Delete</button>`);
  }
  if (canToggleLock(q)) {
    actions.push(`<button class="btn small" data-action="lock" data-id="${esc(q.id)}">${q.locked ? "Unlock" : "Lock"}</button>`);
  }

  return `
    <article class="quote ${q.locked ? "locked" : ""}">
      ${q.locked ? `<span class="lock-flag" title="Locked by ${esc(q.lockedByName || "staff")}">LOCKED</span>` : ""}
      <div class="qhead"><span class="no">No. ${quoteNo(q)}</span><span>${esc(when)}</span></div>
      <div class="text">${esc(q.text)}</div>
      <div class="people">— ${people}</div>
      ${q.context ? `<div class="context">${esc(q.context)}</div>` : ""}
      ${cats ? `<div class="chips">${cats}</div>` : ""}
      <div class="meta">
        <span>${bits.join(" · ")}</span>
        ${actions.length ? `<span class="actions">${actions.join("")}</span>` : ""}
      </div>
    </article>`;
}

// A searchable, sortable list of quotes. `listKey` keeps each page's search box separate.
function quoteList(listKey, quotes, emptyMsg = "No quotes yet.") {
  const st = (ui.lists[listKey] ||= { q: "", sort: "new" });
  const shown = sortQuotes(quotes.filter((q) => matches(q, st.q)), st.sort);
  const id = "search-" + hashString(listKey);
  return `
    <div class="toolbar">
      <input id="${id}" type="search" placeholder="Search words, people, categories…" value="${esc(st.q)}"
        data-bind="search" data-list="${esc(listKey)}" autocomplete="off">
      <select data-bind="sort" data-list="${esc(listKey)}" aria-label="Sort">
        ${[["new", "Newest"], ["old", "Oldest"], ["person", "By person A–Z"], ["random", "Shuffle"]]
          .map(([v, l]) => `<option value="${v}" ${st.sort === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      ${st.sort === "random" ? `<button class="btn small" data-action="reshuffle">Reshuffle</button>` : ""}
      <span class="count">${shown.length} / ${quotes.length}</span>
    </div>
    ${!state.quotesReady ? loadingView()
      : shown.length ? `<div class="quotes">${shown.map(quoteCard).join("")}</div>`
      : emptyBox(quotes.length ? "NO MATCHES" : "EMPTY", quotes.length ? "Try a different search." : emptyMsg)}`;
}

function indexList(items, hrefFor, listKey, noun) {
  const st = (ui.lists[listKey] ||= { q: "", sort: "az" });
  const needle = st.q.toLowerCase();
  let shown = items.filter((i) => i.name.toLowerCase().includes(needle));
  if (st.sort === "count") shown.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  else shown.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  let body = "";
  if (!state.quotesReady) body = loadingView();
  else if (!shown.length) body = emptyBox(items.length ? "NO MATCHES" : "EMPTY", items.length ? "Try a different search." : `No ${noun} yet.`);
  else if (st.sort === "az") {
    const groups = {};
    for (const i of shown) {
      const ch = i.name[0]?.toUpperCase() || "#";
      (groups[/[A-Z]/.test(ch) ? ch : "#"] ||= []).push(i);
    }
    body = Object.entries(groups).map(([letter, list]) => `
      <div class="letter-head">${esc(letter)}</div>
      <div class="index-list">${list.map((i) => indexItem(i, hrefFor)).join("")}</div>`).join("");
  } else {
    body = `<div class="index-list">${shown.map((i) => indexItem(i, hrefFor)).join("")}</div>`;
  }

  return `
    <div class="toolbar">
      <input id="search-${hashString(listKey)}" type="search" placeholder="Find ${esc(noun)}…" value="${esc(st.q)}"
        data-bind="search" data-list="${esc(listKey)}" autocomplete="off">
      <select data-bind="sort" data-list="${esc(listKey)}" aria-label="Sort">
        <option value="az" ${st.sort === "az" ? "selected" : ""}>A–Z</option>
        <option value="count" ${st.sort === "count" ? "selected" : ""}>Most quotes</option>
      </select>
      <span class="count">${shown.length} ${esc(noun)}</span>
    </div>
    ${body}`;
}

function indexItem(i, hrefFor) {
  return `<a class="index-item" href="${hrefFor(i)}"><span class="name">${esc(i.name)}</span><span class="c">${i.count}</span></a>`;
}

// ---------- detail widgets ----------

function tally(quotes, pick) {
  const m = new Map();
  for (const q of quotes) {
    for (const [key, name] of pick(q)) {
      const e = m.get(key) || { key, name, count: 0 };
      e.count++;
      m.set(key, e);
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
const byPeople = (q) => (q.people || []).map((p) => [keyOf(p), p]);
const byCats = (q) => (q.categories || []).map((c) => [c, c]);
const byAdder = (q) => [[q.addedBy, q.addedByName || "Unknown"]];
const personHref = (i) => `#/person/${enc(i.key)}`;
const catHref = (i) => `#/category/${enc(i.key)}`;
const adderHref = (i) => `#/adder/${enc(i.key)}`;

function board(title, items, hrefFor, moreHref) {
  const top = items.slice(0, 5);
  const max = top[0]?.count || 1;
  const rows = top.map((i, n) => `
    <a class="bar-row" href="${hrefFor(i)}">
      <span class="rank">${String(n + 1).padStart(2, "0")}</span>
      <span class="label"><span>${esc(i.name)}</span><span class="bar"><i style="width:${Math.max(4, Math.round((i.count / max) * 100))}%"></i></span></span>
      <span class="n">${i.count}</span>
    </a>`).join("");
  return `
    <div class="board">
      <h3>${esc(title)} <a href="${moreHref}">ALL &rarr;</a></h3>
      ${rows || `<p style="font-family:var(--mono);color:var(--dim);font-size:13px;margin:0">Nothing yet.</p>`}
    </div>`;
}

function chipRow(label, items, hrefFor) {
  if (!items.length) return "";
  return `<div class="row"><span class="l">${esc(label)}</span><span class="chips">${items.slice(0, 8)
    .map((i) => `<a class="chip" href="${hrefFor(i)}">${esc(i.name)} &middot; ${i.count}</a>`).join("")}</span></div>`;
}

// Stats + "often quoted with" / "top categories" etc. at the top of person, adder and category pages.
function detailStrip(quotes, { person, category, adder } = {}) {
  if (!state.quotesReady || !quotes.length) return "";
  const times = quotes.map((q) => millis(q.createdAt)).filter(Boolean).sort((a, b) => a - b);
  const people = tally(quotes, byPeople).filter((p) => p.key !== person);
  const cats = tally(quotes, byCats).filter((c) => c.key !== category);
  const adders = tally(quotes, byAdder).filter((a) => a.key !== adder);
  const share = Math.round((quotes.length / Math.max(1, state.quotes.length)) * 100);

  const cells = [
    [quotes.length, "Quotes"],
    [`${share}%`, "Of the book"],
    [person ? people.length : tally(quotes, byPeople).length, person ? "Quoted alongside" : "People"],
    [times.length ? fmtDate(times[0]) : "—", "First added", true],
    [times.length ? fmtDate(times[times.length - 1]) : "—", "Latest", true]
  ];
  return `
    <div class="detail-strip">
      ${cells.map(([n, l, sm]) => `<div><div class="n ${sm ? "sm" : ""}">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join("")}
    </div>
    <div class="detail-chips">
      ${chipRow(person ? "Often with" : category ? "Most quoted" : "Quotes most", people, personHref)}
      ${chipRow("Top categories", cats, catHref)}
      ${adder ? "" : chipRow("Added mostly by", adders, adderHref)}
    </div>`;
}

// ---------- views ----------

function setupView() {
  return `
    <div class="setup">
      <div class="kicker">§ 00 &mdash; <b>Setup</b></div>
      <h1 class="page-title">Almost there</h1>
      <p class="page-sub">The site works — it just isn't connected to a database yet.</p>
      <div class="panel">
        <h3>Connect Firebase</h3>
        <p>Open <code>js/firebase-config.js</code> and paste in your Firebase web config. The full walkthrough is in <code>README.md</code>.</p>
        <pre>export const firebaseConfig = {
  apiKey: "…",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  …
};</pre>
      </div>
    </div>`;
}

function loginView() {
  const signup = ui.authMode === "signup";
  return `
    <div class="auth-box">
      <div class="kicker">The Quotebook &mdash; <b>Members only</b></div>
      <h1 class="page-title">${signup ? "Join up" : "Sign in"}</h1>
      <p class="page-sub">The quotebook is members only. New accounts start as enjoyers; an owner can promote you.</p>
      <div class="form">
        <button class="btn solid" data-action="google">Continue with Google</button>
        <div class="divider">OR</div>
        <form class="form" data-form="${signup ? "signup" : "signin"}">
          ${signup ? `<div class="field"><label for="a-name">Display name</label><input id="a-name" name="name" required maxlength="40" autocomplete="nickname"></div>` : ""}
          <div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" required autocomplete="email"></div>
          <div class="field"><label for="a-pass">Password</label><input id="a-pass" name="password" type="password" required minlength="6" autocomplete="${signup ? "new-password" : "current-password"}"></div>
          <div class="row">
            <button class="btn solid" type="submit">${signup ? "Create account" : "Sign in"}</button>
            <button class="linkish" type="button" data-action="authmode">${signup ? "Have an account? Sign in" : "New here? Make an account"}</button>
            ${signup ? "" : `<button class="linkish" type="button" data-action="reset">Forgot password</button>`}
          </div>
        </form>
      </div>
    </div>`;
}

function homeView() {
  const quotes = state.quotes;
  if (ui.spotlight && !quotes.some((q) => q.id === ui.spotlight)) ui.spotlight = null;
  if (!ui.spotlight && quotes.length) ui.spotlight = quotes[Math.floor(Math.random() * quotes.length)].id;
  const spot = quotes.find((q) => q.id === ui.spotlight);

  const today = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const masthead = `<div class="masthead"><span>Vol. I</span><span>${esc(today)}</span><span>No. ${quotes.length}</span></div>`;

  const hero = !state.quotesReady ? `<section class="hero">${loadingView()}</section>`
    : spot ? `
      <section class="hero">
        ${masthead}
        <div class="label" style="margin-top:18px">Random quote &middot; No. ${quoteNo(spot)}</div>
        <blockquote>“${esc(spot.text)}”</blockquote>
        <div class="by">— ${(spot.people || []).map((p) => `<a href="#/person/${enc(keyOf(p))}">${esc(p)}</a>`).join(" &amp; ")}</div>
        <div class="credit">${[
          spot.context ? esc(spot.context) : "",
          spot.saidOn ? `said ${esc(fmtSaidOn(spot.saidOn))}` : "",
          `added by ${esc(spot.addedByName || "someone")}`
        ].filter(Boolean).join(" &middot; ")}</div>
        <div class="actions">
          <button class="btn solid" data-action="another">Another one</button>
          <a class="btn" href="#/all">Read the whole book</a>
        </div>
      </section>`
    : `
      <section class="hero">
        ${masthead}
        <div class="label" style="margin-top:18px">Fresh book</div>
        <blockquote>The pages are empty.</blockquote>
        <div class="actions"><a class="btn solid" href="#/add">${canAdd() ? "Add the first quote" : "Request the first quote"}</a></div>
      </section>`;

  const pending = state.requests.filter((r) => r.status === "pending").length;
  const tiles = [
    ["#/all", "The Whole Book", "Every quote, searchable and sortable."],
    ["#/people", "By Person", "Who said it."],
    ["#/adders", "By Who Added", "Who wrote it down."],
    ["#/categories", "By Category", "Sorted by vibe."],
    ["#/add", canAdd() ? "Add a Quote" : "Request a Quote", canAdd() ? "Put something in the book." : "Send one in for review."]
  ];
  if (isStaff()) tiles.push(["#/requests", "Review Requests", pending ? `${pending} waiting on you.` : "Nothing waiting."]);
  else if (!canAdd()) tiles.push(["#/requests", "My Requests", "See what got in."]);
  if (isStaff()) tiles.push(["#/control", "Control Room", isOwner() ? "Roles, backups, restore." : "See who's who."]);

  const latest = sortQuotes(quotes, "new").slice(0, 4);

  // scrolling ticker of snippets; the track is doubled so the loop is seamless
  const snippets = [...quotes]
    .sort((a, b) => hashString(a.id + ui.seed) - hashString(b.id + ui.seed))
    .slice(0, 12)
    .map((q) => `<span>“${esc(q.text.length > 70 ? q.text.slice(0, 70).trimEnd() + "…" : q.text)}” — ${esc((q.people || []).join(" & "))}</span>`)
    .join("");
  const ticker = snippets ? `<div class="ticker" aria-hidden="true"><div class="ticker-track">${snippets}${snippets}</div></div>` : "";

  const boards = state.quotesReady && quotes.length ? `
    <h2 class="section-head">The Leaderboards</h2>
    <div class="boards">
      ${board("Most quoted", tally(quotes, byPeople), personHref, "#/people")}
      ${board("Top categories", tally(quotes, byCats), catHref, "#/categories")}
      ${board("Top scribes", tally(quotes, byAdder), adderHref, "#/adders")}
    </div>` : "";

  return `
    ${ticker}
    ${hero}
    <div class="stats">
      <div class="stat"><div class="n">${quotes.length}</div><div class="l">Quotes</div></div>
      <div class="stat"><div class="n">${peopleIndex().length}</div><div class="l">People quoted</div></div>
      <div class="stat"><div class="n">${categoriesIndex().length}</div><div class="l">Categories</div></div>
    </div>
    <form class="searchbar" data-form="homesearch">
      <input id="home-search" name="q" type="search" placeholder="Search by name, words, category…" autocomplete="off">
      <button class="btn solid" type="submit">Search</button>
    </form>
    <div class="tiles">
      ${tiles.map(([href, t, d], i) => `
        <a class="tile" href="${href}">
          <span class="num">${String(i + 1).padStart(2, "0")}</span>
          <span class="t">${esc(t)}</span>
          <span class="d">${esc(d)}</span>
        </a>`).join("")}
    </div>
    ${boards}
    ${latest.length ? `<h2 class="section-head">Latest additions</h2><div class="quotes">${latest.map(quoteCard).join("")}</div>` : ""}`;
}

function allView(_args, query) {
  const st = (ui.lists.all ||= { q: "", sort: "new" });
  if (query.has("q")) {
    st.q = query.get("q");
    history.replaceState(null, "", "#/all");
  }
  return `
    ${pageHead("§ 01 &mdash; <b>The Archive</b>", "The Whole Book", `Every quote ever written down. ${state.quotes.length} and counting.`)}
    ${quoteList("all", state.quotes)}`;
}

function peopleView() {
  return `
    ${pageHead("§ 02 &mdash; <b>Browse</b>", "By Person", "Everyone who has ever said something quotable.")}
    ${indexList(peopleIndex(), (p) => `#/person/${enc(p.key)}`, "people", "people")}`;
}

function personView([key = ""]) {
  const k = keyOf(key);
  const person = peopleIndex().find((p) => p.key === k);
  const quotes = state.quotes.filter((q) => (q.people || []).some((p) => keyOf(p) === k));
  return `
    ${pageHead(`§ 02 &mdash; <a href="#/people">People</a> / <b>Person</b>`, person?.name || key, `${quotes.length} quote${quotes.length === 1 ? "" : "s"} on the record.`)}
    ${detailStrip(quotes, { person: k })}
    ${quoteList("person:" + k, quotes, "Nobody has quoted them yet.")}`;
}

function addersView() {
  return `
    ${pageHead("§ 03 &mdash; <b>Browse</b>", "By Who Added", "The scribes. The people writing it all down.")}
    ${indexList(addersIndex(), (a) => `#/adder/${enc(a.key)}`, "adders", "adders")}`;
}

function adderView([uid = ""]) {
  const adder = addersIndex().find((a) => a.key === uid);
  const quotes = state.quotes.filter((q) => q.addedBy === uid);
  return `
    ${pageHead(`§ 03 &mdash; <a href="#/adders">Added by</a> / <b>Scribe</b>`, adder?.name || "Unknown", `Wrote down ${quotes.length} quote${quotes.length === 1 ? "" : "s"}.`)}
    ${detailStrip(quotes, { adder: uid })}
    ${quoteList("adder:" + uid, quotes, "They haven't added anything.")}`;
}

function categoriesView() {
  return `
    ${pageHead("§ 04 &mdash; <b>Browse</b>", "By Category", "Sorted by vibe. A quote can have as many categories as you want.")}
    ${indexList(categoriesIndex(), (c) => `#/category/${enc(c.key)}`, "categories", "categories")}`;
}

function categoryView([cat = ""]) {
  const quotes = state.quotes.filter((q) => (q.categories || []).includes(cat));
  return `
    ${pageHead(`§ 04 &mdash; <a href="#/categories">Categories</a> / <b>Category</b>`, cat, `${quotes.length} quote${quotes.length === 1 ? "" : "s"} filed here.`)}
    ${detailStrip(quotes, { category: cat })}
    ${quoteList("category:" + cat, quotes, "Nothing in this category.")}`;
}

function suggestionChips(targetId, items, limit = 14) {
  const top = [...items].sort((a, b) => b.count - a.count).slice(0, limit);
  if (!top.length) return "";
  return `<div class="chips">${top.map((i) =>
    `<button type="button" class="chip" data-action="append" data-target="${targetId}" data-value="${esc(i.name)}">+ ${esc(i.name)}</button>`).join("")}</div>`;
}

function quoteFields(q = {}, prefix = "f") {
  return `
    <div class="field">
      <label for="${prefix}-text">The quote</label>
      <textarea id="${prefix}-text" name="text" required maxlength="3000" placeholder="What did they say?">${esc(q.text)}</textarea>
      <span class="hint">Write it exactly how it was said. For a back-and-forth, put each line on its own line.</span>
    </div>
    <div class="field">
      <label for="${prefix}-people">Who said it</label>
      <input id="${prefix}-people" name="people" required value="${esc((q.people || []).join(", "))}" placeholder="Maggie, Magnus" autocomplete="off">
      <span class="hint">Separate multiple people with commas.</span>
      ${suggestionChips(prefix + "-people", peopleIndex())}
    </div>
    <div class="field">
      <label for="${prefix}-cats">Categories</label>
      <input id="${prefix}-cats" name="categories" value="${esc((q.categories || []).join(", "))}" placeholder="unhinged, school, out of context" autocomplete="off">
      <span class="hint">Optional. Comma separated. Make up new ones whenever.</span>
      ${suggestionChips(prefix + "-cats", categoriesIndex())}
    </div>
    <div class="field">
      <label for="${prefix}-context">Context</label>
      <input id="${prefix}-context" name="context" maxlength="300" value="${esc(q.context)}" placeholder="Optional — e.g. 'at 2am on the bus'">
    </div>
    <div class="field">
      <label for="${prefix}-date">When it was said</label>
      <input id="${prefix}-date" name="saidOn" type="date" value="${esc(q.saidOn)}">
    </div>`;
}

function readQuoteForm(form) {
  const f = new FormData(form);
  return {
    text: String(f.get("text") || "").trim(),
    people: splitList(f.get("people")),
    categories: splitList(f.get("categories"), true),
    context: String(f.get("context") || "").trim(),
    saidOn: String(f.get("saidOn") || "")
  };
}

function addView() {
  if (canAdd()) {
    return `
      <div class="kicker">§ 05 &mdash; <b>Contribute</b> &middot; this will be No. ${String(state.quotes.length + 1).padStart(3, "0")}</div>
      <h1 class="page-title">Add a Quote</h1>
      <p class="page-sub">It'll show up as added by ${esc(state.profile.displayName)}.</p>
      <form class="form" data-form="add">
        ${quoteFields()}
        <div class="row"><button class="btn solid" type="submit">Put it in the book</button></div>
      </form>`;
  }
  return `
    <div class="kicker">§ 05 &mdash; <b>Contribute</b></div>
    <h1 class="page-title">Request a Quote</h1>
    <p class="page-sub">Enjoyers can't add directly — send it in and an owner or admin will review it.</p>
    <form class="form" data-form="request">
      ${quoteFields()}
      <div class="row"><button class="btn solid" type="submit">Send request</button><a class="btn" href="#/requests">My requests</a></div>
    </form>`;
}

function requestCard(r, staffMode) {
  const when = fmtDate(millis(r.createdAt));
  const reviewed = r.status !== "pending" && r.reviewedByName ? ` by ${esc(r.reviewedByName)}` : "";
  let actions = "";
  if (staffMode && r.status === "pending") {
    actions = `
      <button class="btn small solid" data-action="approve" data-id="${esc(r.id)}">Approve</button>
      <button class="btn small" data-action="editapprove" data-id="${esc(r.id)}">Edit &amp; approve</button>
      <button class="btn small" data-action="reject" data-id="${esc(r.id)}">Reject</button>`;
  } else if (r.status === "pending" || staffMode) {
    actions = `<button class="btn small" data-action="delrequest" data-id="${esc(r.id)}">${r.status === "pending" ? "Withdraw" : "Clear"}</button>`;
  }
  return `
    <div class="request">
      <span class="status ${esc(r.status)}">${esc(r.status)}${reviewed}</span>
      <div class="quote" style="border:0;padding:0">
        <div class="text">${esc(r.text)}</div>
        <div class="people">— ${esc((r.people || []).join(" & "))}</div>
        ${r.context ? `<div class="context">${esc(r.context)}</div>` : ""}
        ${(r.categories || []).length ? `<div class="chips">${r.categories.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>` : ""}
      </div>
      <div class="row" style="justify-content:space-between">
        <span style="font-family:var(--mono);font-size:12px;color:var(--dim)">requested by ${esc(r.requestedByName)} · ${esc(when)}</span>
        <span class="row">${actions}</span>
      </div>
    </div>`;
}

function requestsView() {
  const sorted = [...state.requests].sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
  if (isStaff()) {
    const pending = sorted.filter((r) => r.status === "pending");
    const done = sorted.filter((r) => r.status !== "pending").slice(0, 30);
    return `
      <div class="kicker">§ 06 &mdash; <b>The Queue</b></div>
      <h1 class="page-title">Requests</h1>
      <p class="page-sub">Quotes enjoyers want added. Approving puts it in the book.</p>
      <h2 class="section-head">Waiting (${pending.length})</h2>
      ${pending.length ? pending.map((r) => requestCard(r, true)).join("") : emptyBox("ALL CLEAR", "No requests waiting.")}
      ${done.length ? `<h2 class="section-head">Recently handled</h2>${done.map((r) => requestCard(r, true)).join("")}` : ""}`;
  }
  return `
    <div class="kicker">§ 06 &mdash; <b>The Queue</b></div>
    <h1 class="page-title">My Requests</h1>
    <p class="page-sub">Quotes you've sent in, and what happened to them.</p>
    <div class="row" style="margin-bottom:20px"><a class="btn solid" href="#/add">+ New request</a></div>
    ${sorted.length ? sorted.map((r) => requestCard(r, false)).join("") : emptyBox("NOTHING YET", "You haven't requested anything.")}`;
}

function controlView() {
  if (!isStaff()) return notFoundView();
  const counts = {};
  for (const q of state.quotes) counts[q.addedBy] = (counts[q.addedBy] || 0) + 1;
  const users = [...state.users].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || String(a.displayName).localeCompare(String(b.displayName)));

  const rows = users.map((u) => `
    <tr>
      <td data-label="Name"><span><strong>${esc(u.displayName)}</strong>${u.id === state.user.uid ? " (you)" : ""}</span></td>
      <td data-label="Email">${esc(u.email)}</td>
      <td data-label="Role">${isOwner()
        ? `<select data-bind="role" data-uid="${esc(u.id)}" aria-label="Role for ${esc(u.displayName)}">
            ${ROLES.map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${r}</option>`).join("")}
           </select>`
        : `<span class="role-badge ${esc(u.role)}">${esc(u.role)}</span>`}</td>
      <td data-label="Added">${counts[u.id] || 0}</td>
      <td data-label="Joined">${esc(fmtDate(millis(u.createdAt)))}</td>
    </tr>`).join("");

  return `
    <div class="kicker">§ 07 &mdash; <b>Staff only</b></div>
    <h1 class="page-title">Control Room</h1>
    <p class="page-sub">${isOwner() ? "You run this place." : "Admins can look. Only owners can change roles."}</p>

    <h2 class="section-head">Members (${users.length})</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Added</th><th>Joined</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5">Loading…</td></tr>`}</tbody>
      </table>
    </div>

    <h2 class="section-head">Roles</h2>
    <div class="index-list" style="margin-bottom:8px">
      ${ROLES.map((r) => `<div class="index-item" style="display:block"><div class="name">${r}</div><div class="c" style="margin-top:6px">${esc(ROLE_INFO[r])}</div></div>`).join("")}
    </div>

    ${isOwner() ? `
      <h2 class="section-head">Backups</h2>
      <div class="panel">
        <h3>Download backup</h3>
        <p>Saves every quote, member and request as one JSON file. Stick it on the SSD.</p>
        <button class="btn solid" data-action="backup">Download backup</button>
      </div>
      <div class="panel">
        <h3>Restore quotes from backup</h3>
        <p>Puts quotes from a backup file back into the book. Quotes with the same ID get overwritten; nothing gets deleted.</p>
        <input type="file" id="restore-file" accept="application/json,.json" data-bind="restore">
      </div>` : ""}`;
}

// ---------- modals ----------

function openModal(inner) {
  $modal.innerHTML = `<div class="modal-backdrop" data-backdrop><div class="modal" role="dialog" aria-modal="true">${inner}</div></div>`;
  const first = $modal.querySelector("input, textarea, button");
  if (first) first.focus();
}
function closeModal() { $modal.innerHTML = ""; }

function confirmBox(title, message, okLabel = "Yes") {
  return new Promise((resolve) => {
    openModal(`
      <h2>${esc(title)}</h2>
      <p style="font-family:var(--mono);color:var(--dim)">${esc(message)}</p>
      <div class="row"><button class="btn solid" data-confirm="yes">${esc(okLabel)}</button><button class="btn" data-confirm="no">Cancel</button></div>`);
    $modal.querySelector('[data-confirm="no"]').focus();
    const done = (v) => { $modal.removeEventListener("click", onClick); closeModal(); resolve(v); };
    const onClick = (e) => {
      const b = e.target.closest("[data-confirm]");
      if (b) done(b.dataset.confirm === "yes");
      else if (e.target.matches("[data-backdrop]")) done(false);
    };
    $modal.addEventListener("click", onClick);
  });
}

// ---------- actions ----------

const findQuote = (id) => state.quotes.find((q) => q.id === id);
const findRequest = (id) => state.requests.find((r) => r.id === id);

function validateQuote(data) {
  if (!data.text) return "The quote can't be empty.";
  if (!data.people.length) return "Say who said it.";
  if (data.people.length > 12) return "That's too many people (max 12).";
  if (data.categories.length > 20) return "Max 20 categories.";
  return null;
}

async function approveRequest(r, data) {
  const { db } = fb;
  const batch = fb.writeBatch(db);
  const quoteRef = fb.doc(fb.collection(db, "quotes"));
  batch.set(quoteRef, {
    ...data,
    addedBy: state.user.uid,
    addedByName: state.profile.displayName,
    requestedBy: r.requestedBy,
    requestedByName: r.requestedByName || "",
    locked: false,
    createdAt: fb.serverTimestamp()
  });
  batch.update(fb.doc(db, "requests", r.id), {
    status: "approved",
    reviewedBy: state.user.uid,
    reviewedByName: state.profile.displayName,
    reviewedAt: fb.serverTimestamp(),
    quoteId: quoteRef.id
  });
  await batch.commit();
}

const actions = {
  async signout() { if (fb) await fb.signOut(fb.auth); location.hash = "#/"; },

  reload() { location.reload(); },

  async google() {
    try { await fb.signInWithPopup(fb.auth, new fb.GoogleAuthProvider()); } catch (e) { if (e.code !== "auth/popup-closed-by-user") fail(e); }
  },

  authmode() { ui.authMode = ui.authMode === "signup" ? "signin" : "signup"; render(); },

  async reset() {
    const email = document.getElementById("a-email")?.value.trim();
    if (!email) return toast("Type your email first, then hit Forgot password.", true);
    try { await fb.sendPasswordResetEmail(fb.auth, email); toast("Reset email sent."); } catch (e) { fail(e); }
  },

  rename() {
    openModal(`
      <h2>Your name</h2>
      <form class="form" data-form="rename">
        <div class="field"><label for="r-name">Display name</label><input id="r-name" name="name" required maxlength="40" value="${esc(state.profile.displayName)}"></div>
        <p class="hint" style="font-family:var(--mono);font-size:12px;color:var(--dim);margin:0">Quotes you already added keep the old name.</p>
        <div class="row"><button class="btn solid" type="submit">Save</button><button class="btn" type="button" data-action="close">Cancel</button></div>
      </form>`);
  },

  close() { closeModal(); },

  another() {
    const others = state.quotes.filter((q) => q.id !== ui.spotlight);
    if (others.length) ui.spotlight = others[Math.floor(Math.random() * others.length)].id;
    render();
  },

  reshuffle() { ui.seed = Math.random(); render(); },

  append(el) {
    const input = document.getElementById(el.dataset.target);
    if (!input) return;
    const list = splitList(input.value);
    if (!list.some((x) => x.toLowerCase() === el.dataset.value.toLowerCase())) list.push(el.dataset.value);
    input.value = list.join(", ");
    input.focus();
  },

  edit(el) {
    const q = findQuote(el.dataset.id);
    if (!q) return;
    openModal(`
      <h2>Edit quote</h2>
      <form class="form" data-form="edit" data-id="${esc(q.id)}">
        ${quoteFields(q, "e")}
        <div class="row"><button class="btn solid" type="submit">Save</button><button class="btn" type="button" data-action="close">Cancel</button></div>
      </form>`);
  },

  async delete(el) {
    const q = findQuote(el.dataset.id);
    if (!q) return;
    if (!(await confirmBox("Delete this?", `"${q.text.slice(0, 120)}${q.text.length > 120 ? "…" : ""}" — gone forever.`, "Delete"))) return;
    try { await fb.deleteDoc(fb.doc(fb.db, "quotes", q.id)); toast("Deleted."); } catch (e) { fail(e); }
  },

  async lock(el) {
    const q = findQuote(el.dataset.id);
    if (!q) return;
    const patch = q.locked
      ? { locked: false, lockedBy: fb.deleteField(), lockedByName: fb.deleteField() }
      : { locked: true, lockedBy: state.user.uid, lockedByName: state.profile.displayName };
    try { await fb.updateDoc(fb.doc(fb.db, "quotes", q.id), patch); toast(q.locked ? "Unlocked." : "Locked. Only owners can delete it now."); } catch (e) { fail(e); }
  },

  async approve(el) {
    const r = findRequest(el.dataset.id);
    if (!r) return;
    const data = { text: r.text, people: r.people || [], categories: r.categories || [], context: r.context || "", saidOn: r.saidOn || "" };
    const err = validateQuote(data);
    if (err) return toast(err + " Use Edit & approve.", true);
    try { await approveRequest(r, data); toast("Approved — it's in the book."); } catch (e) { fail(e); }
  },

  editapprove(el) {
    const r = findRequest(el.dataset.id);
    if (!r) return;
    openModal(`
      <h2>Edit &amp; approve</h2>
      <form class="form" data-form="editapprove" data-id="${esc(r.id)}">
        ${quoteFields(r, "e")}
        <div class="row"><button class="btn solid" type="submit">Approve</button><button class="btn" type="button" data-action="close">Cancel</button></div>
      </form>`);
  },

  async reject(el) {
    const r = findRequest(el.dataset.id);
    if (!r) return;
    try {
      await fb.updateDoc(fb.doc(fb.db, "requests", r.id), {
        status: "rejected", reviewedBy: state.user.uid, reviewedByName: state.profile.displayName, reviewedAt: fb.serverTimestamp()
      });
      toast("Rejected.");
    } catch (e) { fail(e); }
  },

  async delrequest(el) {
    try { await fb.deleteDoc(fb.doc(fb.db, "requests", el.dataset.id)); toast("Removed."); } catch (e) { fail(e); }
  },

  async backup() {
    try {
      const { db } = fb;
      const [qs, us, rs] = await Promise.all(["quotes", "users", "requests"].map((c) => fb.getDocs(fb.collection(db, c))));
      const plain = (snap) => snap.docs.map((d) => {
        const data = d.data();
        for (const [k, v] of Object.entries(data)) if (v && typeof v.toMillis === "function") data[k] = new Date(v.toMillis()).toISOString();
        return { id: d.id, ...data };
      });
      const payload = { app: "quotebook", version: 1, exportedAt: new Date().toISOString(), quotes: plain(qs), users: plain(us), requests: plain(rs) };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `quotebook-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(`Backed up ${payload.quotes.length} quotes.`);
    } catch (e) { fail(e); }
  }
};

async function restoreFromFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast("That file isn't valid JSON.", true); }
  const quotes = Array.isArray(data?.quotes) ? data.quotes : null;
  if (!quotes) return toast("No quotes found in that file.", true);
  if (!(await confirmBox("Restore backup?", `This writes ${quotes.length} quotes into the book (same IDs get overwritten).`, "Restore"))) return;

  const toTs = (v) => (typeof v === "string" && !isNaN(Date.parse(v)) ? fb.Timestamp.fromMillis(Date.parse(v)) : v);
  try {
    for (let i = 0; i < quotes.length; i += 400) {
      const batch = fb.writeBatch(fb.db);
      for (const { id, ...q } of quotes.slice(i, i + 400)) {
        const clean = { ...q, locked: !!q.locked, categories: q.categories || [], people: q.people || [] };
        for (const k of ["createdAt", "updatedAt"]) if (clean[k]) clean[k] = toTs(clean[k]);
        batch.set(id ? fb.doc(fb.db, "quotes", String(id)) : fb.doc(fb.collection(fb.db, "quotes")), clean);
      }
      await batch.commit();
    }
    toast(`Restored ${quotes.length} quotes.`);
  } catch (e) { fail(e); }
}

const forms = {
  async signin(form) {
    const f = new FormData(form);
    try { await fb.signInWithEmailAndPassword(fb.auth, f.get("email"), f.get("password")); } catch (e) { fail(e); }
  },

  async signup(form) {
    const f = new FormData(form);
    pendingName = String(f.get("name") || "").trim();
    try {
      const cred = await fb.createUserWithEmailAndPassword(fb.auth, f.get("email"), f.get("password"));
      await fb.updateProfile(cred.user, { displayName: pendingName });
    } catch (e) { fail(e); }
  },

  homesearch(form) {
    const q = String(new FormData(form).get("q") || "").trim();
    location.hash = q ? `#/all?q=${enc(q)}` : "#/all";
  },

  async rename(form) {
    const name = String(new FormData(form).get("name") || "").trim().slice(0, 40);
    if (!name) return;
    try { await fb.updateDoc(fb.doc(fb.db, "users", state.user.uid), { displayName: name }); closeModal(); toast("Name updated."); } catch (e) { fail(e); }
  },

  async add(form) {
    const data = readQuoteForm(form);
    const err = validateQuote(data);
    if (err) return toast(err, true);
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      await fb.addDoc(fb.collection(fb.db, "quotes"), {
        ...data,
        addedBy: state.user.uid,
        addedByName: state.profile.displayName,
        locked: false,
        createdAt: fb.serverTimestamp()
      });
      toast("In the book.");
      form.reset();
      render(); // refresh suggestion chips
    } catch (e) { fail(e); } finally { btn.disabled = false; }
  },

  async request(form) {
    const data = readQuoteForm(form);
    const err = validateQuote(data);
    if (err) return toast(err, true);
    try {
      await fb.addDoc(fb.collection(fb.db, "requests"), {
        ...data,
        requestedBy: state.user.uid,
        requestedByName: state.profile.displayName,
        status: "pending",
        createdAt: fb.serverTimestamp()
      });
      toast("Request sent. An owner or admin will look at it.");
      form.reset();
    } catch (e) { fail(e); }
  },

  async edit(form) {
    const data = readQuoteForm(form);
    const err = validateQuote(data);
    if (err) return toast(err, true);
    try {
      await fb.updateDoc(fb.doc(fb.db, "quotes", form.dataset.id), { ...data, updatedAt: fb.serverTimestamp() });
      closeModal();
      toast("Saved.");
    } catch (e) { fail(e); }
  },

  async editapprove(form) {
    const r = findRequest(form.dataset.id);
    if (!r) return;
    const data = readQuoteForm(form);
    const err = validateQuote(data);
    if (err) return toast(err, true);
    try { await approveRequest(r, data); closeModal(); toast("Approved — it's in the book."); } catch (e) { fail(e); }
  }
};

// ---------- event wiring ----------

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) {
    e.preventDefault();
    actions[el.dataset.action](el);
    return;
  }
  if (e.target.matches("[data-backdrop]") && !$modal.querySelector("[data-confirm]")) closeModal();
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-form]");
  if (form && forms[form.dataset.form]) {
    e.preventDefault();
    forms[form.dataset.form](form);
  }
});

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.bind === "search") {
    ui.lists[el.dataset.list].q = el.value;
    render();
  }
});

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset.bind === "sort") {
    ui.lists[el.dataset.list].sort = el.value;
    render();
  } else if (el.dataset.bind === "role") {
    const uid = el.dataset.uid;
    const role = el.value;
    const prev = state.users.find((u) => u.id === uid)?.role;
    if (uid === state.user.uid && role !== "owner" &&
        !(await confirmBox("Demote yourself?", "You'll lose owner powers and can't undo this yourself.", "Do it"))) {
      el.value = prev;
      return;
    }
    try { await fb.updateDoc(fb.doc(fb.db, "users", uid), { role }); toast(`Now ${role}.`); } catch (err) { el.value = prev; fail(err); }
  } else if (el.dataset.bind === "restore" && el.files?.[0]) {
    await restoreFromFile(el.files[0]);
    el.value = "";
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setMenu(false);
  if (e.key === "Escape" && $modal.innerHTML && !$modal.querySelector("[data-confirm]")) closeModal();
});

// ---------- go ----------

if (configured) {
  initFirebase().catch((e) => {
    console.error(e);
    $app.innerHTML = emptyBox("CAN'T CONNECT", `Couldn't load Firebase: ${esc(e.message)}`);
  });
} else {
  state.authReady = true;
}
render();
