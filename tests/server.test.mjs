import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { collect } from '../server/providers.mjs';

test('API: auth, CSRF, import, editing, public demo, missing key and logout', async t => {
 const salt=randomBytes(16).toString('hex'), password='local-test-password-only';
 const hash=`${salt}:${scryptSync(password,salt,32).toString('hex')}`;
 const port=22000+Math.floor(Math.random()*15000), origin='http://localhost:5173';
 const child=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,NODE_ENV:'test',DATABASE_URL:'test',PORT:String(port),STUDIO_ORIGIN:origin,ADMIN_PASSWORD_HASH:hash,GOOGLE_PLACES_API_KEY:''},stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('API startup timeout')),10000);child.stdout.on('data',data=>{if(data.toString().includes('Siteflow listening')){clearTimeout(timer);resolve();}});child.on('exit',code=>reject(new Error(`API exited ${code}`)));});
 const call=(path,opts={})=>fetch(`http://127.0.0.1:${port}${path}`,opts);
 let r=await call('/api/state');assert.equal(r.status,401);
 r=await call('/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:JSON.stringify({username:'admin',password})});assert.equal(r.status,403);
 r=await call('/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'admin',password})});assert.equal(r.status,200);
 const headers={'Content-Type':'application/json',Origin:origin,Cookie:r.headers.get('set-cookie').split(';')[0]};
 r=await call('/api/state',{headers});assert.equal(r.status,200);assert.deepEqual((await r.json()).companies,[]);
 const item={id:crypto.randomUUID(),name:'Test',category:'Repair',address:'Address',rating:'',reviews:'',phone:'123',telegram:'',description:'Details',status:'Новая',source:'CSV'};
 r=await call('/api/companies/import',{method:'POST',headers,body:JSON.stringify({items:[item]})});assert.equal(r.status,200);
 r=await call(`/api/public/demos/${item.id}`);assert.equal((await r.json()).name,'Test');
 item.name='Updated';r=await call(`/api/companies/${item.id}`,{method:'PUT',headers,body:JSON.stringify(item)});assert.equal(r.status,200);
 r=await call(`/api/public/demos/${item.id}`);assert.equal((await r.json()).name,'Updated');
 r=await call('/api/collect',{method:'POST',headers,body:JSON.stringify({source:'Google Maps',category:'Repair',city:'Moscow',count:1})});assert.equal(r.status,502);
 r=await call('/api/logout',{method:'POST',headers});assert.equal(r.status,200);r=await call('/api/state',{headers});assert.equal(r.status,401);
});
test('provider adapters map responses and omit empty results', async t => {
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old});
 globalThis.fetch=async url=>{const u=String(url);if(u.includes('googleapis'))return Response.json({places:[{id:'g1',displayName:{text:'Google'},formattedAddress:'Address',internationalPhoneNumber:'+123',rating:4.9}]});if(u.includes('yandex'))return Response.json({features:[{properties:{CompanyMetaData:{id:'y1',name:'Yandex',address:'Address',Phones:[{formatted:'+123'}]}}}]});return Response.json({meta:{code:200},result:{items:[{id:'d1',name:'2GIS',full_address_name:'Address',contact_groups:[{contacts:[{type:'phone',text:'+123'}]}]}]}});};
 for(const [source,keys] of [['Google Maps',{GOOGLE_PLACES_API_KEY:'x'}],['Яндекс Карты',{YANDEX_MAPS_API_KEY:'x'}],['2ГИС',{TWOGIS_API_KEY:'x'}]]){const items=await collect({source,category:'Repair',city:'Moscow',count:1},keys);assert.equal(items.length,1);assert.equal(items[0].phone,'+123');assert.equal(items[0].source,source);}
});
