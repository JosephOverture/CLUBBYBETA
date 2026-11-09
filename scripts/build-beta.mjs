import { cp, mkdir, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

// Kept separate from dist/api.js so a frontend build never erases the backend.
const output = resolve('dist/beta');
await mkdir(output,{recursive:true});
await cp(resolve('web'),output,{recursive:true});
for (const file of ['index.html','config.js','src/app.js','vendor/leaflet.js','assets/mark.svg']) await access(resolve(output,file));
const config = await readFile(resolve(output,'config.js'),'utf8');
if (!config.includes("dataMode: 'api'")) throw new Error('The distributable beta must use the backend.');
console.log('Built backend-connected Clubby website → dist/beta');
