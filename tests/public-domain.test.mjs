import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import {filterVenues,escapeHTML,safeURL,normalizeVenue,directionsURL} from '../web/src/domain/model.js';
import {venues} from '../web/src/seed.js';
import {createStorage} from '../web/src/services/storage.js';
import {createRepository} from '../web/src/services/repository.js';
function mockStorage(){const items=new Map();return {getItem:k=>items.get(k)||null,setItem:(k,v)=>items.set(k,v),removeItem:k=>items.delete(k)};}
test('public catalogue has unique venues, traceable official links, local illustrations and no demo inventory',async()=>{
  assert.ok(venues.length>=20);assert.equal(new Set(venues.map(v=>v.id)).size,venues.length);
  const databaseCatalogue=JSON.parse(await readFile(new URL('../database/seeds/milan-venues.json',import.meta.url),'utf8'));
  assert.deepEqual(databaseCatalogue,venues,'server seed must preserve the complete published catalogue and venue entry notes');
  assert.equal(venues.find(v=>v.id==='officina').linkType,'social');
  assert.equal(venues.filter(v=>v.accessNote?.includes('ARCI membership')).length,2);
  for(const v of venues){assert.equal(v.commercialMode,'external');assert.ok(v.address);assert.match(v.verifiedAt,/^2026-10-1[34]$/);assert.notEqual(safeURL(v.externalUrl),'#');assert.notEqual(safeURL(v.sourceUrl),'#');assert.ok(v.latitude>45.4&&v.latitude<45.55);assert.ok(v.longitude>9.1&&v.longitude<9.3);assert.ok(['official-map','approximate'].includes(v.coordinateAccuracy));assert.ok(!v.demo&&!v.tablePreview&&!v.priceBand);assert.equal(v.events.length,0);assert.match(v.image,/^assets\/[a-z-]+\.svg$/);await access(new URL('../web/'+v.image,import.meta.url));}
});
test('combined discovery filters respect category, vibe, area, address and saved collection',()=>{
  assert.deepEqual(filterVenues(venues,{query:'blue isola',category:'Live music',genre:'Jazz',neighbourhood:'Isola',saved:['bluenote']}).map(v=>v.id),['bluenote']);
  assert.equal(filterVenues(venues,{query:'blue',saved:[]}).length,0);assert.equal(filterVenues(venues,{category:'Clubs',genre:'Jazz'}).length,0);assert.ok(filterVenues(venues,{query:'Valtellina 25'}).some(v=>v.id==='alcatraz'));
});
test('saved places and personal plans persist, clear correctly and never imply a reservation',async()=>{
  const raw=mockStorage(),first=createRepository({dataMode:'catalogue'},createStorage(raw));await first.toggleSaved('alcatraz');
  const result=await first.savePlan({name:'Friday night',venueId:'alcatraz',date:'2099-10-16',note:'Meet at 8',status:'confirmed',paid:true});
  const second=createRepository({dataMode:'catalogue'},createStorage(raw));assert.deepEqual(second.getState().saved,['alcatraz']);assert.equal(second.getState().plans[0].id,result.id);assert.equal(result.status,'personal');assert.equal(result.paid,undefined);
  await second.clearLocalData();assert.equal(second.getState().plans.length,0);assert.deepEqual(second.getState().saved,[]);
});
test('personal planner rejects table booking payloads, invalid venues and impossible dates',async()=>{
  const repo=createRepository({dataMode:'catalogue'},createStorage(mockStorage()));
  await assert.rejects(repo.savePlan({venueId:'alcatraz',tableId:'alcatraz-t1'}),/does not reserve tables/);
  await assert.rejects(repo.savePlan({venueId:'missing',name:'Night',date:'2099-01-01'}),/Venue not found/);
  await assert.rejects(repo.savePlan({venueId:'alcatraz',name:'Night',date:'2099-02-31'}),/valid date/);
  assert.equal(repo.getState().plans.length,0);
});
test('storage denial, malformed data and write failure keep the app usable',async()=>{
  for(const storage of [{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}},{getItem:()=>'{broken',setItem(){}},{getItem:()=>JSON.stringify({saved:[],plans:[],profile:null}),setItem(){throw Error('quota');}}]){
    const repo=createRepository({dataMode:'catalogue'},createStorage(storage));await repo.toggleSaved('alcatraz');await repo.savePlan({venueId:'alcatraz',name:'Night out',date:'2099-01-01'});assert.equal(repo.getState().plans.length,1);assert.deepEqual(repo.getState().saved,['alcatraz']);assert.equal(repo.getState().profile.name,'Guest');
  }
});
test('unsafe links, image sources and text cannot become executable markup',()=>{
  for(const url of ['javascript:alert(1)','data:text/html,test','https://user:password@example.com'])assert.equal(safeURL(url),'#');
  assert.equal(escapeHTML('<img src=x onerror="x">'),'&lt;img src=x onerror=&quot;x&quot;&gt;');
  assert.throws(()=>normalizeVenue({id:'a',name:'Venue',externalUrl:'javascript:foo'}));
  assert.equal(normalizeVenue({...venues[0],image:'javascript:bad'}).image,'assets/nightlife.svg');
  const url=new URL(directionsURL(venues[0]));assert.equal(url.hostname,'www.google.com');assert.match(url.searchParams.get('destination'),/Via Valtellina 25/);
});
test('API failures surface instead of silently replacing live catalogue data',async()=>{
  const previous=globalThis.fetch;globalThis.fetch=async()=>({ok:false,json:async()=>({error:{code:'UNAUTHENTICATED',message:'Please sign in'}})});
  try{const repo=createRepository({dataMode:'api',apiBaseUrl:'https://api.example.com'},createStorage(mockStorage()));await assert.rejects(repo.listVenues(),/Please sign in/);}finally{globalThis.fetch=previous;}
});
test('public entry point has no simulated booking, staff or event creation routes',async()=>{
  const source=await readFile(new URL('../web/src/app.js',import.meta.url),'utf8');
  for(const term of ['renderBusiness','showTables','sample ticket','table-save-form','saveEvent','reviewIngestion'])assert.ok(!source.includes(term),term);
});
test('nearby map markers expose every venue including shared addresses',async()=>{
  const {groupMapVenues}=await import('../web/src/services/maps.js');
  const groups=groupMapVenues(venues),ids=groups.flat().map(v=>v.id);
  assert.equal(ids.length,venues.length);assert.equal(new Set(ids).size,venues.length);
  assert.ok(groups.some(g=>g.some(v=>v.id==='mag-navigli')&&g.some(v=>v.id==='backdoor43')));
  assert.equal(groupMapVenues([{id:'missing-coordinates'}]).length,0);
});
