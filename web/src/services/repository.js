import {venues as catalogue} from '../seed.js';
import {createStorage} from './storage.js';
import {normalizeVenue} from '../domain/model.js';

export class ServiceError extends Error {
  constructor(code,message){super(message);this.name='ServiceError';this.code=code;}
}
const blankState=()=>({saved:[],plans:[],profile:{name:'Guest',theme:'dark'}});

function validateState(value){
  if(!value||!Array.isArray(value.saved)||!value.saved.every(id=>typeof id==='string')||!Array.isArray(value.plans)||!value.profile||typeof value.profile.name!=='string'||!['light','dark'].includes(value.profile.theme))throw new ServiceError('SCHEMA','Clubby returned an invalid personal space. Please try again.');
  for(const p of value.plans){
    if(!p||typeof p.id!=='string'||typeof p.venueId!=='string'||typeof p.name!=='string'||typeof p.note!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.date)||p.status!=='personal')throw new ServiceError('SCHEMA','Clubby returned an invalid night plan. Please try again.');
  }
  return structuredClone({saved:[...new Set(value.saved)],plans:value.plans,profile:{name:value.profile.name,theme:value.profile.theme}});
}

/** API state belongs to an anonymous, HttpOnly browser session. Catalogue mode is explicitly offline. */
export function createRepository(config={},storage=createStorage()) {
  const live=config.dataMode!=='catalogue';
  let knownVenues=live?[]:catalogue.map(normalizeVenue);
  let personal=live?blankState():storage.read();
  let pending=Promise.resolve();
  const commit=value=>(personal=validateState(value),structuredClone(personal));
  const local=patch=>(personal=storage.write(patch),structuredClone(personal));
  const mutate=work=>{const next=pending.then(work);pending=next.catch(()=>{});return next;};

  async function request(path,{method='GET',body}={}) {
    let origin;
    try{origin=new URL(config.apiBaseUrl||globalThis.location?.origin);}catch{throw new ServiceError('CONFIG','Open Clubby through its web server, or configure a valid API origin.');}
    const loopback=['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
    if(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&loopback))throw new ServiceError('CONFIG','The API origin must use HTTPS outside localhost.');
    if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/')throw new ServiceError('CONFIG','Use a plain API origin without a path or credentials.');
    let res;
    try{
      res=await fetch(new URL(path,origin),{
        method,credentials:'include',cache:'no-store',
        headers:{accept:'application/json','x-clubby-channel':'web','x-clubby-api-version':'v1',...(body===undefined?{}:{'content-type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(12000)
      });
    }catch(error){
      throw new ServiceError('NETWORK',error?.name==='TimeoutError'||error?.name==='AbortError'?'Clubby took too long to respond. Please try again.':'Could not reach Clubby. Check your connection and try again.');
    }
    let response;
    try{response=await res.json();}catch{throw new ServiceError('NETWORK','The Clubby server returned an unexpected response. Please try again.');}
    if(!res.ok)throw new ServiceError(response?.error?.code||'NETWORK',response?.error?.message||'Could not save your changes. Please try again.');
    return response?.data??response;
  }
  function findVenue(id){if(!knownVenues.some(v=>v.id===id))throw new ServiceError('VENUE','Venue not found.');}
  return {
    mode:live?'api':'catalogue',
    async listVenues(){
      if(live){
        const data=await request(`/v1/venues?city=${encodeURIComponent(config.cityId||'milano')}&limit=100`);
        if(!Array.isArray(data))throw new ServiceError('SCHEMA','The venue catalogue could not be read. Please try again.');
        try{knownVenues=data.map(normalizeVenue);}catch{throw new ServiceError('SCHEMA','A venue listing could not be read. Please try again.');}
      }
      return structuredClone(knownVenues);
    },
    getState:()=>structuredClone(personal),
    async loadState(){return live?commit(await request('/v1/beta/state')):(personal=storage.read(),structuredClone(personal));},
    toggleSaved(id){return mutate(async()=>{
      findVenue(id);
      const saved=!personal.saved.includes(id);
      if(live)commit(await request(`/v1/beta/saved/${encodeURIComponent(id)}`,{method:'PUT',body:{saved}}));
      else local({saved:saved?[...personal.saved,id]:personal.saved.filter(x=>x!==id)});
      return structuredClone(personal.saved);
    });},
    savePlan(input){return mutate(async()=>{
      if(input.tableId)throw new ServiceError('NOT_ENABLED','Clubby does not reserve tables in this beta.');
      findVenue(input.venueId);
      const name=String(input.name||'').trim(),note=String(input.note||'').trim(),date=String(input.date||'');
      if(!name||name.length>80||note.length>400)throw new ServiceError('VALIDATION','Add a name of up to 80 characters and a note of up to 400 characters.');
      const parsed=new Date(date+'T12:00:00Z');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)throw new ServiceError('VALIDATION','Choose a valid date for your night.');
      if(live){
        const previous=new Set(personal.plans.map(p=>p.id));
        commit(await request('/v1/beta/plans',{method:'POST',body:{venueId:input.venueId,name,note,date}}));
        return structuredClone(personal.plans.find(p=>!previous.has(p.id)));
      }
      const plan={id:crypto.randomUUID(),venueId:input.venueId,name,note,date,createdAt:new Date().toISOString(),status:'personal'};
      local({plans:[plan,...personal.plans]});return structuredClone(plan);
    });},
    removePlan(id){return mutate(async()=>{
      if(live)commit(await request(`/v1/beta/plans/${encodeURIComponent(id)}`,{method:'DELETE'}));
      else local({plans:personal.plans.filter(x=>x.id!==id)});
      return structuredClone(personal.plans);
    });},
    updateProfile(patch){return mutate(async()=>{
      const name=String(patch.name??personal.profile.name).trim();
      const theme=patch.theme??personal.profile.theme;
      if(!name||name.length>40||!['light','dark'].includes(theme))throw new ServiceError('VALIDATION','Use a display name of up to 40 characters and a light or dark theme.');
      if(live)commit(await request('/v1/beta/profile',{method:'PATCH',body:{name,theme}}));
      else local({profile:{name,theme}});
      return structuredClone(personal.profile);
    });},
    clearLocalData(){return mutate(async()=>{
      if(live)commit(await request('/v1/beta/state',{method:'DELETE'}));
      else personal=storage.clear();
      if(live)storage.clear();
      return structuredClone(personal);
    });}
  };
}
