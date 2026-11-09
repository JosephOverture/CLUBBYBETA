import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import pg from 'pg';
import { postgresBinaries } from './postgres-binaries.mjs';

const root=process.cwd();
const identity=createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0,16);
const directory=process.platform==='win32' && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA,'ClubbyPlatform',identity) : resolve('.local-data/runtime');
await mkdir(directory,{recursive:true});
let settings;
try { settings=JSON.parse(await readFile(join(directory,'runtime.json'),'utf8')); }
catch(error) {
  if(error.code!=='ENOENT') throw new Error('Cannot read local configuration; existing data was preserved.');
  settings={password:randomBytes(32).toString('hex'),encryptionKey:randomBytes(32).toString('hex')};
  await writeFile(join(directory,'runtime.json'),JSON.stringify(settings),{flag:'wx',mode:0o600});
}
if(!/^[a-f0-9]{64}$/.test(settings.password)||!/^[a-f0-9]{64}$/.test(settings.encryptionKey)) throw new Error('Invalid local configuration; refusing to reset it.');
const port=Number(process.env.LOCAL_API_PORT??4100),webPort=Number(process.env.WEB_PORT??8081);
for(const p of [port,webPort]) if(!Number.isInteger(p)||p<1||p>65535) throw new Error('Invalid local port.');
if(port===webPort) throw new Error('API and website need different ports.');
const databasePort=Number(process.env.LOCAL_DATABASE_PORT??5433);
if(!Number.isInteger(databasePort)||databasePort<1||databasePort>65535) throw new Error('Invalid database port.');
const url=process.env.DATABASE_URL??`postgresql://clubby:${settings.password}@127.0.0.1:${databasePort}/postgres`;
const databaseUrl=new URL(url);
if(!['postgres:','postgresql:'].includes(databaseUrl.protocol)||!['localhost','127.0.0.1','[::1]'].includes(databaseUrl.hostname))
  throw new Error('The local launcher only uses a loopback PostgreSQL database.');
const apiOrigin=`http://127.0.0.1:${port}`;
const origins=[`http://localhost:${webPort}`,`http://127.0.0.1:${webPort}`,apiOrigin];
const env={...process.env,APP_ENV:'development',HOST:'127.0.0.1',PORT:String(port),DATABASE_URL:url,
  PUBLIC_API_URL:apiOrigin,API_TARGET:apiOrigin,WEB_ORIGINS:origins.join(','),WEB_PORT:String(webPort),
  APP_ENCRYPTION_KEY:settings.encryptionKey,EMAIL_MODE:'file',STORAGE_MODE:'file',STRIPE_MODE:'disabled',LIVE_COMMERCE:'false',CI:'1'};
const children=[];
let shuttingDown=false,ownedDatabase=false,binaries,postgres;
let stop;
const stopped=new Promise(done=>{stop=done;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop());
const redact=text=>text.replaceAll(settings.password,'[redacted]').replaceAll(settings.encryptionKey,'[redacted]').replaceAll(url,'[database]');
const run=(exe,args)=>new Promise((ok,fail)=>{
  const child=spawn(exe,args,{cwd:root,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',c=>{output+=c;});child.stderr.on('data',c=>{output+=c;});
  child.on('error',fail);child.on('exit',code=>code===0?ok(output):fail(new Error(`Local command failed (${code}): ${redact(output)}`)));
});
function service(args,cwd=root){
  const child=spawn(process.execPath,args,{cwd,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  children.push(child);
  child.stdout.on('data',c=>process.stdout.write(redact(String(c))));child.stderr.on('data',c=>process.stderr.write(redact(String(c))));
  child.on('error',()=>{process.exitCode=1;stop();});
  child.on('exit',()=>{if(!shuttingDown){process.exitCode=1;stop();}});
}
async function stopService(child){
  if(child.exitCode!==null||child.signalCode!==null||!child.pid)return;
  await new Promise(done=>{
    const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},10000);
    child.once('exit',()=>{clearTimeout(timer);done();});
    child.once('error',()=>{clearTimeout(timer);done();});
    child.kill('SIGTERM');
  });
}
async function freePort(p){
  const probe=createServer();
  await new Promise((ok,fail)=>{probe.once('error',fail);probe.listen(p,'127.0.0.1',()=>probe.close(ok));});
}
async function ready(origin){
  for(let attempt=0;attempt<120;attempt++){
    if(process.exitCode)throw new Error('A local service exited during startup.');
    try{if((await fetch(origin+'/health/ready',{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}
    await delay(250);
  }
  throw new Error('Local API startup timed out.');
}
try {
  await freePort(port);
  if(process.argv.includes('--web')||process.argv.includes('--mobile'))await freePort(webPort);
  if(!process.env.DATABASE_URL){
    binaries=await postgresBinaries();
    const data=join(directory,'postgres');
    let initialized=true;try{await access(join(data,'PG_VERSION'));}catch{initialized=false;}
    if(!initialized){
      const pwfile=join(directory,'init-password');await writeFile(pwfile,settings.password,{mode:0o600});
      try{await run(binaries.initdb,['-D',data,'-U','clubby','-A','scram-sha-256','--pwfile',pwfile,'--encoding=UTF8','--locale=C']);}
      finally{await unlink(pwfile);}
    }
    await freePort(databasePort);
    postgres=spawn(binaries.postgres,['-D',data,'-h','127.0.0.1','-p',String(databasePort)],{windowsHide:true,shell:false,stdio:['ignore','ignore','pipe']});
    let startupError;postgres.on('error',error=>{startupError=error;});postgres.stderr.on('data',()=>{});
    postgres.on('exit',()=>{if(ownedDatabase&&!shuttingDown){ownedDatabase=false;process.exitCode=1;stop();}});
    for(let attempt=0;attempt<120;attempt++){
      if(startupError||postgres.exitCode!==null)throw new Error('Local PostgreSQL could not start.');
      const probe=new pg.Client({connectionString:url,connectionTimeoutMillis:500});
      try{await probe.connect();ownedDatabase=true;}catch{}finally{await probe.end().catch(()=>{});}
      if(ownedDatabase)break;await delay(250);
    }
    if(!ownedDatabase)throw new Error('Local PostgreSQL startup timed out.');
    const pid=Number((await readFile(join(data,'postmaster.pid'),'utf8')).split(/\r?\n/)[0]);
    if(pid!==postgres.pid){ownedDatabase=false;throw new Error('Database ownership verification failed.');}
    const client=new pg.Client({connectionString:url});await client.connect();
    try{const actual=await client.query('SHOW data_directory');if(resolve(actual.rows[0].data_directory).toLowerCase()!==resolve(data).toLowerCase()){ownedDatabase=false;throw new Error('Unexpected database directory.');}}
    finally{await client.end();}
  }
  await run(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/migrate.ts']);
  await run(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/seed.ts']);
  service(['node_modules/tsx/dist/cli.mjs','apps/api/src/main.ts']);
  service(['node_modules/tsx/dist/cli.mjs','apps/worker/src/main.ts']);
  await ready(apiOrigin);
  if(process.argv.includes('--web'))service(['scripts/beta-server.mjs']);
  if(process.argv.includes('--mobile'))service(['node_modules/expo/bin/cli','start','--web','--localhost','--port',String(webPort)],join(root,'apps/mobile'));
  console.log(`Local API: ${apiOrigin} · development email: .local-data/mail`);
  if(process.argv.includes('--smoke')){
    const catalogue=await(await fetch(apiOrigin+'/v1/venues?city=milano&limit=100')).json();
    if(!catalogue.data?.some(v=>v.id==='alcatraz'&&v.externalUrl))throw new Error('Seeded catalogue is unavailable.');
    if(process.argv.includes('--web')){
      const website=`http://127.0.0.1:${webPort}`;
      await ready(website);
      if(!(await fetch(website)).ok)throw new Error('Website unavailable.');
      const state=await fetch(website+'/v1/beta/state');
      if(!state.ok||!state.headers.get('set-cookie'))throw new Error('Visitor persistence unavailable.');
      const cookie=state.headers.get('set-cookie').split(';')[0];
      const reset=await fetch(website+'/v1/beta/state',{method:'DELETE',headers:{cookie,origin:website}});
      if(!reset.ok)throw new Error('Visitor reset unavailable.');
    }
    console.log('Persistent local frontend/backend startup smoke passed.');
  }else await stopped;
} finally {
  shuttingDown=true;
  await Promise.all(children.map(stopService));
  if(ownedDatabase&&binaries)await run(binaries.pg_ctl,['-D',join(directory,'postgres'),'stop','-m','fast','-w']);
  else if(postgres&&postgres.exitCode===null)postgres.kill('SIGTERM');
}
