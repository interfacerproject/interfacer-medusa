import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {medusa} from './field-guide.mjs';
const htmlURL=new URL('./index.html',import.meta.url);

test('standalone guide rebuilds reproducibly from the canonical bilingual chapter',async()=>{
 const before=await readFile(htmlURL,'utf8');
 execFileSync(process.execPath,[new URL('./build.mjs',import.meta.url).pathname]);
 assert.equal(await readFile(htmlURL,'utf8'),before);
 assert.ok(before.startsWith('<!doctype html>'));
 for(const s of medusa.sections){
  assert.ok(before.includes(`id="${s.id}"`));
  assert.ok(s.body.en.length>100&&s.body.it.length>100);
  assert.notEqual(s.body.en,s.body.it);
 }
});

test('review facts, PR stack, evidence and limits are present without secrets or external assets',async()=>{
 const html=await readFile(htmlURL,'utf8');
 for(const term of ['outputOf','base58','50','28','9/9','interfacer-gui-nhn','interfacer-gui-h0n','interfacer-gui-dz7','AUTHZ_ENFORCE','interfacer-sync','8018cb4','f76a53e'])assert.ok(html.includes(term),term);
 assert.ok(medusa.sources.every(s=>/\/blob\/[0-9a-f]{40}\//.test(s.url)));
 assert.ok(!/\b(?:src|href)="https?:[^\"]+\.(?:js|css|woff2)"/.test(html));
 assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/.test(html));
 const js=await readFile(new URL('./review.js',import.meta.url),'utf8');
 assert.ok(!/fetch\s*\(|XMLHttpRequest|WebSocket/.test(js));
});
