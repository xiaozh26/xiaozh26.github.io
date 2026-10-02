/* Floating Python console for the slide viewer. Python (Pyodide) runs in a Web Worker so a runaway
   loop never freezes the slides or sync; "Restart" (or Ctrl+C while running) kills the worker. */

const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
const $ = (sel, root = document) => root.querySelector(sel);

// Module-worker source: loads Pyodide and exposes one operation, push(line) → [status, text].
const WORKER_SRC = `
import { loadPyodide } from '${PYODIDE}pyodide.mjs';
let push = null, reset = null;
const ready = (async () => {
  const py = await loadPyodide({ indexURL: '${PYODIDE}' });
  py.globals.set('_out', (s) => postMessage({ type: 'out', text: s }));
  py.globals.set('_err', (s) => postMessage({ type: 'err', text: s }));
  [push, reset] = py.runPython(\`
import builtins
from pyodide.console import PyodideConsole, repr_shorten, BANNER

class _NoInput(Exception):
    pass

def _no_input(n):
    raise _NoInput()

_con = PyodideConsole({"__name__": "__main__", "__doc__": None},
                      stdin_callback=_no_input, stdout_callback=_out, stderr_callback=_err)

async def _push(line):
    fut = _con.push(line)
    if fut.syntax_check == "incomplete":
        return ("more", None)
    try:
        value = await fut
    except _NoInput:
        return ("error", "input() isn't available in this console. Set the value directly instead, e.g. name = 'Ada'")
    except BaseException:
        return ("error", fut.formatted_error)
    if value is None:
        return ("ok", None)
    builtins._ = value
    return ("ok", repr_shorten(value, separator="\\\\n<long output truncated>\\\\n"))

def _reset():
    _con.buffer = []

(_push, _reset)
\`).toJs();
  return py.runPython('BANNER');
})();
ready.then((banner) => postMessage({ type: 'ready', banner }), (e) => postMessage({ type: 'fail', text: String(e) }));
onmessage = async ({ data }) => {
  await ready;
  if (data.type === 'reset') { reset(); return; }
  const r = await push(data.line);
  const [status, text] = r.toJs(); r.destroy();
  postMessage({ type: 'result', status, text });
};
`;

const P = { el: null, log: null, input: null, prompt: null, status: null, worker: null, ready: false, busy: false,
  more: false, history: [], hpos: 0, draft: '', resolve: null, font: 14, gen: 0 };

export function initPyConsole() {
  P.el = $('#pyrepl'); P.log = $('#py-log'); P.input = $('#py-in'); P.prompt = $('#py-prompt'); P.status = $('#py-status');
  try { const f = +localStorage.getItem('teach_py_font'); if (f) P.font = f; } catch (e) {}
  setFont(P.font);
  $('#py-close').addEventListener('click', togglePyConsole);
  $('#py-clear').addEventListener('click', clearLog);
  $('#py-restart').addEventListener('click', () => restart('Python restarted — variables cleared.'));
  $('#py-font-down').addEventListener('click', () => setFont(P.font - 2));
  $('#py-font-up').addEventListener('click', () => setFont(P.font + 2));
  $('#py-body').addEventListener('click', () => { if (!window.getSelection().toString()) P.input.focus(); });
  P.input.addEventListener('keydown', onKey);
  P.input.addEventListener('input', autosize);
  // drag to move (same as the timer)
  const head = $('#py-head'), el = P.el; let drag = null;
  head.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; drag = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop }; try { head.setPointerCapture(e.pointerId); } catch (ex) {} });
  head.addEventListener('pointermove', (e) => { if (!drag) return; el.style.left = (drag.l + e.clientX - drag.x) + 'px'; el.style.top = (drag.t + e.clientY - drag.y) + 'px'; });
  head.addEventListener('pointerup', () => { drag = null; });
}

export function togglePyConsole() {
  P.el.hidden = !P.el.hidden;
  $('#btn-python').classList.toggle('active', !P.el.hidden);
  if (P.el.hidden) { P.input.blur(); return; }
  if (!P.worker) start();
  P.input.focus();
}

function start() {
  P.ready = false; P.busy = false; P.more = false; P.gen++; P.input.readOnly = false;
  setStatus('Loading Python…'); setPrompt();
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  P.worker = new Worker(url, { type: 'module' }); URL.revokeObjectURL(url);
  P.worker.onmessage = ({ data }) => {
    if (data.type === 'out') write(data.text);
    else if (data.type === 'err') write(data.text, 'err');
    else if (data.type === 'ready') { P.ready = true; setStatus(''); if (!P.log.textContent) write(data.banner + '\nRuns in your browser. Packages such as numpy load on first import.\n', 'muted'); }
    else if (data.type === 'fail') { setStatus('Failed to load'); write('Could not load Python: ' + data.text + '\n', 'err'); }
    else if (data.type === 'result' && P.resolve) { const r = P.resolve; P.resolve = null; r(data); }
  };
  P.worker.onerror = (e) => { setStatus('Failed to load'); write('Could not load Python' + (e.message ? ': ' + e.message : ' (are you offline?)') + '\n', 'err'); e.preventDefault(); };
}

function restart(msg) {
  if (P.worker) P.worker.terminate();
  P.worker = null; P.resolve = null;
  write(msg + '\n', 'muted');
  start(); P.input.focus();
}

function pushLine(line) {
  return new Promise((res) => { P.resolve = res; P.worker.postMessage({ type: 'push', line }); });
}

async function submit() {
  if (!P.ready || P.busy) return;
  const src = P.input.value.replace(/ /g, ' ');
  const lines = src.split('\n');
  if (src.trim()) { P.history.push(src); if (P.history.length > 200) P.history.shift(); }
  P.hpos = P.history.length; P.draft = '';
  P.input.value = ''; autosize();
  P.busy = true; P.input.readOnly = true; setStatus('Running…  Ctrl+C to stop');
  // A pasted multi-line block runs as a whole, like the Python 3.13+ REPL.
  if (lines.length > 1 && lines[lines.length - 1].trim()) lines.push('');
  let last = ''; const gen = P.gen;
  for (const raw of lines) {
    const line = raw.trim() ? raw : '';
    write((P.more ? '... ' : '>>> ') + line + '\n', 'echo');
    const r = await pushLine(line);
    if (gen !== P.gen) return; // restarted while running
    P.more = r.status === 'more';
    if (r.status === 'error') write(r.text.replace(/\n?$/, '\n'), 'err');
    else if (r.text != null) write(r.text + '\n');
    last = line;
  }
  P.busy = false; P.input.readOnly = false; setStatus(''); setPrompt();
  if (P.more) { // keep the indentation going inside a block
    const indent = last.match(/^\s*/)[0] + (/:\s*(#.*)?$/.test(last) ? '    ' : '');
    P.input.value = indent;
  }
  P.input.focus();
}

function onKey(e) {
  const t = P.input, k = e.key;
  e.stopPropagation();
  if (k === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
  if (e.ctrlKey && !e.metaKey && k.toLowerCase() === 'c' && t.selectionStart === t.selectionEnd) {
    e.preventDefault();
    if (P.busy) { restart('KeyboardInterrupt — Python restarted, variables cleared.'); return; }
    write((P.more ? '... ' : '>>> ') + t.value + '\nKeyboardInterrupt\n', 'err');
    t.value = ''; autosize(); P.more = false; setPrompt();
    if (P.worker) P.worker.postMessage({ type: 'reset' });
    return;
  }
  if ((e.ctrlKey && k.toLowerCase() === 'l') || (e.metaKey && k.toLowerCase() === 'k')) { e.preventDefault(); clearLog(); return; }
  if (k === 'Tab') { e.preventDefault(); insert(e.shiftKey ? '' : '    ', e.shiftKey); return; }
  if (k === 'Backspace' && t.selectionStart === t.selectionEnd) {
    const before = t.value.slice(0, t.selectionStart), lineStart = before.slice(before.lastIndexOf('\n') + 1);
    if (lineStart.length && !lineStart.trim() && lineStart.length % 4 === 0) { e.preventDefault(); t.setRangeText('', t.selectionStart - 4, t.selectionStart, 'end'); autosize(); }
    return;
  }
  const onFirst = !t.value.slice(0, t.selectionStart).includes('\n'), onLast = !t.value.slice(t.selectionEnd).includes('\n');
  if (k === 'ArrowUp' && onFirst && P.hpos > 0) {
    e.preventDefault(); if (P.hpos === P.history.length) P.draft = t.value;
    t.value = P.history[--P.hpos]; autosize();
  } else if (k === 'ArrowDown' && onLast && P.hpos < P.history.length) {
    e.preventDefault(); t.value = ++P.hpos === P.history.length ? P.draft : P.history[P.hpos]; autosize();
  }
}

function insert(text, dedent) {
  const t = P.input;
  if (dedent) {
    const s = t.value.lastIndexOf('\n', t.selectionStart - 1) + 1, n = t.value.slice(s).match(/^ {0,4}/)[0].length;
    if (n) t.setRangeText('', s, s + n, 'end');
  } else t.setRangeText(text, t.selectionStart, t.selectionEnd, 'end');
  autosize();
}

function write(text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  P.log.appendChild(span);
  const body = $('#py-body'); body.scrollTop = body.scrollHeight;
}
function clearLog() { P.log.textContent = ''; P.input.focus(); }
function setPrompt() { P.prompt.textContent = P.more ? '...' : '>>>'; }
function setStatus(s) { P.status.textContent = s; }
function autosize() { const t = P.input; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
function setFont(px) {
  P.font = Math.min(32, Math.max(10, px));
  P.el.style.setProperty('--py-font', P.font + 'px');
  try { localStorage.setItem('teach_py_font', String(P.font)); } catch (e) {}
  autosize();
}
