import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {createRepository,ServiceError} from '../web/src/services/repository.js';
import {createStorage} from '../web/src/services/storage.js';
import {venues} from '../web/src/seed.js';
import {filterVenues,escapeHTML,safeURL} from '../web/src/domain/model.js';
import {groupMapVenues} from '../web/src/services/maps.js';

const blank=()=>({saved:[],plans:[],profile:{name:'Guest',theme:'dark'}});
const clone=value=>structuredClone(value);
function browserStorage(){
  const items=new Map();
  return {getItem:key=>items.get(key)||null,setItem:(key,value)=>items.set(key,value),removeItem:key=>items.delete(key)};
}
function api(){
  let state=blank(),nextId=0;
  const requests=[];
  return {
    requests,
    get state(){return clone(state);},
    async fetch(url,options){
      const path=url.pathname,body=options.body?JSON.parse(options.body):undefined;
      requests.push({url:String(url),path,...options,body});
      if(path==='/v1/venues')return {ok:true,json:async()=>({data:clone(venues)})};
      if(path==='/v1/beta/state'&&options.method==='DELETE')state=blank();
      if(path.startsWith('/v1/beta/saved/')){
        const id=decodeURIComponent(path.split('/').at(-1));
        state.saved=body.saved?[...new Set([...state.saved,id])]:state.saved.filter(x=>x!==id);
      }
      if(path==='/v1/beta/plans'&&options.method==='POST')state.plans.unshift({...body,id:'plan-'+(++nextId),status:'personal',createdAt:'2026-11-06T18:00:00Z'});
      if(path.startsWith('/v1/beta/plans/')&&options.method==='DELETE')state.plans=state.plans.filter(p=>p.id!==path.split('/').at(-1));
      if(path==='/v1/beta/profile')state.profile={...state.profile,...body};
      return {ok:true,json:async()=>({data:clone(state)})};
    }
  };
}

test('the editorial catalogue, combined filters and overlapping map pins retain all 28 venues',async()=>{
  assert.equal(venues.length,28);
  assert.equal(new Set(venues.map(v=>v.id)).size,28);
  for(const venue of venues){
    assert.notEqual(safeURL(venue.externalUrl),'#');
    await access(new URL('../web/'+venue.image,import.meta.url));
  }
  assert.deepEqual(filterVenues(venues,{query:'blue isola',category:'Live music',genre:'Jazz',neighbourhood:'Isola',saved:['bluenote']}).map(v=>v.id),['bluenote']);
  assert.equal(groupMapVenues(venues).flat().length,28);
  assert.equal(escapeHTML('<script>'),'&lt;script&gt;');
});

test('explicit offline catalogue mode persists personal plans without making API calls',async()=>{
  const storage=browserStorage(),repo=createRepository({dataMode:'catalogue'},createStorage(storage));
  assert.equal(repo.mode,'catalogue');
  await repo.loadState();
  await repo.toggleSaved('alcatraz');
  const plan=await repo.savePlan({venueId:'alcatraz',name:'Friday',date:'2099-11-06',note:'Meet at eight',paid:true});
  assert.equal(plan.status,'personal');assert.equal(plan.paid,undefined);
  const reloaded=createRepository({dataMode:'catalogue'},createStorage(storage));
  assert.deepEqual(reloaded.getState().saved,['alcatraz']);
  assert.equal(reloaded.getState().plans[0].id,plan.id);
  await assert.rejects(repo.savePlan({venueId:'alcatraz',name:'Invalid date',date:'2099-02-31'}),/valid date/);
  await assert.rejects(repo.savePlan({venueId:'alcatraz',tableId:'table-1'}),/does not reserve tables/);
  await reloaded.clearLocalData();assert.deepEqual(reloaded.getState(),blank());
});

test('default API mode uses same-origin cookies and reloads authoritative favourites, plans and profile',async()=>{
  const previousFetch=globalThis.fetch,previousLocation=globalThis.location,server=api();
  globalThis.fetch=server.fetch;globalThis.location={origin:'http://localhost:3000'};
  const forbiddenStorage={read(){throw Error('Live mode must not read local personal data');},write(){throw Error('Live mode must not write local personal data');},clear(){}};
  try{
    const repo=createRepository({},forbiddenStorage);
    assert.equal(repo.mode,'api');
    await Promise.all([repo.listVenues(),repo.loadState()]);
    assert.deepEqual(await repo.toggleSaved('alcatraz'),['alcatraz']);
    const plan=await repo.savePlan({venueId:'alcatraz',name:'  Crew night  ',date:'2099-11-06',note:'  Eight  ',confirmed:true});
    assert.equal(plan.name,'Crew night');assert.equal(plan.note,'Eight');assert.equal(plan.confirmed,undefined);
    await repo.updateProfile({name:'Alex',theme:'light'});
    const reloaded=createRepository({},forbiddenStorage);
    await reloaded.loadState();
    assert.deepEqual(reloaded.getState(),server.state);
    assert.equal(reloaded.getState().plans[0].id,plan.id);
    await repo.removePlan(plan.id);assert.equal(repo.getState().plans.length,0);
    for(const request of server.requests){assert.match(request.url,/^http:\/\/localhost:3000\//);assert.equal(request.credentials,'include');assert.equal(request.cache,'no-store');if(request.body)assert.equal(request.headers['content-type'],'application/json');}
    const planRequest=server.requests.find(r=>r.path==='/v1/beta/plans');
    assert.deepEqual(Object.keys(planRequest.body).sort(),['date','name','note','venueId']);
    await repo.clearLocalData();assert.deepEqual(repo.getState(),blank());
  }finally{globalThis.fetch=previousFetch;if(previousLocation===undefined)delete globalThis.location;else globalThis.location=previousLocation;}
});

test('concurrent saved-place clicks are serialized and a rejected mutation cannot change cached state',async()=>{
  const previous=globalThis.fetch,server=api();globalThis.fetch=server.fetch;
  try{
    const repo=createRepository({apiBaseUrl:'https://clubby.example'});
    await repo.listVenues();await repo.loadState();
    await Promise.all([repo.toggleSaved('alcatraz'),repo.toggleSaved('alcatraz')]);
    assert.deepEqual(repo.getState().saved,[]);
    globalThis.fetch=async()=>({ok:false,json:async()=>({error:{code:'RATE_LIMITED',message:'Please wait a moment.'}})});
    await assert.rejects(repo.toggleSaved('alcatraz'),error=>error instanceof ServiceError&&error.code==='RATE_LIMITED'&&/wait/.test(error.message));
    assert.deepEqual(repo.getState().saved,[]);
    globalThis.fetch=server.fetch;
    await repo.toggleSaved('alcatraz');assert.deepEqual(repo.getState().saved,['alcatraz']);
  }finally{globalThis.fetch=previous;}
});

test('API outages, malformed JSON and invalid server state surface errors without falling back to catalogue data',async()=>{
  const previous=globalThis.fetch;
  try{
    for(const response of [async()=>{throw new TypeError('Failed to fetch');},async()=>({ok:true,json:async()=>{throw Error('HTML response');}}),async()=>({ok:true,json:async()=>({data:'not a catalogue'})})]){
      globalThis.fetch=response;
      const repo=createRepository({apiBaseUrl:'https://clubby.example'});
      await assert.rejects(repo.listVenues(),ServiceError);
      assert.deepEqual(repo.getState(),blank());
    }
    globalThis.fetch=async()=>({ok:true,json:async()=>({data:{saved:['alcatraz'],plans:[],profile:null}})});
    const repo=createRepository({apiBaseUrl:'https://clubby.example'});
    await assert.rejects(repo.loadState(),/invalid personal space/);
    assert.deepEqual(repo.getState(),blank());
    await assert.rejects(createRepository({apiBaseUrl:'http://public.example'}).listVenues(),/HTTPS/);
    await assert.rejects(createRepository({apiBaseUrl:'https://user:secret@clubby.example'}).loadState(),/credentials/);
  }finally{globalThis.fetch=previous;}
});

test('live UI boot loads personal state and copy distinguishes server sessions from offline browser storage',async()=>{
  const source=await readFile(new URL('../web/src/app.js',import.meta.url),'utf8');
  assert.ok(source.includes('repo.loadState()'));
  assert.ok(source.includes('await repo.toggleSaved(id)'));
  assert.ok(source.includes('await repo.updateProfile({name})'));
  assert.ok(source.includes('await repo.clearLocalData()'));
  assert.ok(source.includes('Offline catalogue preview.'));
  assert.ok(source.includes('anonymous session'));
  assert.ok(!source.includes('We do not send those entries to a Clubby database'));
  assert.ok(!source.includes('onclick='));
});
