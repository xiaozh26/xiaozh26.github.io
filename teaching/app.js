/* Teaching app — password-protected slide presenter with iPad annotation and
   laptop ↔ iPad sync. Data lives in Firebase (Auth + Firestore). */

import { firebaseConfig, TEACHER_EMAIL, SESSION_HOURS } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, memoryLocalCache,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, writeBatch, deleteField, Bytes
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { getDatabase, ref as rtRef, set as rtSet, remove as rtRemove, onValue, onDisconnect } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isEditing = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
};
function toast(msg, kind = '', ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }
function loadScript(url) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${url}"]`)) return res();
    const s = document.createElement('script'); s.src = url; s.onload = res; s.onerror = () => rej(new Error('Failed to load ' + url));
    document.head.appendChild(s);
  });
}
function downloadBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
function safeName(s) { return (s || 'slides').replace(/[\\/:*?"<>|]+/g, '-').trim(); }

/* Theme */
function setTheme(t) { document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('teach_theme', t); } catch (e) {} }
function toggleTheme() { setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }

/* Device identity for presence */
const DEVICE_ID = (() => { try { let id = localStorage.getItem('teach_device'); if (!id) { id = uid(); localStorage.setItem('teach_device', id); } return id; } catch (e) { return uid(); } })();
const DEVICE_NAME = (() => {
  const ua = navigator.userAgent, touch = navigator.maxTouchPoints > 1;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) return 'iPad';
  if (/iPhone|Android/.test(ua)) return 'Phone';
  return 'Laptop';
})();

/* ------------------------------------------------------------------ */
/* Firebase                                                            */
/* ------------------------------------------------------------------ */
let app, auth, db, rtdb = null;
function firebaseReady() { return !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId); }

/* ------------------------------------------------------------------ */
/* App state                                                           */
/* ------------------------------------------------------------------ */
const S = {
  user: null,
  route: { view: 'home' },
  unsubs: [],            // listeners for the current view
  courses: [],
  course: null,
  blocks: [],
  block: null,           // live block document for the viewer
  pdf: null, pdfBytes: null, pdfFileId: null,
  pageIndex: 0,
  zoom: 1, panX: 0, panY: 0, renderQuality: 1,
  tool: 'pen', color: '#e11d48', width: 4,
  annVisible: true, followSync: true, fingerDraws: false, pencilOnly: navigator.maxTouchPoints > 1,
  strokes: {}, strokesPageId: null,
  undo: [], redo: [],
  sync: 'connecting', pending: false,
  lastNavAt: 0,
  present: false,
  lastViewAt: 0, applyingRemoteView: false, lastWrittenView: null,
};
const COLORS = ['#e11d48', '#111827', '#2563eb', '#16a34a', '#f59e0b', '#ffffff'];
const HL_COLORS = ['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74', '#c4b5fd'];
const SESSION_MS = SESSION_HOURS * 3600 * 1000;
const LOGIN_KEY = 'teach_login_at';
const CHUNK = 800 * 1024;

/* ------------------------------------------------------------------ */
/* Auth & session                                                      */
/* ------------------------------------------------------------------ */
let logoutTimer = null;
function scheduleAutoLogout(at) {
  clearTimeout(logoutTimer);
  const left = at + SESSION_MS - Date.now();
  logoutTimer = setTimeout(async () => { await doLogout(); toast('Session expired after ' + SESSION_HOURS + ' hours — please log in again.', 'err', 6000); }, Math.max(0, left));
}
async function doLogout() {
  try { localStorage.removeItem(LOGIN_KEY); } catch (e) {}
  clearTimeout(logoutTimer);
  await signOut(auth);
}
function showView(id) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + id));
  document.body.classList.toggle('in-viewer', id === 'viewer');
}
function setupLogin() {
  const form = $('#login-form'), pw = $('#pw'), eye = $('#pw-eye'), err = $('#login-error');
  eye.addEventListener('click', () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    $('.eye-open', eye).hidden = show; $('.eye-closed', eye).hidden = !show;
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    pw.focus();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const btn = $('#login-btn'); btn.disabled = true; btn.textContent = 'Checking…';
    try {
      await setPersistence(auth, browserLocalPersistence);
      await signInWithEmailAndPassword(auth, TEACHER_EMAIL, pw.value);
      try { localStorage.setItem(LOGIN_KEY, String(Date.now())); } catch (e2) {}
      pw.value = '';
    } catch (ex) {
      const code = ex && ex.code || '';
      err.textContent = /wrong-password|invalid-credential|invalid-login|user-not-found/.test(code) ? 'Incorrect password.' :
        /too-many-requests/.test(code) ? 'Too many attempts — wait a minute and try again.' :
        /network/.test(code) ? 'Network error — check your connection.' : 'Login failed (' + code + ').';
    } finally { btn.disabled = false; btn.textContent = 'Enter'; }
  });
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const m = h.match(/^c\/([^/]+)(?:\/b\/([^/]+))?/);
  if (m && m[2]) return { view: 'viewer', courseId: m[1], blockId: m[2] };
  if (m) return { view: 'course', courseId: m[1] };
  return { view: 'home' };
}
function go(path) { location.hash = path; }
function teardown() { S.unsubs.forEach(u => { try { u(); } catch (e) {} }); S.unsubs = []; }
async function route() {
  if (!S.user) return;
  teardown();
  if (S.route.view === 'viewer') leaveViewer();
  S.route = parseHash();
  if (S.route.view === 'home') await showHome();
  else if (S.route.view === 'course') await showCourse(S.route.courseId);
  else await showViewer(S.route.courseId, S.route.blockId);
}

/* ------------------------------------------------------------------ */
/* Home: courses                                                       */
/* ------------------------------------------------------------------ */
function courseIconEl(c, small = false) {
  const wrap = document.createElement('span'); wrap.className = 'course-icon' + (small ? ' sm' : '');
  const img = document.createElement('img'); img.alt = '';
  const initials = document.createElement('span'); initials.className = 'initials';
  initials.textContent = (c.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
  let src = c.icon;
  if (!src && c.url) { try { src = 'https://www.google.com/s2/favicons?domain=' + new URL(c.url).hostname + '&sz=64'; } catch (e) {} }
  if (src) { img.src = src; img.onerror = () => { img.remove(); wrap.appendChild(initials); }; wrap.appendChild(img); }
  else wrap.appendChild(initials);
  return wrap;
}
async function ensureSeedCourse() {
  const snap = await getDocs(collection(db, 'courses'));
  if (snap.empty) {
    await setDoc(doc(db, 'courses', 'cs61a'), {
      name: 'CS 61A', subtitle: 'Structure and Interpretation of Computer Programs · Fall 2026',
      url: 'https://cs61a.org/fa26/', icon: '61A.png', order: 0, createdAt: serverTimestamp()
    });
  }
}
async function showHome() {
  showView('home');
  await ensureSeedCourse();
  const list = $('#course-list');
  const unsub = onSnapshot(query(collection(db, 'courses'), orderBy('order')), (snap) => {
    S.courses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    list.innerHTML = '';
    S.courses.forEach(c => {
      const li = document.createElement('li'); li.className = 'course-card';
      li.appendChild(courseIconEl(c));
      const txt = document.createElement('div');
      txt.innerHTML = `<div class="name"></div><div class="sub"></div>`;
      $('.name', txt).textContent = c.name; $('.sub', txt).textContent = c.subtitle || c.url || '';
      li.appendChild(txt);
      const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '›'; li.appendChild(chev);
      li.addEventListener('click', () => go('/c/' + c.id));
      list.appendChild(li);
    });
  }, (err) => toast('Could not load courses: ' + err.message, 'err'));
  S.unsubs.push(unsub);
}
$('#add-course').addEventListener('click', async () => {
  const name = prompt('Course name (e.g. CS 61B)'); if (!name) return;
  const url = prompt('Course website URL (optional)') || '';
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '') || uid();
  await setDoc(doc(db, 'courses', id), { name, url, subtitle: '', icon: '', order: S.courses.length, createdAt: serverTimestamp() });
});

/* ------------------------------------------------------------------ */
/* Course: block list                                                  */
/* ------------------------------------------------------------------ */
let sortable = null;
async function showCourse(courseId) {
  showView('course');
  const cs = await getDoc(doc(db, 'courses', courseId));
  if (!cs.exists()) { toast('Course not found', 'err'); go('/'); return; }
  S.course = { id: cs.id, ...cs.data() };
  $('#course-hdr-name').textContent = S.course.name;
  $('#course-title').textContent = S.course.name;
  const ic = $('#course-hdr-icon'); ic.replaceWith(Object.assign(courseIconEl(S.course, true), { id: 'course-hdr-icon' }));
  const link = $('#course-link'); link.textContent = S.course.url || ''; link.href = S.course.url || '#';
  const list = $('#block-list');
  let pendingRender = null;
  const render = () => {
    if (list.contains(document.activeElement)) { pendingRender = true; return; }
    pendingRender = false;
    list.innerHTML = '';
    if (!S.blocks.length) { list.innerHTML = '<li class="empty">No blocks yet. Create one for your first lecture.</li>'; return; }
    S.blocks.forEach(b => list.appendChild(blockRow(b)));
    const online = S.blocks.filter(b => b.fileId || (b.pages || []).length).length;
    const note = $('#cloud-notice'); note.hidden = !online;
    if (online) note.textContent = `${online} block${online === 1 ? ' has' : 's have'} slides stored online. When class is over, use “Finish & remove” to download the annotated PDF and delete the slides from the cloud.`;
  };
  list.addEventListener('focusout', () => setTimeout(() => { if (pendingRender && !list.contains(document.activeElement)) render(); }, 50));
  const unsub = onSnapshot(query(collection(db, 'courses', courseId, 'blocks'), orderBy('order')), (snap) => {
    S.blocks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
    prefetchSlides(S.blocks);
  }, (err) => toast('Could not load blocks: ' + err.message, 'err'));
  S.unsubs.push(unsub);
  if (sortable) sortable.destroy();
  sortable = new Sortable(list, {
    handle: '.grip', animation: 150, delay: 120, delayOnTouchOnly: true,
    onEnd: async () => {
      const ids = $$('.block', list).map(li => li.dataset.id);
      const batch = writeBatch(db);
      ids.forEach((id, i) => batch.update(doc(db, 'courses', courseId, 'blocks', id), { order: i }));
      await batch.commit();
    }
  });
  S.unsubs.push(() => { sortable && sortable.destroy(); sortable = null; });
}
function blockRow(b) {
  const li = document.createElement('li'); li.className = 'block'; li.dataset.id = b.id;
  li.innerHTML = `
    <span class="grip" title="Drag to reorder">⋮⋮</span>
    <div class="block-main">
      <input class="inline-input title" placeholder="Block title">
      <input class="inline-input label" placeholder="Date / note, e.g. 9/10 Lecture – Recursion">
      <div class="block-meta"></div>
    </div>
    <div class="block-actions">
      <button class="btn sm primary" data-act="open">Open</button>
      <button class="btn sm" data-act="upload">${b.fileId ? 'Replace PDF' : 'Upload PDF'}</button>
      <button class="btn sm" data-act="finish" title="Download the annotated PDF and remove the slides from the cloud" ${(b.fileId || (b.pages || []).length) ? '' : 'hidden'}>Finish &amp; remove</button>
      <button class="icon-btn" data-act="delete" title="Delete block"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>
    </div>`;
  const title = $('.title', li), label = $('.label', li);
  title.value = b.title || ''; label.value = b.label || '';
  const pages = (b.pages || []).length;
  const meta = $('.block-meta', li);
  if (b.fileId) { meta.innerHTML = '<span class="cloud">☁ online</span> '; meta.appendChild(document.createTextNode(`${b.fileName || 'slides.pdf'} · ${pages} page${pages === 1 ? '' : 's'}`)); }
  else if (pages) { meta.innerHTML = '<span class="cloud">☁ online</span> '; meta.appendChild(document.createTextNode(`${pages} blank page${pages === 1 ? '' : 's'}`)); }
  else if (b.finishedAt) { const d = b.finishedAt && b.finishedAt.toDate ? b.finishedAt.toDate() : (b.finishedAt instanceof Date ? b.finishedAt : null); meta.textContent = `Finished${d ? ' ' + d.toLocaleDateString() : ''} · slides removed from the cloud · saved as “${b.finishedFile || 'annotated PDF'}”`; }
  else meta.textContent = 'No slides uploaded';
  const ref = doc(db, 'courses', S.course.id, 'blocks', b.id);
  const save = debounce(() => updateDoc(ref, { title: title.value.trim() || 'Untitled', label: label.value.trim() }), 400);
  [title, label].forEach(inp => {
    inp.addEventListener('input', save);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  });
  $('[data-act="open"]', li).addEventListener('click', () => go(`/c/${S.course.id}/b/${b.id}`));
  $('[data-act="upload"]', li).addEventListener('click', () => pickAndUpload(S.course.id, b));
  $('[data-act="delete"]', li).addEventListener('click', () => deleteBlock(S.course.id, b));
  $('[data-act="finish"]', li).addEventListener('click', () => finishBlock(S.course.id, b));
  return li;
}
$('#add-block').addEventListener('click', async () => {
  const n = S.blocks.length;
  const ref = doc(collection(db, 'courses', S.course.id, 'blocks'));
  await setDoc(ref, { title: 'Lecture ' + (n + 1), label: '', order: n, pages: [], fileId: null, currentPageId: null, createdAt: serverTimestamp() });
});
async function deleteBlock(courseId, b) {
  if (!confirm(`Delete "${b.title}" and all its annotations? This cannot be undone.`)) return;
  const ref = doc(db, 'courses', courseId, 'blocks', b.id);
  try {
    const pages = await getDocs(collection(ref, 'pages'));
    const batch = writeBatch(db); pages.forEach(d => batch.delete(d.ref)); batch.delete(ref); await batch.commit();
    if (b.fileId) deleteFile(b.fileId);
    toast('Block deleted');
  } catch (e) { toast('Delete failed: ' + e.message, 'err'); }
}

/* ------------------------------------------------------------------ */
/* PDF storage: files/{id} + files/{id}/chunks/{00000..}               */
/* ------------------------------------------------------------------ */
async function deleteFile(fileId) {
  FileCache.del(fileId);
  try {
    const chunks = await getDocs(collection(db, 'files', fileId, 'chunks'));
    const batch = writeBatch(db); chunks.forEach(d => batch.delete(d.ref)); batch.delete(doc(db, 'files', fileId)); await batch.commit();
  } catch (e) { console.warn('deleteFile', e); }
}
function pickAndUpload(courseId, block) {
  const input = $('#file-input');
  input.onchange = async () => { const f = input.files[0]; input.value = ''; if (f) await uploadPdf(courseId, block, f); };
  input.click();
}
function progressModal(title) {
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="card"><h1 style="font-size:18px"></h1><div class="progress"><i></i></div><p class="muted" style="margin:0;font-size:13px"></p></div>`;
  $('h1', m).textContent = title; document.body.appendChild(m);
  return { set: (f, txt) => { $('.progress i', m).style.width = Math.round(f * 100) + '%'; if (txt) $('p', m).textContent = txt; }, close: () => m.remove() };
}
async function uploadPdf(courseId, block, file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    alert('Please upload a PDF. For PowerPoint or Keynote decks use File → Export → PDF, then upload that file.'); return;
  }
  if (file.size > 60 * 1024 * 1024) { alert('This PDF is larger than 60 MB. Please compress it (e.g. "Reduce File Size" in Preview) before uploading.'); return; }
  if (block.fileId && !confirm('Replace the existing slides? Page order and annotations for this block will be reset.')) return;
  const pm = progressModal('Uploading ' + file.name);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    pm.set(0.02, 'Reading PDF…');
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const first = await pdf.getPage(1); const vp = first.getViewport({ scale: 1 });
    const pageAspect = vp.width / vp.height; const pageCount = pdf.numPages;
    pdf.destroy();
    const fileId = uid();
    const chunkCount = Math.ceil(bytes.length / CHUNK);
    for (let i = 0; i < chunkCount; i++) {
      const part = bytes.subarray(i * CHUNK, Math.min(bytes.length, (i + 1) * CHUNK));
      await setDoc(doc(db, 'files', fileId, 'chunks', String(i).padStart(5, '0')), { data: Bytes.fromUint8Array(part) });
      pm.set(0.05 + 0.9 * (i + 1) / chunkCount, `Uploading chunk ${i + 1} of ${chunkCount}…`);
    }
    await setDoc(doc(db, 'files', fileId), { name: file.name, size: bytes.length, chunkCount, chunkSize: CHUNK, pageCount, createdAt: serverTimestamp() });
    const pages = Array.from({ length: pageCount }, (_, i) => ({ id: uid(), type: 'pdf', src: i }));
    // Wipe old annotations
    const ref = doc(db, 'courses', courseId, 'blocks', block.id);
    const old = await getDocs(collection(ref, 'pages'));
    if (!old.empty) { const batch = writeBatch(db); old.forEach(d => batch.delete(d.ref)); await batch.commit(); }
    await FileCache.put(fileId, bytes);
    await updateDoc(ref, { fileId, fileName: file.name, fileSize: bytes.length, pageCount, pageAspect, pages, currentPageId: pages[0].id, updatedAt: serverTimestamp() });
    if (block.fileId) deleteFile(block.fileId);
    pm.set(1, 'Done'); await sleep(300);
    toast(`Uploaded ${file.name} (${pageCount} pages)`, 'ok');
  } catch (e) {
    console.error(e); alert('Upload failed: ' + e.message);
  } finally { pm.close(); }
}
/* Per-device cache of assembled PDFs (IndexedDB) so a deck is downloaded once per device. */
const FileCache = {
  dbp: null,
  open() {
    if (!this.dbp) this.dbp = new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('no idb'));
      const r = indexedDB.open('teach-files', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this.dbp;
  },
  async run(mode, fn) { try { const d = await this.open(); return await new Promise((res, rej) => { const req = fn(d.transaction('files', mode).objectStore('files')); req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); } catch (e) { return undefined; } },
  async get(id) { const buf = await this.run('readonly', st => st.get(id)); return buf ? new Uint8Array(buf) : null; },
  async has(id) { return !!(await this.run('readonly', st => st.getKey(id))); },
  async put(id, bytes) { return this.run('readwrite', st => st.put(bytes.slice().buffer, id)); },
  async del(id) { return this.run('readwrite', st => st.delete(id)); }
};
async function fetchChunk(fileId, i, token) {
  const id = String(i).padStart(5, '0');
  if (token) {
    // Firestore REST: plain HTTPS, parallelisable, and much faster than the SDK's single channel.
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/files/${fileId}/chunks/${id}`;
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (r.ok) {
        const j = await r.json();
        const b64 = j.fields.data.bytesValue.replace(/-/g, '+').replace(/_/g, '/');
        return new Uint8Array(await (await fetch('data:application/octet-stream;base64,' + b64)).arrayBuffer());
      }
      console.warn('REST chunk fetch HTTP ' + r.status + ', falling back to SDK');
    } catch (e) { console.warn('REST chunk fetch failed, falling back to SDK', e); }
  }
  const snap = await getDoc(doc(db, 'files', fileId, 'chunks', id));
  if (!snap.exists()) throw new Error('Missing chunk ' + id);
  return snap.data().data.toUint8Array();
}
const inflight = new Map();
function loadFileBytes(fileId, onProgress) {
  if (inflight.has(fileId)) return inflight.get(fileId);
  const p = (async () => {
    const cached = await FileCache.get(fileId);
    if (cached) return { bytes: cached };
    const meta = (await getDoc(doc(db, 'files', fileId))).data();
    if (!meta) throw new Error('File record missing');
    let token = null; try { token = auth.currentUser && auth.currentUser.getIdToken ? await auth.currentUser.getIdToken() : null; } catch (e) {}
    const parts = new Array(meta.chunkCount); let done = 0, next = 0;
    onProgress && onProgress('Downloading slides… 0%');
    const worker = async () => { while (next < meta.chunkCount) { const i = next++; parts[i] = await fetchChunk(fileId, i, token); done++; onProgress && onProgress(`Downloading slides… ${Math.round(done / meta.chunkCount * 100)}%`); } };
    await Promise.all(Array.from({ length: Math.min(6, meta.chunkCount) }, worker));
    const out = new Uint8Array(meta.size); let off = 0;
    for (const arr of parts) { out.set(arr, off); off += arr.length; }
    FileCache.put(fileId, out);
    return { meta, bytes: out };
  })();
  inflight.set(fileId, p); p.finally(() => inflight.delete(fileId));
  return p;
}
/* Background prefetch so opening a block is instant on this device. */
let prefetching = false;
async function prefetchSlides(blocks) {
  if (prefetching) return; prefetching = true;
  const el = $('#prefetch-status');
  try {
    for (const b of blocks) {
      if (!b.fileId || await FileCache.has(b.fileId)) continue;
      if (el) { el.hidden = false; el.textContent = `Preparing “${b.title}” on this device…`; }
      try { await loadFileBytes(b.fileId, (t) => { if (el) el.textContent = `Preparing “${b.title}” on this device — ${t}`; }); }
      catch (e) { console.warn('prefetch', e); }
    }
    if (el) el.hidden = true;
  } finally { prefetching = false; }
}

/* ------------------------------------------------------------------ */
/* Viewer                                                              */
/* ------------------------------------------------------------------ */
const V = {}; // DOM refs, filled once
let renderSeq = 0, renderTask = null, blockRef = null, pageUnsub = null, presenceTimer = null, outOfSyncTimer = null;
const dimsCache = new Map(), thumbCache = new Map();
let thumbQueue = [], thumbBusy = false;

function initViewerDom() {
  Object.assign(V, {
    viewer: $('#viewer'), vtop: $('#vtop'), stage: $('#stage'), wrap: $('#pagewrap'), pdfc: $('#pdfc'), annc: $('#annc'), livec: $('#livec'), remotec: $('#remotec'),
    empty: $('#stage-empty'), loading: $('#stage-loading'), thumbs: $('#thumbs'), toolbar: $('#toolbar'), sync: $('#sync'),
    pagecnt: $('#pagecnt'), zoomLabel: $('#zoom-label'), width: $('#width'), widthPreview: $('#width-preview'), timer: $('#timer'), help: $('#help')
  });
  // Tools
  $$('[data-tool]', V.toolbar).forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  renderSwatches();
  V.width.addEventListener('input', () => setWidth(+V.width.value));
  $('#btn-undo').addEventListener('click', undo); $('#btn-redo').addEventListener('click', redo);
  $('#btn-annvis').addEventListener('click', toggleAnnVisible);
  $('#btn-clear').addEventListener('click', clearPage);
  $('#btn-zoom-in').addEventListener('click', () => zoomBy(1.25)); $('#btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
  V.zoomLabel.addEventListener('click', resetZoom);
  $('#btn-blank-before').addEventListener('click', () => insertBlank(0)); $('#btn-blank-after').addEventListener('click', () => insertBlank(1));
  $('#btn-finger').addEventListener('click', () => { setFingerDraws(!S.fingerDraws); toast(S.fingerDraws ? 'Finger draws (two fingers to pan/zoom)' : 'Finger pans; pencil/mouse draws'); });
  $('#btn-pencil').addEventListener('click', () => { setPencilOnly(!S.pencilOnly); toast(S.pencilOnly ? 'Pencil only: fingers and palm are ignored on the slide' : 'Fingers can pan and pinch-zoom again'); });
  initToolbarDrag();
  $('#btn-prev').addEventListener('click', () => navigate(S.pageIndex - 1)); $('#btn-next').addEventListener('click', () => navigate(S.pageIndex + 1));
  $('#btn-thumbs').addEventListener('click', toggleThumbs);
  $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
  $('#peek').addEventListener('click', () => { V.vtop.classList.toggle('peek'); });
  V.stage.addEventListener('pointerdown', () => { if (S.present) V.vtop.classList.remove('peek'); }, true);
  $('#btn-follow').addEventListener('click', () => { S.followSync = !S.followSync; $('#btn-follow').classList.toggle('active', S.followSync); toast(S.followSync ? 'View sync on: page, zoom and pan follow the other device' : 'View sync off — this device navigates independently'); sendPresence(); if (S.followSync && S.block) { S.lastViewAt = 0; applyRemoteView(S.block.view); } });
  $('#btn-upload').addEventListener('click', () => S.block && pickAndUpload(S.route.courseId, S.block));
  $('#btn-upload-2').addEventListener('click', () => S.block && pickAndUpload(S.route.courseId, S.block));
  $('#btn-help').addEventListener('click', () => { V.help.hidden = !V.help.hidden; }); $('#help-close').addEventListener('click', () => { V.help.hidden = true; });
  V.help.addEventListener('click', (e) => { if (e.target === V.help) V.help.hidden = true; });
  $('#btn-export').addEventListener('click', showExportMenu);
  V.sync.addEventListener('click', toggleSyncPop);
  initStageInput();
  initTimer();
  document.addEventListener('fullscreenchange', onFsChange); document.addEventListener('webkitfullscreenchange', onFsChange);
  window.addEventListener('resize', () => { if (S.route.view === 'viewer') scheduleRender(); });
  window.addEventListener('online', () => updateSyncUI()); window.addEventListener('offline', () => updateSyncUI());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sendPresence(); });
  try { const f = localStorage.getItem('teach_finger'), po = localStorage.getItem('teach_pencil_only'); if (f !== null) S.fingerDraws = f === '1'; if (po !== null) S.pencilOnly = po === '1'; } catch (e) {}
  $('#btn-finger').classList.toggle('active', S.fingerDraws); $('#btn-pencil').classList.toggle('active', S.pencilOnly);
}
function setPencilOnly(v) {
  S.pencilOnly = v; if (v) S.fingerDraws = false;
  $('#btn-pencil').classList.toggle('active', S.pencilOnly); $('#btn-finger').classList.toggle('active', S.fingerDraws);
  try { localStorage.setItem('teach_pencil_only', v ? '1' : '0'); localStorage.setItem('teach_finger', S.fingerDraws ? '1' : '0'); } catch (e) {}
}
function setFingerDraws(v) {
  S.fingerDraws = v; if (v) S.pencilOnly = false;
  $('#btn-pencil').classList.toggle('active', S.pencilOnly); $('#btn-finger').classList.toggle('active', S.fingerDraws);
  try { localStorage.setItem('teach_pencil_only', S.pencilOnly ? '1' : '0'); localStorage.setItem('teach_finger', v ? '1' : '0'); } catch (e) {}
}
/* Floating toolbar: collapsed to one icon on laptops, open on touch devices; draggable anywhere. */
const TB_KEY = 'teach_toolbar';
function initToolbarDrag() {
  const tb = V.toolbar, tg = $('#tb-toggle');
  const touch = navigator.maxTouchPoints > 1;
  let saved = null; try { saved = JSON.parse(localStorage.getItem(TB_KEY) || 'null'); } catch (e) {}
  tb.classList.toggle('collapsed', saved && typeof saved.collapsed === 'boolean' ? saved.collapsed : !touch);
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) placeToolbar(saved.x, saved.y);
  let drag = null;
  tg.addEventListener('pointerdown', (e) => {
    const r = tb.getBoundingClientRect(), vr = V.viewer.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, l: r.left - vr.left, t: r.top - vr.top, moved: false };
    try { tg.setPointerCapture(e.pointerId); } catch (ex) {}
  });
  tg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true; placeToolbar(drag.l + dx, drag.t + dy);
  });
  const end = (e) => {
    if (!drag) return; const moved = drag.moved; drag = null;
    if (!moved && e.type === 'pointerup') { tb.classList.toggle('collapsed'); clampToolbar(); }
    saveToolbar();
  };
  tg.addEventListener('pointerup', end); tg.addEventListener('pointercancel', end);
  window.addEventListener('resize', clampToolbar);
}
function placeToolbar(x, y) {
  const tb = V.toolbar; tb.classList.add('moved');
  const vw = V.viewer.clientWidth, vh = V.viewer.clientHeight;
  x = clamp(x, 0, Math.max(0, vw - tb.offsetWidth)); y = clamp(y, 0, Math.max(0, vh - tb.offsetHeight));
  tb.style.left = x + 'px'; tb.style.top = y + 'px';
}
function clampToolbar() { const tb = V.toolbar; if (tb.classList.contains('moved')) placeToolbar(parseFloat(tb.style.left) || 0, parseFloat(tb.style.top) || 0); }
function saveToolbar() {
  const tb = V.toolbar;
  const data = { collapsed: tb.classList.contains('collapsed') };
  if (tb.classList.contains('moved')) { data.x = parseFloat(tb.style.left) || 0; data.y = parseFloat(tb.style.top) || 0; }
  try { localStorage.setItem(TB_KEY, JSON.stringify(data)); } catch (e) {}
}
function renderSwatches() {
  const wrap = $('#swatches'); wrap.innerHTML = '';
  const cols = S.tool === 'hl' ? HL_COLORS : COLORS;
  cols.forEach((c, i) => {
    const b = document.createElement('button'); b.className = 'swatch' + (c === S.color ? ' active' : ''); b.style.background = c; b.title = `Colour ${i + 1}`;
    b.addEventListener('click', () => setColor(c)); wrap.appendChild(b);
  });
}
function setTool(t) {
  if (t === 'hl' && S.tool !== 'hl') { S.penColor = S.color; S.color = S.hlColor || HL_COLORS[0]; }
  if (t !== 'hl' && S.tool === 'hl') { S.hlColor = S.color; S.color = S.penColor || COLORS[0]; }
  S.tool = t;
  $$('[data-tool]', V.toolbar).forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  V.stage.dataset.tool = t;
  renderSwatches(); updateWidthPreview();
}
function setColor(c) { S.color = c; renderSwatches(); updateWidthPreview(); }
function setWidth(w) { S.width = clamp(w, 1, 12); V.width.value = S.width; updateWidthPreview(); }
function updateWidthPreview() { const px = 3 + S.width * 1.2; V.widthPreview.style.width = V.widthPreview.style.height = px + 'px'; V.widthPreview.style.background = S.color; V.widthPreview.style.opacity = S.tool === 'hl' ? 0.5 : 1; V.widthPreview.style.outline = S.color === '#ffffff' ? '1px solid #999' : ''; }

async function showViewer(courseId, blockId) {
  showView('viewer');
  if (!V.stage) initViewerDom();
  blockRef = doc(db, 'courses', courseId, 'blocks', blockId); const myRef = blockRef;
  S.block = null; S.pdf = null; S.pdfBytes = null; S.pdfFileId = null; S.pageIndex = 0; S.undo = []; S.redo = []; S.strokes = {}; S.strokesPageId = null;
  resetZoom(false);
  V.wrap.hidden = true; V.empty.hidden = true; V.thumbs.innerHTML = '';
  S.sync = 'connecting'; updateSyncUI();
  liveInkStart(blockId);
  let firstLoad = true, chain = Promise.resolve();
  const handle = async (snap) => {
    if (blockRef !== myRef) return;
    if (!snap.exists()) { toast('Block not found', 'err'); go('/c/' + courseId); return; }
    const prev = S.block; const b = { id: snap.id, ...snap.data() }; S.block = b;
    // sync status
    const st = snap.metadata.hasPendingWrites ? 'saving' : (snap.metadata.fromCache ? 'offline' : 'synced');
    if (st !== S.sync) { const was = S.sync; S.sync = st; updateSyncUI(); if (was === 'offline' && st === 'synced') toast('Reconnected — devices are in sync again', 'ok'); }
    else updateSyncUI();
    $('#v-title').textContent = b.title || 'Untitled'; $('#v-label').textContent = b.label || '';
    document.title = (b.title || 'Teaching') + (b.label ? ' · ' + b.label : '');
    // file
    if (b.fileId !== S.pdfFileId) await loadBlockPdf(b.fileId);
    const pagesChanged = !prev || JSON.stringify((prev.pages || []).map(p => p.id)) !== JSON.stringify((b.pages || []).map(p => p.id));
    // follow remote navigation
    const pages = b.pages || [];
    let targetIdx = S.pageIndex;
    if (b.currentPageId && (S.followSync || firstLoad)) {
      const idx = pages.findIndex(p => p.id === b.currentPageId);
      if (idx >= 0 && (!prev || prev.currentPageId !== b.currentPageId || firstLoad)) targetIdx = idx;
    }
    if (prev && prev.currentPageId !== b.currentPageId) S.lastNavAt = Date.now();
    targetIdx = clamp(targetIdx, 0, Math.max(0, pages.length - 1));
    const idxChanged = targetIdx !== S.pageIndex || firstLoad;
    S.pageIndex = targetIdx;
    if (pagesChanged) renderThumbs();
    if (idxChanged || pagesChanged) { await onPageChanged(); }
    applyRemoteView(b.view);
    updateThumbActive(); updatePager();
    if (firstLoad) { firstLoad = false; sendPresence(); }
    checkOutOfSync();
  };
  const unsub = onSnapshot(blockRef, { includeMetadataChanges: true }, (snap) => { chain = chain.then(() => handle(snap)).catch(e => console.error('block snapshot', e)); },
    (err) => { toast('Sync error: ' + err.message, 'err'); S.sync = 'offline'; updateSyncUI(); });
  S.unsubs.push(unsub);
  presenceTimer = setInterval(sendPresence, 20000);
  outOfSyncTimer = setInterval(checkOutOfSync, 3000);
  S.unsubs.push(() => { clearInterval(presenceTimer); clearInterval(outOfSyncTimer); });
}
function leaveViewer() {
  if (pageUnsub) { pageUnsub(); pageUnsub = null; }
  if (S.present) exitPresent();
  if (S.block && blockRef) updateDoc(blockRef, { ['presence.' + DEVICE_ID]: deleteField() }).catch(() => {});
  if (S.pdf) { try { S.pdf.destroy(); } catch (e) {} }
  S.pdf = null; S.pdfBytes = null; S.block = null; blockRef = null; dimsCache.clear();
  document.title = 'Teaching';
}
async function loadBlockPdf(fileId) {
  if (S.pdf) { try { S.pdf.destroy(); } catch (e) {} S.pdf = null; }
  S.pdfBytes = null; S.pdfFileId = fileId; dimsCache.clear(); thumbCache.clear();
  if (!fileId) return;
  V.loading.hidden = false; V.loading.textContent = 'Loading slides…';
  try {
    const { bytes } = await loadFileBytes(fileId, (t) => { V.loading.textContent = t; });
    S.pdfBytes = bytes;
    S.pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  } catch (e) { console.error(e); toast('Could not load slides: ' + e.message, 'err', 5000); }
  finally { V.loading.hidden = true; }
}
const currentPage = () => (S.block && S.block.pages || [])[S.pageIndex] || null;
function pageCount() { return (S.block && S.block.pages || []).length; }
function updatePager() { V.pagecnt.textContent = pageCount() ? `${S.pageIndex + 1} / ${pageCount()}` : '0 / 0'; }

async function pageDims(p) {
  if (p.type === 'pdf' && S.pdf) {
    if (!dimsCache.has(p.src)) { const pg = await S.pdf.getPage(p.src + 1); const vp = pg.getViewport({ scale: 1 }); dimsCache.set(p.src, { w: vp.width, h: vp.height, page: pg }); }
    return dimsCache.get(p.src);
  }
  const asp = (S.block && S.block.pageAspect) || 16 / 9;
  return { w: 960, h: 960 / asp };
}

/* Navigation */
async function navigate(idx, opts = {}) {
  const n = pageCount(); if (!n) return;
  idx = clamp(idx, 0, n - 1);
  if (idx === S.pageIndex && !opts.force) return;
  S.pageIndex = idx; S.lastNavAt = Date.now();
  updateThumbActive(); updatePager();
  await onPageChanged();
  const p = currentPage();
  if (S.followSync && p && blockRef) { const at = Date.now(); S.lastViewAt = at; S.lastWrittenView = { z: 1, x: 0, y: 0 }; updateDoc(blockRef, { currentPageId: p.id, live: { at, by: DEVICE_ID }, view: { z: 1, x: 0, y: 0, by: DEVICE_ID, at } }).catch(() => {}); }
  sendPresence();
}
async function onPageChanged() {
  resetZoom(false);
  subscribePageStrokes();
  await renderPage();
  V.empty.hidden = pageCount() > 0; V.wrap.hidden = pageCount() === 0;
}

/* Rendering */
const scheduleRender = debounce(() => renderPage(), 120);
async function renderPage() {
  const p = currentPage(); const seq = ++renderSeq;
  if (!p) { V.wrap.hidden = true; V.empty.hidden = false; return; }
  V.empty.hidden = true; V.wrap.hidden = false;
  const dims = await pageDims(p); if (seq !== renderSeq) return;
  const stageW = V.stage.clientWidth, stageH = V.stage.clientHeight;
  const fit = Math.min(stageW / dims.w, stageH / dims.h) * 0.96;
  const cssW = dims.w * fit, cssH = dims.h * fit;
  V.wrap.style.width = cssW + 'px'; V.wrap.style.height = cssH + 'px';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let scale = dpr * S.renderQuality;
  const MAX_PX = 5e6; if (cssW * cssH * scale * scale > MAX_PX) scale = Math.sqrt(MAX_PX / (cssW * cssH));
  const pxW = Math.round(cssW * scale), pxH = Math.round(cssH * scale);
  [V.pdfc, V.annc, V.livec, V.remotec].forEach(c => { if (c.width !== pxW || c.height !== pxH) { c.width = pxW; c.height = pxH; } });
  const ctx = V.pdfc.getContext('2d');
  if (p.type === 'pdf' && S.pdf && dims.page) {
    if (renderTask) { try { renderTask.cancel(); } catch (e) {} }
    const vp = dims.page.getViewport({ scale: fit * scale });
    renderTask = dims.page.render({ canvasContext: ctx, viewport: vp });
    try { await renderTask.promise; } catch (e) { if (e && e.name !== 'RenderingCancelledException') console.warn(e); }
    renderTask = null;
  } else {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pxW, pxH);
  }
  if (seq !== renderSeq) return;
  drawAnnotations();
  drawRemoteLive();
  applyTransform();
}
function drawAnnotations() {
  const c = V.annc, ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  drawStrokes(ctx, c.width, c.height, Object.values(S.strokes));
  if (Object.keys(remoteLive).length || Object.keys(liveGhosts).length) drawRemoteLive();
}
function drawStrokes(ctx, W, H, strokes) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of strokes) { drawStroke(ctx, W, H, s); }
  ctx.globalAlpha = 1;
}
function drawStroke(ctx, W, H, s) {
  const pts = s.p; if (!pts || pts.length < 2) return;
  ctx.strokeStyle = s.c; ctx.lineWidth = Math.max(1, s.w / 1000 * W); ctx.globalAlpha = s.t === 'hl' ? 0.4 : 1;
  ctx.lineCap = s.t === 'hl' ? 'butt' : 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (pts.length === 2) { ctx.moveTo(pts[0] * W, pts[1] * H); ctx.lineTo(pts[0] * W + 0.1, pts[1] * H); ctx.stroke(); return; }
  ctx.moveTo(pts[0] * W, pts[1] * H);
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = (pts[i] + pts[i + 2]) / 2 * W, my = (pts[i + 1] + pts[i + 3]) / 2 * H;
    ctx.quadraticCurveTo(pts[i] * W, pts[i + 1] * H, mx, my);
  }
  ctx.lineTo(pts[pts.length - 2] * W, pts[pts.length - 1] * H);
  ctx.stroke();
}

/* Live ink: stream the stroke being drawn to the other device via Realtime Database.
   Entry: live/{blockId}/{deviceId} = { pageId, s: stroke, at, done }.
   The receiver draws it on the remote canvas until the same stroke id arrives from Firestore. */
let myLiveRef = null, remoteLive = {}, liveGhosts = {}, lastLiveSend = 0, liveSendTimer = null;
function liveInkStart(blockId) {
  remoteLive = {}; liveGhosts = {};
  if (!rtdb) return;
  const base = rtRef(rtdb, 'live/' + blockId);
  myLiveRef = rtRef(rtdb, 'live/' + blockId + '/' + DEVICE_ID);
  try { onDisconnect(myLiveRef).remove(); } catch (e) {}
  const unsub = onValue(base, (snap) => {
    const val = snap.val() || {}; const now = Date.now();
    for (const [dev, entry] of Object.entries(remoteLive)) {
      if (!val[dev] && entry.done && entry.s) liveGhosts[entry.s.id] = { ...entry, until: now + 4000 };
    }
    remoteLive = {}; for (const [dev, entry] of Object.entries(val)) if (dev !== DEVICE_ID && entry && entry.s) remoteLive[dev] = entry;
    drawRemoteLive();
  }, (err) => console.warn('live ink', err));
  S.unsubs.push(() => { unsub(); if (myLiveRef) rtRemove(myLiveRef).catch(() => {}); myLiveRef = null; remoteLive = {}; liveGhosts = {}; });
}
function liveInkSend(stroke, done) {
  if (!myLiveRef || !S.strokesPageId) return;
  const now = Date.now();
  const send = () => { lastLiveSend = Date.now(); const { ptr, ...clean } = stroke; rtSet(myLiveRef, { pageId: S.strokesPageId, s: clean, at: Date.now(), done: !!done }).catch(() => {}); };
  clearTimeout(liveSendTimer);
  if (done || now - lastLiveSend >= 40) send(); else liveSendTimer = setTimeout(send, 40 - (now - lastLiveSend));
}
function liveInkClear() { clearTimeout(liveSendTimer); if (myLiveRef) rtRemove(myLiveRef).catch(() => {}); }
function drawRemoteLive() {
  const c = V.remotec; if (!c) return; const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const now = Date.now(); const cur = S.strokesPageId; const list = [];
  for (const e of Object.values(remoteLive)) if (e.pageId === cur && e.s && !S.strokes[e.s.id]) list.push(e.s);
  for (const [id, g] of Object.entries(liveGhosts)) { if (g.until < now || S.strokes[id]) delete liveGhosts[id]; else if (g.pageId === cur) list.push(g.s); }
  if (list.length) drawStrokes(ctx, c.width, c.height, list);
  if (Object.keys(liveGhosts).length) setTimeout(drawRemoteLive, 1000);
}

/* Zoom / pan */
function applyTransform() {
  if (S.zoom <= 1.001) { S.zoom = 1; S.panX = 0; S.panY = 0; }
  else {
    const lim = (S.zoom - 1) / 2; const w = V.wrap.clientWidth, h = V.wrap.clientHeight;
    S.panX = clamp(S.panX, -lim * w - w * 0.25, lim * w + w * 0.25); S.panY = clamp(S.panY, -lim * h - h * 0.25, lim * h + h * 0.25);
  }
  V.wrap.style.transform = `translate(${S.panX}px, ${S.panY}px) scale(${S.zoom})`;
  V.zoomLabel.textContent = Math.round(S.zoom * 100) + '%';
  if (!S.applyingRemoteView) scheduleViewWrite();
  const q = S.zoom <= 1.05 ? 1 : S.zoom <= 2.2 ? 2 : 3;
  if (q !== S.renderQuality) { S.renderQuality = q; scheduleRender(); }
}
/* Share zoom/pan with the other device (normalised to page size so screen sizes may differ). */
let viewWriteTimer = null;
function currentView() { const w = V.wrap.clientWidth || 1, h = V.wrap.clientHeight || 1; return { z: Math.round(S.zoom * 1000) / 1000, x: Math.round(S.panX / w * 10000) / 10000, y: Math.round(S.panY / h * 10000) / 10000 }; }
function scheduleViewWrite() {
  if (!S.followSync || !blockRef || !S.block) return;
  clearTimeout(viewWriteTimer);
  viewWriteTimer = setTimeout(() => {
    const v = currentView(); const lw = S.lastWrittenView;
    if (lw && lw.z === v.z && lw.x === v.x && lw.y === v.y) return;
    S.lastWrittenView = v; const at = Date.now(); S.lastViewAt = at;
    updateDoc(blockRef, { view: { ...v, by: DEVICE_ID, at } }).catch(() => {});
  }, 120);
}
function applyRemoteView(v) {
  if (!v || v.by === DEVICE_ID || !S.followSync || !(v.at > S.lastViewAt)) return;
  S.lastViewAt = v.at; S.lastWrittenView = { z: v.z, x: v.x, y: v.y };
  const w = V.wrap.clientWidth || 1, h = V.wrap.clientHeight || 1;
  S.zoom = clamp(v.z || 1, 1, 8); S.panX = (v.x || 0) * w; S.panY = (v.y || 0) * h;
  S.applyingRemoteView = true; try { applyTransform(); } finally { S.applyingRemoteView = false; }
}
function zoomAt(cx, cy, factor) {
  const r = V.stage.getBoundingClientRect();
  const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
  const nz = clamp(S.zoom * factor, 1, 8); const k = nz / S.zoom;
  S.panX = px - (px - S.panX) * k; S.panY = py - (py - S.panY) * k; S.zoom = nz;
  applyTransform();
}
function zoomBy(f) { const r = V.stage.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); }
function resetZoom(apply = true) { S.zoom = 1; S.panX = 0; S.panY = 0; if (apply && V.wrap) applyTransform(); }

/* Stage input: pen / eraser / pan / pinch */
function initStageInput() {
  const st = V.stage;
  const ptrs = new Map(); // touch pointers for pan/pinch
  let stroke = null, erasing = null, pinch = null, pan = null, lastTap = 0, lastPenAt = 0;
  // A finger/palm touch is ignored when Pencil-only is on, while a pen stroke is in progress,
  // or shortly after the pen was last seen (the palm usually lands just before/after the tip).
  const touchBlocked = (e) => e.pointerType === 'touch' && (!!stroke || !!erasing || (S.tool !== 'pointer' && (S.pencilOnly || Date.now() - lastPenAt < 1500)));
  const dropTouches = () => { ptrs.clear(); pinch = null; pan = null; st.classList.remove('panning'); };
  const norm = (e) => { const r = V.annc.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const wantsDraw = (e) => {
    if (!currentPage() || S.tool === 'pointer') return false;
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'mouse') return e.button === 0 && !e.altKey;
    return S.fingerDraws && ptrs.size === 0;
  };
  st.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    V.help.hidden = true; closeMenus();
    if (e.pointerType === 'pen') { lastPenAt = Date.now(); dropTouches(); }
    if (touchBlocked(e)) return;
    if (wantsDraw(e)) {
      try { st.setPointerCapture(e.pointerId); } catch (ex) {}
      const [x, y] = norm(e);
      if (S.tool === 'eraser') { erasing = { removed: {} }; eraseAt(x, y, erasing); return; }
      stroke = { id: uid(), t: S.tool, c: S.color, w: S.tool === 'hl' ? S.width * 4 : S.width, p: [r4(x), r4(y)], ptr: e.pointerId };
      liveBegin(stroke); liveInkSend(stroke); return;
    }
    // pan / pinch / double-tap zoom
    try { st.setPointerCapture(e.pointerId); } catch (ex) {}
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const [a, b] = Array.from(ptrs.values());
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: S.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, px: S.panX, py: S.panY };
      pan = null; if (stroke) { stroke = null; liveClear(); }
    } else if (ptrs.size === 1) {
      pan = { x: e.clientX, y: e.clientY, px: S.panX, py: S.panY, moved: false };
      const now = Date.now();
      if (now - lastTap < 320 && e.pointerType !== 'mouse') { if (S.zoom > 1) resetZoom(); else zoomAt(e.clientX, e.clientY, 2); lastTap = 0; }
      else lastTap = now;
      st.classList.add('panning');
    }
  });
  st.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'pen') lastPenAt = Date.now();
    if (stroke && e.pointerId === stroke.ptr) {
      let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : []; if (!evs || !evs.length) evs = [e];
      for (const ev of evs) { const [x, y] = norm(ev); addPoint(stroke, x, y); }
      liveDraw(stroke); liveInkSend(stroke); return;
    }
    if (erasing) { const [x, y] = norm(e); eraseAt(x, y, erasing); return; }
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && ptrs.size === 2) {
      const [a, b] = Array.from(ptrs.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y); const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const nz = clamp(pinch.z0 * d / pinch.d0, 1, 8);
      const r = V.stage.getBoundingClientRect(); const cx = pinch.mx - (r.left + r.width / 2), cy = pinch.my - (r.top + r.height / 2);
      const k = nz / pinch.z0;
      S.panX = cx - (cx - pinch.px) * k + (mx - pinch.mx); S.panY = cy - (cy - pinch.py) * k + (my - pinch.my); S.zoom = nz;
      applyTransform();
    } else if (pan && ptrs.size === 1) {
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true;
      if (S.zoom > 1) { S.panX = pan.px + dx; S.panY = pan.py + dy; applyTransform(); }
    }
  });
  const end = (e) => {
    if (e.pointerType === 'pen') lastPenAt = Date.now();
    if (stroke && e.pointerId === stroke.ptr) { const s = stroke; stroke = null; liveClear(); liveInkSend(s, true); commitStroke(s); return; }
    if (erasing) { const ids = Object.keys(erasing.removed); if (ids.length) pushOp({ kind: 'remove', pageId: S.strokesPageId, strokes: erasing.removed }); erasing = null; return; }
    if (ptrs.has(e.pointerId)) {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (ptrs.size === 0) { st.classList.remove('panning'); pan = null; }
      else if (ptrs.size === 1) { const [p] = Array.from(ptrs.values()); pan = { x: p.x, y: p.y, px: S.panX, py: S.panY, moved: true }; }
    }
  };
  st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
  st.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01)); }
    else if (S.zoom > 1) { S.panX -= e.deltaX; S.panY -= e.deltaY; applyTransform(); }
  }, { passive: false });
  st.addEventListener('dblclick', (e) => { if (S.zoom > 1) resetZoom(); else zoomAt(e.clientX, e.clientY, 2); });
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  st.addEventListener('contextmenu', (e) => e.preventDefault());
  // iOS Safari: block native pinch-zoom, double-tap zoom, text selection and the long-press callout
  // while the viewer is open. Pointer events above still receive everything they need.
  const inViewer = () => S.route.view === 'viewer';
  document.addEventListener('touchmove', (e) => { if (inViewer() && (e.touches.length > 1 || e.target.closest('#stage'))) e.preventDefault(); }, { passive: false });
  const INTERACTIVE = 'button, input, select, textarea, a, label, .thumb, .swatch, .sync, .sync-pop, .zoom-label, .help, .menu, .modal';
  const guard = (e) => { if (inViewer() && !e.target.closest(INTERACTIVE)) e.preventDefault(); };
  document.addEventListener('touchstart', guard, { passive: false });
  document.addEventListener('touchend', guard, { passive: false });
  document.addEventListener('selectstart', (e) => { if (inViewer() && !e.target.closest('input')) e.preventDefault(); });
}
const r4 = (v) => Math.round(v * 10000) / 10000;
function addPoint(s, x, y) {
  const n = s.p.length; const lx = s.p[n - 2], ly = s.p[n - 1];
  if (Math.hypot(x - lx, y - ly) < 0.0012) return;
  s.p.push(r4(x), r4(y));
}
/* Live stroke: drawn incrementally (only the newest segment each event) so long strokes stay
   responsive. Highlighter transparency is applied to the canvas element, not per segment, so
   overlapping segments do not darken. */
let live = { drawn: 0, ctx: null };
function liveCtx() { if (!live.ctx) live.ctx = V.livec.getContext('2d', { desynchronized: true }) || V.livec.getContext('2d'); return live.ctx; }
function liveBegin(s) {
  const c = V.livec, ctx = liveCtx();
  ctx.clearRect(0, 0, c.width, c.height);
  c.style.opacity = s.t === 'hl' ? 0.4 : 1;
  ctx.strokeStyle = s.c; ctx.fillStyle = s.c; ctx.lineWidth = Math.max(1, s.w / 1000 * c.width);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = 1;
  // starting dot
  ctx.beginPath(); ctx.arc(s.p[0] * c.width, s.p[1] * c.height, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
  live.drawn = 1;
}
function liveDraw(s) {
  const c = V.livec, ctx = liveCtx(), W = c.width, H = c.height, p = s.p, n = p.length / 2;
  if (live.drawn < 1) return;
  while (live.drawn < n) {
    const i = live.drawn; // index of the newest point
    const px = p[2 * i - 2] * W, py = p[2 * i - 1] * H, x = p[2 * i] * W, y = p[2 * i + 1] * H;
    const mx = (px + x) / 2, my = (py + y) / 2;
    ctx.beginPath();
    if (i === 1) { ctx.moveTo(px, py); ctx.lineTo(mx, my); }
    else { const qx = p[2 * i - 4] * W, qy = p[2 * i - 3] * H; ctx.moveTo((qx + px) / 2, (qy + py) / 2); ctx.quadraticCurveTo(px, py, mx, my); }
    ctx.stroke();
    live.drawn++;
  }
}
function liveClear() { const c = V.livec; liveCtx().clearRect(0, 0, c.width, c.height); c.style.opacity = 1; live.drawn = 0; }
function eraseAt(x, y, sess) {
  const p = currentPage(); if (!p) return;
  const asp = V.annc.height / V.annc.width; // y scale relative to x units
  const R = 0.012;
  for (const [id, s] of Object.entries(S.strokes)) {
    if (sess.removed[id]) continue;
    if (hitStroke(s, x, y * asp, asp, R + s.w / 2000)) {
      sess.removed[id] = s; delete S.strokes[id]; drawAnnotations();
      setDoc(pageRef(S.strokesPageId), { strokes: { [id]: deleteField() } }, { merge: true }).catch(() => {});
    }
  }
}
function hitStroke(s, x, y, asp, r) {
  const p = s.p;
  if (p.length === 2) return Math.hypot(p[0] - x, p[1] * asp - y) < r;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1] * asp, bx = p[i + 2], by = p[i + 3] * asp;
    const dx = bx - ax, dy = by - ay; const L = dx * dx + dy * dy;
    const t = L ? clamp(((x - ax) * dx + (y - ay) * dy) / L, 0, 1) : 0;
    if (Math.hypot(ax + t * dx - x, ay + t * dy - y) < r) return true;
  }
  return false;
}

/* Annotation persistence: courses/{c}/blocks/{b}/pages/{pageId} { strokes: {id: stroke} } */
function pageRef(pageId) { return doc(blockRef, 'pages', pageId); }
function subscribePageStrokes() {
  const p = currentPage();
  if (pageUnsub) { pageUnsub(); pageUnsub = null; }
  S.strokes = {}; S.strokesPageId = p ? p.id : null;
  if (!p) return;
  pageUnsub = onSnapshot(pageRef(p.id), (snap) => {
    if (S.strokesPageId !== p.id) return;
    S.strokes = (snap.exists() && snap.data().strokes) || {};
    drawAnnotations();
  }, (err) => console.warn('page strokes', err));
}
function commitStroke(s) {
  if (!S.strokesPageId) return;
  const { ptr, ...clean } = s;
  S.strokes[clean.id] = clean; drawAnnotations();
  setDoc(pageRef(S.strokesPageId), { strokes: { [clean.id]: clean } }, { merge: true }).then(liveInkClear).catch(e => toast('Save failed: ' + e.message, 'err'));
  pushOp({ kind: 'add', pageId: S.strokesPageId, strokes: { [clean.id]: clean } });
}
function pushOp(op) { S.undo.push(op); if (S.undo.length > 200) S.undo.shift(); S.redo = []; updateUndoButtons(); }
function applyOp(op, inverse) {
  const add = (op.kind === 'add') !== inverse;   // add ⇒ write strokes; remove ⇒ delete
  const payload = {};
  for (const [id, s] of Object.entries(op.strokes)) {
    payload[id] = add ? s : deleteField();
    if (op.pageId === S.strokesPageId) { if (add) S.strokes[id] = s; else delete S.strokes[id]; }
  }
  if (op.pageId === S.strokesPageId) drawAnnotations();
  return setDoc(pageRef(op.pageId), { strokes: payload }, { merge: true }).catch(e => toast('Save failed: ' + e.message, 'err'));
}
function undo() { const op = S.undo.pop(); if (!op) return; applyOp(op, true); S.redo.push(op); updateUndoButtons(); }
function redo() { const op = S.redo.pop(); if (!op) return; applyOp(op, false); S.undo.push(op); updateUndoButtons(); }
function updateUndoButtons() { $('#btn-undo').disabled = !S.undo.length; $('#btn-redo').disabled = !S.redo.length; }
function clearPage() {
  if (!S.strokesPageId || !Object.keys(S.strokes).length) return;
  if (!confirm('Clear all annotations on this page? (Undo is available.)')) return;
  const all = { ...S.strokes };
  pushOp({ kind: 'remove', pageId: S.strokesPageId, strokes: all });
  S.strokes = {}; drawAnnotations();
  setDoc(pageRef(S.strokesPageId), { strokes: {} }).catch(e => toast('Save failed: ' + e.message, 'err'));
}
function toggleAnnVisible() { S.annVisible = !S.annVisible; V.annc.classList.toggle('hidden', !S.annVisible); $('#btn-annvis').classList.toggle('active', !S.annVisible); toast(S.annVisible ? 'Annotations shown' : 'Annotations hidden (still saved)'); }

/* Blank pages */
async function insertBlank(offset) {
  if (!S.block) return;
  const pages = (S.block.pages || []).slice();
  const at = pages.length ? S.pageIndex + offset : 0;
  const np = { id: uid(), type: 'blank' };
  pages.splice(at, 0, np);
  S.block.pages = pages; S.pageIndex = at;
  renderThumbs(); await onPageChanged(); updatePager(); updateThumbActive();
  await updateDoc(blockRef, { pages, currentPageId: np.id, live: { at: Date.now(), by: DEVICE_ID } });
  toast('Blank page inserted');
}
async function deletePage(pageId) {
  const pages = (S.block.pages || []).filter(p => p.id !== pageId);
  if (!confirm('Delete this blank page and its annotations?')) return;
  const idx = clamp(S.pageIndex, 0, Math.max(0, pages.length - 1));
  const cur = pages[idx] ? pages[idx].id : null;
  await updateDoc(blockRef, { pages, currentPageId: cur });
  deleteDoc(pageRef(pageId)).catch(() => {});
}

/* Thumbnails */
function renderThumbs() {
  const pages = S.block ? S.block.pages || [] : [];
  V.thumbs.innerHTML = '';
  thumbQueue = [];
  pages.forEach((p, i) => {
    const t = document.createElement('div'); t.className = 'thumb'; t.dataset.id = p.id;
    const pic = document.createElement('div'); pic.className = 'pic';
    if (S.block.pageAspect) pic.style.aspectRatio = String(S.block.pageAspect);
    const num = document.createElement('div'); num.className = 'num';
    num.innerHTML = `<span>${i + 1}</span>`;
    if (p.type === 'blank') {
      const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'blank';
      const del = document.createElement('button'); del.className = 'del'; del.textContent = '×'; del.title = 'Delete blank page';
      del.addEventListener('click', (e) => { e.stopPropagation(); deletePage(p.id); });
      num.appendChild(badge); num.appendChild(del);
    } else {
      const key = S.pdfFileId + ':' + p.src;
      if (thumbCache.has(key)) { const img = new Image(); img.src = thumbCache.get(key); pic.appendChild(img); }
      else thumbQueue.push({ pic, src: p.src, key });
    }
    t.appendChild(pic); t.appendChild(num);
    t.addEventListener('click', () => navigate(i));
    V.thumbs.appendChild(t);
  });
  updateThumbActive();
  pumpThumbs();
}
async function pumpThumbs() {
  if (thumbBusy) return; thumbBusy = true;
  try {
    while (thumbQueue.length && S.pdf) {
      // Render pages nearest to the current one first
      thumbQueue.sort((a, b) => Math.abs(a.src - S.pageIndex) - Math.abs(b.src - S.pageIndex));
      const job = thumbQueue.shift();
      if (!job.pic.isConnected) continue;
      try {
        const pg = await S.pdf.getPage(job.src + 1);
        const vp0 = pg.getViewport({ scale: 1 }); const scale = 220 / vp0.width; const vp = pg.getViewport({ scale });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        const url = c.toDataURL('image/jpeg', 0.7); thumbCache.set(job.key, url);
        if (job.pic.isConnected) { const img = new Image(); img.src = url; job.pic.appendChild(img); }
      } catch (e) { console.warn('thumb', e); }
    }
  } finally { thumbBusy = false; }
}
function updateThumbActive() {
  const p = currentPage();
  $$('.thumb', V.thumbs).forEach(t => t.classList.toggle('active', !!p && t.dataset.id === p.id));
  const act = $('.thumb.active', V.thumbs); if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
}
function toggleThumbs() { V.thumbs.classList.toggle('collapsed'); $('#btn-thumbs').classList.toggle('active', !V.thumbs.classList.contains('collapsed')); scheduleRender(); }

/* Presence / sync status */
function sendPresence() {
  if (!blockRef || !S.block) return;
  const p = currentPage();
  updateDoc(blockRef, { ['presence.' + DEVICE_ID]: { name: DEVICE_NAME, pageId: p ? p.id : null, at: Date.now(), follow: S.followSync } }).catch(() => {});
}
function otherDevices() {
  const pr = (S.block && S.block.presence) || {}; const now = Date.now();
  return Object.entries(pr).filter(([id, d]) => id !== DEVICE_ID && d && now - (d.at || 0) < 70000).map(([id, d]) => ({ id, ...d }));
}
function checkOutOfSync() {
  if (!S.block) return;
  const cur = currentPage(); const others = otherDevices();
  const stale = others.filter(d => d.follow !== false && S.followSync && cur && d.pageId !== cur.id && Date.now() - S.lastNavAt > 6000 && Date.now() - (d.at || 0) < 40000);
  V.sync.classList.toggle('warn', stale.length > 0 || S.sync === 'offline');
  updateSyncUI(stale);
}
function updateSyncUI(stale) {
  const el = V.sync; if (!el) return;
  let state = S.sync;
  if (!navigator.onLine && state !== 'saving') state = 'offline';
  el.dataset.state = state;
  const others = otherDevices();
  const cur = currentPage();
  stale = stale || [];
  let txt = state === 'synced' ? 'Synced' : state === 'saving' ? 'Saving…' : state === 'offline' ? 'Offline – reconnecting' : 'Connecting…';
  if (stale.length) { const d = stale[0]; const idx = (S.block.pages || []).findIndex(p => p.id === d.pageId); txt = `${d.name} is on page ${idx + 1 || '?'} — out of sync`; }
  else if (others.length && state === 'synced') txt = `Synced · ${others.map(o => o.name).join(', ')} connected`;
  $('.txt', el).textContent = txt;
  el.title = 'Sync status. Click for details.';
  const pop = $('.sync-pop', V.viewer); if (pop) fillSyncPop(pop);
}
function toggleSyncPop() {
  let pop = $('.sync-pop', V.viewer);
  if (pop) { pop.remove(); return; }
  pop = document.createElement('div'); pop.className = 'sync-pop'; fillSyncPop(pop); V.viewer.appendChild(pop);
  setTimeout(() => document.addEventListener('pointerdown', function h(e) { if (!pop.contains(e.target) && e.target !== V.sync) { pop.remove(); document.removeEventListener('pointerdown', h); } }), 0);
}
function fillSyncPop(pop) {
  const cur = currentPage(); const pages = (S.block && S.block.pages) || [];
  const rows = [`<div><b>This device</b> (${DEVICE_NAME}) · page ${cur ? pages.indexOf(cur) + 1 : '–'} · ${S.followSync ? 'following' : 'independent'}</div>`];
  for (const d of otherDevices()) rows.push(`<div><b>${d.name}</b> · page ${pages.findIndex(p => p.id === d.pageId) + 1 || '–'} · ${d.follow === false ? 'independent' : 'following'} · seen ${Math.round((Date.now() - d.at) / 1000)}s ago</div>`);
  if (rows.length === 1) rows.push('<div class="muted">No other device connected.</div>');
  rows.push(`<div class="muted" style="margin-top:6px">Live ink: ${rtdb ? 'on' : 'off (Realtime Database not configured — see SETUP.md)'}</div>`);
  rows.push(`<div class="muted" style="margin-top:6px">Status: ${S.sync}${navigator.onLine ? '' : ' (browser offline)'}. Changes made offline are queued and sent automatically when the connection returns.</div>`);
  pop.innerHTML = rows.join('');
}

/* Fullscreen / presentation mode */
function toggleFullscreen() { if (S.present) exitPresent(); else enterPresent(); }
async function enterPresent() {
  const el = document.documentElement;
  // Touch devices (iPad) get the CSS-only presentation layout: Safari's element fullscreen is exited by
  // some swipes, which interrupts page panning. Only the projected laptop needs true fullscreen.
  if (navigator.maxTouchPoints <= 1) {
    try { if (el.requestFullscreen) await el.requestFullscreen(); else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen(); } catch (e) { /* fall back to CSS-only presentation mode */ }
  }
  S.present = true; V.viewer.classList.add('present'); V.vtop.classList.remove('peek'); $('#btn-fullscreen').classList.add('active');
  if (!V.thumbs.classList.contains('collapsed')) { V.thumbs.classList.add('collapsed'); S.thumbsWereOpen = true; } else S.thumbsWereOpen = false;
  scheduleRender();
}
function exitPresent() {
  S.present = false; V.viewer.classList.remove('present'); $('#btn-fullscreen').classList.remove('active');
  if (S.thumbsWereOpen) V.thumbs.classList.remove('collapsed');
  if (document.fullscreenElement || document.webkitFullscreenElement) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {} }
  scheduleRender();
}
function onFsChange() { if (!(document.fullscreenElement || document.webkitFullscreenElement) && S.present) exitPresent(); }

/* Keyboard shortcuts */
document.addEventListener('keydown', (e) => {
  if (S.route.view !== 'viewer' || !S.block) return;
  if (isEditing()) return;
  const k = e.key, meta = e.metaKey || e.ctrlKey;
  if (meta && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (meta && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (meta) return;
  switch (k) {
    case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'Enter': e.preventDefault(); navigate(S.pageIndex + 1); break;
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace': e.preventDefault(); navigate(S.pageIndex - 1); break;
    case 'Home': e.preventDefault(); navigate(0); break;
    case 'End': e.preventDefault(); navigate(pageCount() - 1); break;
    case 'p': case 'P': setTool('pen'); break;
    case 'h': case 'H': setTool('hl'); break;
    case 'e': case 'E': setTool('eraser'); break;
    case 'v': case 'V': setTool('pointer'); break;
    case 'a': case 'A': toggleAnnVisible(); break;
    case 'n': insertBlank(1); break;
    case 'N': insertBlank(0); break;
    case '[': setWidth(S.width - 1); break;
    case ']': setWidth(S.width + 1); break;
    case '+': case '=': zoomBy(1.25); break;
    case '-': case '_': zoomBy(0.8); break;
    case '0': resetZoom(); break;
    case 's': case 'S': toggleThumbs(); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 't': case 'T': toggleTimer(); break;
    case 'd': case 'D': toggleTheme(); break;
    case '?': V.help.hidden = !V.help.hidden; break;
    case 'Escape':
      if (!V.help.hidden) V.help.hidden = true; else if ($('.menu')) closeMenus(); else if (S.zoom > 1) resetZoom(); else if (S.present) exitPresent();
      break;
    default:
      if (/^[1-6]$/.test(k)) setColor((S.tool === 'hl' ? HL_COLORS : COLORS)[+k - 1]);
  }
});

/* ------------------------------------------------------------------ */
/* Timer                                                               */
/* ------------------------------------------------------------------ */
const T = { mode: 'down', running: false, total: 300000, remaining: 300000, elapsed: 0, lastTick: 0, raf: null, audio: null };
function initTimer() {
  const el = V.timer;
  $('#timer-close').addEventListener('click', toggleTimer);
  $('#timer-big').addEventListener('click', () => el.classList.toggle('big'));
  $('#timer-mode').addEventListener('click', () => { T.mode = T.mode === 'down' ? 'up' : 'down'; timerReset(); $('#timer-mode-label').textContent = T.mode === 'down' ? 'Countdown' : 'Stopwatch'; $('#timer-presets').hidden = $('#timer-custom').hidden = T.mode !== 'down'; });
  $$('#timer-presets button').forEach(b => b.addEventListener('click', () => { $('#timer-min').value = b.dataset.min; $('#timer-sec').value = 0; timerReset(); timerStart(); }));
  $('#timer-start').addEventListener('click', () => T.running ? timerPause() : timerStart());
  $('#timer-reset').addEventListener('click', timerReset);
  ['#timer-min', '#timer-sec'].forEach(s => $(s).addEventListener('change', () => { if (!T.running) timerReset(); }));
  // drag to move
  const head = $('#timer-head'); let drag = null;
  head.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; drag = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop }; try { head.setPointerCapture(e.pointerId); } catch (ex) {} });
  head.addEventListener('pointermove', (e) => { if (!drag) return; el.style.left = (drag.l + e.clientX - drag.x) + 'px'; el.style.top = (drag.t + e.clientY - drag.y) + 'px'; el.style.right = 'auto'; el.style.transform = 'none'; });
  head.addEventListener('pointerup', () => { drag = null; });
  timerRender();
}
function toggleTimer() { V.timer.hidden = !V.timer.hidden; $('#btn-timer').classList.toggle('active', !V.timer.hidden); }
function timerTotal() { return (Math.max(0, +$('#timer-min').value || 0) * 60 + Math.max(0, +$('#timer-sec').value || 0)) * 1000; }
function timerReset() { T.running = false; T.total = timerTotal(); T.remaining = T.total; T.elapsed = 0; V.timer.classList.remove('done'); $('#timer-start').textContent = 'Start'; cancelAnimationFrame(T.raf); timerRender(); }
function timerStart() {
  if (T.mode === 'down' && T.remaining <= 0) { T.total = timerTotal(); T.remaining = T.total; V.timer.classList.remove('done'); }
  if (!T.audio) { try { T.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
  T.running = true; T.lastTick = performance.now(); $('#timer-start').textContent = 'Pause'; timerTick();
}
function timerPause() { T.running = false; $('#timer-start').textContent = 'Resume'; cancelAnimationFrame(T.raf); }
function timerTick() {
  if (!T.running) return;
  const now = performance.now(); const dt = now - T.lastTick; T.lastTick = now;
  if (T.mode === 'down') { T.remaining -= dt; if (T.remaining <= 0) { T.remaining = 0; T.running = false; V.timer.classList.add('done'); $('#timer-start').textContent = 'Start'; beep(); } }
  else T.elapsed += dt;
  timerRender();
  if (T.running) T.raf = requestAnimationFrame(timerTick);
}
function timerRender() {
  const ms = T.mode === 'down' ? T.remaining : T.elapsed; const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  $('#timer-digits').textContent = (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}
function beep() {
  if (!T.audio) return;
  try {
    const ctx = T.audio; if (ctx.state === 'suspended') ctx.resume();
    [0, 0.25, 0.5].forEach(t0 => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 880; o.connect(g); g.connect(ctx.destination); g.gain.setValueAtTime(0.0001, ctx.currentTime + t0); g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t0 + 0.2); o.start(ctx.currentTime + t0); o.stop(ctx.currentTime + t0 + 0.22); });
  } catch (e) {}
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */
function closeMenus() { $$('.menu').forEach(m => m.remove()); }
function showExportMenu(e) {
  closeMenus();
  const m = document.createElement('div'); m.className = 'menu';
  m.innerHTML = `<div class="lbl">Export with annotations</div><button data-x="pdf">Download as PDF</button><button data-x="pptx">Download as PowerPoint (.pptx)</button><div class="lbl">Original</div><button data-x="orig">Download original PDF</button><div class="lbl">After class</div><button data-x="finish">Finish: download annotated PDF &amp; remove slides from cloud</button>`;
  const r = e.currentTarget.getBoundingClientRect(); m.style.top = (r.bottom + 6) + 'px'; m.style.right = (window.innerWidth - r.right) + 'px';
  m.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; closeMenus(); runExport(b.dataset.x); });
  V.viewer.appendChild(m);
  setTimeout(() => document.addEventListener('pointerdown', function h(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('pointerdown', h); } }), 0);
}
async function loadAllStrokes(ref = blockRef) {
  const snap = await getDocs(collection(ref, 'pages'));
  const map = {}; snap.forEach(d => { map[d.id] = (d.data().strokes) || {}; });
  return map;
}
function strokesToCanvas(strokes, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
  drawStrokes(ctx, W, H, Object.values(strokes));
  return c;
}
async function runExport(kind) {
  if (!S.block) return;
  const base = safeName(S.block.title + (S.block.label ? ' - ' + S.block.label : ''));
  if (kind === 'finish') { finishBlock(S.route.courseId, S.block); return; }
  if (kind === 'orig') {
    if (!S.pdfBytes) return toast('No PDF uploaded for this block', 'err');
    downloadBlob(new Blob([S.pdfBytes], { type: 'application/pdf' }), safeName(S.block.fileName || base + '.pdf')); return;
  }
  const pages = S.block.pages || []; if (!pages.length) return toast('Nothing to export', 'err');
  const pm = progressModal(kind === 'pdf' ? 'Exporting PDF…' : 'Exporting PowerPoint…');
  try {
    const all = await loadAllStrokes();
    if (kind === 'pdf') await exportPdf(pages, all, base, pm); else await exportPptx(pages, all, base, pm);
    toast('Export ready', 'ok');
  } catch (e) { console.error(e); alert('Export failed: ' + e.message); }
  finally { pm.close(); }
}
async function exportPdf(pages, all, base, pm) {
  const bytes = await buildAnnotatedPdf(S.block, S.pdfBytes, all, pm);
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), base + ' (annotated).pdf');
}
async function buildAnnotatedPdf(block, pdfBytes, all, pm) {
  const pages = block.pages || [];
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js');
  const { PDFDocument, degrees } = window.PDFLib;
  const out = await PDFDocument.create();
  const src = pdfBytes ? await PDFDocument.load(pdfBytes, { ignoreEncryption: true }) : null;
  let blankSize = [960, 540];
  if (src && src.getPageCount()) { const p0 = src.getPage(0); const s0 = p0.getSize(); const rot = p0.getRotation().angle % 180; blankSize = rot ? [s0.height, s0.width] : [s0.width, s0.height]; }
  else if (block.pageAspect) blankSize = [960, 960 / block.pageAspect];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]; let page;
    if (p.type === 'pdf' && src && p.src < src.getPageCount()) { const [cp] = await out.copyPages(src, [p.src]); page = out.addPage(cp); }
    else page = out.addPage(blankSize);
    const strokes = all[p.id] || {};
    if (Object.keys(strokes).length) {
      const { width: pw, height: ph } = page.getSize(); const angle = ((page.getRotation().angle % 360) + 360) % 360;
      const dispW = angle % 180 ? ph : pw, dispH = angle % 180 ? pw : ph; // displayed orientation
      const scale = Math.min(3, 2400 / dispW);
      const canvas = strokesToCanvas(strokes, Math.round(dispW * scale), Math.round(dispH * scale));
      const png = await out.embedPng(canvas.toDataURL('image/png'));
      const opts = { width: dispW, height: dispH };
      if (angle === 0) Object.assign(opts, { x: 0, y: 0 });
      else if (angle === 90) Object.assign(opts, { x: pw, y: 0, rotate: degrees(90) });
      else if (angle === 180) Object.assign(opts, { x: pw, y: ph, rotate: degrees(180) });
      else Object.assign(opts, { x: 0, y: ph, rotate: degrees(270) });
      page.drawImage(png, opts);
    }
    pm.set((i + 1) / pages.length, `Page ${i + 1} of ${pages.length}`);
  }
  return out.save();
}

/* Finish class: download the annotated deck, then wipe slides + annotations from the cloud */
async function finishBlock(courseId, block) {
  if (!block.fileId && !(block.pages || []).length) { toast('This block has no slides stored online.'); return; }
  const ref = doc(db, 'courses', courseId, 'blocks', block.id);
  const name = safeName(block.title + (block.label ? ' - ' + block.label : '')) + ' (annotated).pdf';
  let pm = progressModal('Preparing annotated PDF…');
  try {
    let bytes = (block.fileId && S.pdfFileId === block.fileId && S.pdfBytes) ? S.pdfBytes : null;
    if (!bytes && block.fileId) bytes = (await loadFileBytes(block.fileId, (t) => pm.set(0.1, t))).bytes;
    const all = await loadAllStrokes(ref);
    const out = await buildAnnotatedPdf(block, bytes, all, pm);
    downloadBlob(new Blob([out], { type: 'application/pdf' }), name);
  } catch (e) { pm.close(); console.error(e); alert('Could not create the annotated PDF: ' + e.message + '\n\nNothing was removed.'); return; }
  pm.close(); await sleep(400);
  if (!confirm(`"${name}" was downloaded — make sure it is saved on this device.\n\nRemove the slides and annotations for "${block.title}" from the cloud now?`)) return;
  pm = progressModal('Removing from cloud…');
  try {
    const pages = await getDocs(collection(ref, 'pages'));
    const batch = writeBatch(db); pages.forEach(d => batch.delete(d.ref));
    batch.update(ref, { fileId: null, fileName: null, fileSize: null, pageCount: 0, pages: [], currentPageId: null, presence: {}, finishedAt: serverTimestamp(), finishedFile: name });
    await batch.commit();
    if (block.fileId) await deleteFile(block.fileId);
    toast('Slides removed from the cloud — only your downloaded copy remains', 'ok', 4000);
  } catch (e) { alert('Removal failed: ' + e.message); }
  finally { pm.close(); }
  if (S.route.view === 'viewer') go('/c/' + courseId);
}
async function exportPptx(pages, all, base, pm) {
  await loadScript('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js');
  const pptx = new window.PptxGenJS();
  const asp = S.block.pageAspect || 16 / 9;
  pptx.defineLayout({ name: 'deck', width: 10, height: 10 / asp }); pptx.layout = 'deck';
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const dims = await pageDims(p);
    const W = 1600, H = Math.round(1600 * dims.h / dims.w);
    const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    if (p.type === 'pdf' && dims.page) { const vp = dims.page.getViewport({ scale: W / dims.w }); await dims.page.render({ canvasContext: ctx, viewport: vp }).promise; }
    drawStrokes(ctx, W, H, Object.values(all[p.id] || {}));
    const slide = pptx.addSlide();
    slide.addImage({ data: c.toDataURL('image/jpeg', 0.9), x: 0, y: 0, w: 10, h: 10 / asp });
    pm.set((i + 1) / pages.length, `Slide ${i + 1} of ${pages.length}`);
  }
  const blob = await pptx.write({ outputType: 'blob' });
  downloadBlob(blob, base + ' (annotated).pptx');
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
function bindGlobalButtons() {
  $$('[data-action="theme"]').forEach(b => b.addEventListener('click', toggleTheme));
  $$('[data-action="logout"]').forEach(b => b.addEventListener('click', async () => { if (confirm('Log out now?')) await doLogout(); }));
  $$('[data-action="home"]').forEach(b => b.addEventListener('click', () => go('/')));
  $$('[data-action="back"]').forEach(b => b.addEventListener('click', () => go('/c/' + S.route.courseId)));
}
function boot() {
  bindGlobalButtons();
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.js', location.href).href;
  if (!firebaseReady()) { showView('setup'); return; }
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    // Memory cache: keeps the 800 KB slide chunks out of Firestore's on-disk cache (slow on iPad).
    // Offline edits are still queued while the page stays open; the PDF itself is cached in IndexedDB below.
    db = initializeFirestore(app, { localCache: memoryLocalCache() });
    // Realtime Database carries in-progress pen strokes ("live ink") between devices with ~50 ms latency.
    if (firebaseConfig.databaseURL) { try { rtdb = getDatabase(app); } catch (e) { console.warn('Realtime Database unavailable — live ink off', e); } }
    else console.warn('firebaseConfig.databaseURL not set — live ink between devices is off; strokes appear when the pen lifts.');
  } catch (e) { showView('setup'); $('#setup-error').textContent = e.message; return; }
  setupLogin();
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      let at = 0; try { at = +localStorage.getItem(LOGIN_KEY) || 0; } catch (e) {}
      if (!at) { at = Date.now(); try { localStorage.setItem(LOGIN_KEY, String(at)); } catch (e) {} }
      if (Date.now() - at > SESSION_MS) { await doLogout(); toast('Session expired — please log in again.'); return; }
      S.user = user; scheduleAutoLogout(at);
      await route();
    } else {
      S.user = null; teardown();
      if (S.route.view === 'viewer') leaveViewer();
      showView('login'); setTimeout(() => $('#pw').focus(), 50);
    }
  });
  window.addEventListener('hashchange', route);
}
boot();
