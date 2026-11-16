'use strict';
/* App window title bar: only rotate / minimize / maximize / close; everything else lives in the ApkStart main window */
const api = window.apkstart;
const t = window.i18n.t;
const $ = (id) => document.getElementById(id);

const btn = {
  rotate: $('btnRotate'),
  min: $('btnMin'),
  max: $('btnMax'),
  close: $('btnClose'),
};

btn.rotate.addEventListener('click', () => api.shell.rotate());
btn.min.addEventListener('click', () => api.shell.minimize());
btn.max.addEventListener('click', () => api.shell.maximize());
btn.close.addEventListener('click', () => api.shell.close());

// No Chromium page menu on the title bar. Right-clicks on the screen area are already caught
// by the main process and mapped to Android Back; this covers the shell around it.
window.addEventListener('contextmenu', (e) => e.preventDefault());

// Ctrl+R rotates, F11 maximizes (matches Windows habits)
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); api.shell.rotate(); }
  else if (e.key === 'F11') { e.preventDefault(); api.shell.maximize(); }
  else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); api.shell.back(); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); api.shell.forward(); }
});

function applyState(s) {
  if (!s) return;
  $('appName').textContent = s.label || t('App');
  $('bootName').textContent = s.label || '';
  const icon = s.iconUrl || '';
  if (icon) {
    $('appIcon').src = icon;
    $('bootIcon').src = icon;
  }
  $('bootTip').textContent = s.tip || '';
  if (s.ready) {
    const boot = $('boot');
    if (boot) {
      boot.classList.add('out');
      setTimeout(() => { boot.style.display = 'none'; }, 420);
    }
    document.body.style.background = '#0b0c0e';
  }
}

api.shell.onState(applyState);
api.shell.state().then(applyState).catch(() => {});
