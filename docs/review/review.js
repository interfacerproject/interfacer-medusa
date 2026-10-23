function setLang(lang) {
  document.documentElement.dataset.lang = lang;
  document.documentElement.lang = lang;
  for (const l of ['en', 'it']) document.getElementById(l).setAttribute('aria-pressed', String(l === lang));
  try { localStorage.setItem('mg-lang', lang); } catch {}
}
for (const lang of ['en', 'it']) document.getElementById(lang).addEventListener('click', () => setLang(lang));
document.getElementById('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const current = root.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  root.dataset.theme = current === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('mg-theme', root.dataset.theme); } catch {}
});
try {
  if (localStorage.getItem('mg-lang') === 'it') setLang('it');
  const theme = localStorage.getItem('mg-theme');
  if (['light', 'dark'].includes(theme)) document.documentElement.dataset.theme = theme;
} catch {}
