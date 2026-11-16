'use strict';
/**
 * English / Arabic UI strings.
 *
 * English is the source language: every user-facing string in the code is written in
 * English and wrapped in t(). Arabic translations live in src/i18n/ar/*.json, keyed by
 * the exact English text (all files in that folder are merged).
 *
 *   t('Installing {name}…', { name })   ->  "Installing Foo…" / "جارٍ تثبيت Foo…"
 *
 * Call t() when the string is shown, not at module load: the language is chosen after
 * the app is ready and can change at runtime from Settings.
 */
const fs = require('fs');
const path = require('path');

let lang = 'en';
let dict = {};
let arCache = null;

function loadAr() {
  if (arCache) return arCache;
  const dir = path.join(__dirname, 'ar');
  const out = {};
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    Object.assign(out, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  arCache = out;
  return out;
}

/** 'auto' follows the Windows display language: Arabic if it is Arabic, else English. */
function resolve(pref, osLocale) {
  if (pref === 'ar' || pref === 'en') return pref;
  return /^ar\b/i.test(String(osLocale || '')) ? 'ar' : 'en';
}

function setLang(l) {
  lang = l === 'ar' ? 'ar' : 'en';
  dict = lang === 'ar' ? loadAr() : {};
  return lang;
}

function t(s, vars) {
  let out = (lang === 'ar' && dict[s]) || s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out;
}

/** Translate static HTML: exact-match text nodes, a few attributes, and [data-i18n] blocks. */
function translateDom(doc) {
  doc.documentElement.lang = lang;
  doc.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  if (lang !== 'ar') return;
  for (const el of doc.querySelectorAll('[data-i18n]')) {
    const v = dict[el.getAttribute('data-i18n')];
    if (v) el.innerHTML = v; // trusted: our own bundled dictionary
  }
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const key = n.nodeValue.trim();
    if (key && dict[key]) n.nodeValue = n.nodeValue.replace(key, dict[key]);
  }
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    for (const el of doc.querySelectorAll(`[${attr}]`)) {
      const v = dict[el.getAttribute(attr)];
      if (v) el.setAttribute(attr, v);
    }
  }
  const tv = dict[doc.title];
  if (tv) doc.title = tv;
}

module.exports = {
  t, setLang, resolve, translateDom,
  getLang: () => lang,
  dir: () => (lang === 'ar' ? 'rtl' : 'ltr'),
};
