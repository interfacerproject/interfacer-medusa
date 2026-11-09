import {writeFile} from 'node:fs/promises';
import {medusa} from './field-guide.mjs';
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const html=`<!doctype html>
<html lang="en" data-lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Interfacer × Medusa — reviewers’ field guide</title>
<meta name="description" content="23 October 2026: registered buyer wallets, live Process/produce/transfer, review stack, evidence and release gates.">
<link rel="stylesheet" href="review.css"><script src="review.js" defer></script></head>
<body><header class="mast"><div class="wrap"><div class="brand"><b>Interfacer × Medusa</b><span lang-en>reviewers’ field guide</span><span lang-it>guida per i reviewer</span></div>
<div class="toggle" role="group" aria-label="Language"><button id="en" aria-pressed="true">EN</button><button id="it" aria-pressed="false">IT</button></div>
<button id="theme" class="theme-btn" aria-label="Toggle theme">◐</button></div></header>
<main><div class="wrap"><div class="hero"><h1 lang-en>${medusa.title.en}</h1><h1 lang-it>${medusa.title.it}</h1><p class="lede" lang-en>${medusa.intro.en}</p><p class="lede" lang-it>${medusa.intro.it}</p>
<nav aria-label="Contents">${medusa.sections.map(s=>`<a href="#${s.id}"><span lang-en>${s.title.en}</span><span lang-it>${s.title.it}</span></a>`).join(' · ')}</nav></div>
${medusa.sections.map(s=>`<section id="${s.id}"><h2 lang-en>${s.title.en}</h2><h2 lang-it>${s.title.it}</h2><div lang-en>${s.body.en}</div><div lang-it>${s.body.it}</div></section>`).join('\n')}
<section id="sources" class="sources"><h2 lang-en>Pinned implementation sources</h2><h2 lang-it>Sorgenti implementazione fissate</h2><ul>${medusa.sources.map(s=>`<li><a href="${escape(s.url)}">${s.repo} · ${s.commit.slice(0,7)} · <code>${escape(s.path)}</code></a></li>`).join('')}</ul></section></div></main>
<footer><div class="wrap"><p lang-en>Documentation of local work under review. No merge, SDK publication or production deployment. Generated from the versioned bilingual review chapter; no analytics, external fonts or API requests.</p><p lang-it>Documentazione del lavoro locale in review. Nessun merge, pubblicazione SDK o deploy in produzione. Generata dal capitolo bilingue versionato; nessuna analytics, font esterno o richiesta API.</p></div></footer></body></html>
`;
await writeFile(new URL('./index.html',import.meta.url),html);
console.log('Built docs/review/index.html from the canonical bilingual review chapter.');
