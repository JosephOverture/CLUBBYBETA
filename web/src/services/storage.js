const KEY='clubby.web.public-beta.v1';
const blank=()=>({saved:[],plans:[],profile:{name:'Guest',theme:'dark'}});
function sanitize(raw){
  if(!raw||typeof raw!=='object')return blank();
  return {
    saved:Array.isArray(raw.saved)?[...new Set(raw.saved.filter(id=>typeof id==='string'))]:[],
    plans:Array.isArray(raw.plans)?raw.plans.filter(p=>p&&typeof p.id==='string'&&typeof p.venueId==='string'&&typeof p.name==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(p.date)&&!p.tableId):[],
    profile:{name:typeof raw.profile?.name==='string'&&raw.profile.name.trim()?raw.profile.name.slice(0,40):'Guest',theme:raw.profile?.theme==='light'?'light':'dark'}
  };
}
export function createStorage(storage){
  let memory=blank(),available=true;
  if(storage===undefined){try{storage=globalThis.localStorage;}catch{available=false;}}
  const read=()=>{if(available)try{const raw=storage?.getItem(KEY);if(raw)memory=sanitize(JSON.parse(raw));}catch{available=false;}return structuredClone(memory);};
  return {
    read,
    write(patch){memory=sanitize({...read(),...patch});if(available)try{storage?.setItem(KEY,JSON.stringify(memory));}catch{available=false;}return structuredClone(memory);},
    clear(){memory=blank();try{storage?.removeItem(KEY);storage?.removeItem('clubby.web.v2');}catch{available=false;}return structuredClone(memory);}
  };
}
