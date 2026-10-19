import assert from 'node:assert/strict';
import {readFileSync,existsSync,statSync,readdirSync} from 'node:fs';
import path from 'node:path';
const root=path.resolve('out');
const walk=(dir)=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const files=walk(root),html=files.filter(p=>p.endsWith('.html'));
const errors=[];
for(const file of html){const body=readFileSync(file,'utf8');for(const match of body.matchAll(/(?:href|src)="([^"#]+)"/g)){const raw=match[1].replaceAll('&amp;','&');if(!raw.startsWith('/')||raw.startsWith('//'))continue;const url=new URL(raw,'https://local.test');let target=path.join(root,decodeURIComponent(url.pathname));if(existsSync(target)&&statSync(target).isDirectory())target=path.join(target,'index.html');if(!existsSync(target))errors.push(`${path.relative(root,file)} → ${url.pathname}`);}}
assert.deepEqual([...new Set(errors)],[]);
const routes=walk(path.resolve('src/app')).filter(p=>p.endsWith('/page.tsx')).map(p=>path.relative(path.resolve('src/app'),path.dirname(p))||'/');assert.equal(routes.length,23);
assert.ok(readFileSync(path.join(root,'index.html'),'utf8').includes('hero-field.webp'));
for(const name of ['hero-clause.png','seal-core.png','wave-relay.png','custody-key.png'])assert.equal(existsSync(path.join(root,'assets',name)),false);
for (const removed of ['assets/proviso-overview.pdf','assets/proviso-backend.pdf','economics/index.html']) assert.equal(existsSync(path.join(root,removed)),false,removed);
console.log(`Static export passed: ${routes.length} product routes, ${html.length} HTML files, no broken local links/assets or superseded imagery.`);
