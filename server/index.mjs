import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { collect } from './providers.mjs';

const app=express();
const {Pool}=process.env.NODE_ENV === 'test' ? (await import('pg-mem')).newDb().adapters.createPg() : pg;
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const production=process.env.NODE_ENV==='production';
const studioOrigin=process.env.STUDIO_ORIGIN || 'http://localhost:5173';
const here=path.dirname(fileURLToPath(import.meta.url));
app.set('trust proxy', 1);
app.use(helmet({contentSecurityPolicy:false, crossOriginEmbedderPolicy:false}));
app.use(express.json({limit:'2mb'}));
app.use('/api',rateLimit({windowMs:60_000,limit:150,standardHeaders:'draft-7',legacyHeaders:false}));
const hash = token => createHash('sha256').update(token).digest('hex');
const fail=(res,status,message)=>res.status(status).json({error:message});
const cookie = req => (req.headers.cookie || '').split(';').map(v=>v.trim()).find(v=>v.startsWith('sf_session='))?.slice(11);
function sameOrigin(req,res,next) { if (['GET','HEAD','OPTIONS'].includes(req.method)) return next(); if (req.get('origin') !== studioOrigin) return fail(res,403,'Недопустимый источник запроса.'); next(); }
app.use('/api',sameOrigin);
const authenticate=async(req,res,next)=>{try{const token=cookie(req); if(!token)return fail(res,401,'Требуется вход.'); const {rows}=await pool.query('SELECT token_hash FROM sessions WHERE token_hash=$1 AND expires_at>NOW()',[hash(token)]);if(!rows.length)return fail(res,401,'Сессия истекла.');next();}catch(e){next(e)}};
app.get('/api/health',async(_req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true});}catch{res.status(503).json({ok:false});}});
app.post('/api/login',rateLimit({windowMs:15*60_000,limit:8,standardHeaders:'draft-7',legacyHeaders:false}),async(req,res,next)=>{try{
 const user=String(req.body.username||'');const password=String(req.body.password||'');const {rows}=await pool.query('SELECT password_hash FROM admins WHERE username=$1',[user]);
 const stored=rows[0]?.password_hash || '00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000';
 const [salt,expected]=stored.split(':');const digest=scryptSync(password,salt,32);const buffer=Buffer.from(expected,'hex');
 if(!rows.length || buffer.length!==digest.length || !timingSafeEqual(buffer,digest))return fail(res,401,'Неверный логин или пароль.');
 const token=randomBytes(32).toString('hex');await pool.query("INSERT INTO sessions(token_hash,expires_at) VALUES ($1,NOW()+INTERVAL '12 hours')",[hash(token)]);
 res.cookie('sf_session',token,{httpOnly:true,secure:production,sameSite:'strict',path:'/',maxAge:12*60*60*1000});res.json({ok:true});
 }catch(e){next(e)}});
app.get('/api/session',authenticate,(_req,res)=>res.json({ok:true}));
app.post('/api/logout',authenticate,async(req,res,next)=>{try{await pool.query('DELETE FROM sessions WHERE token_hash=$1',[hash(cookie(req))]);res.clearCookie('sf_session',{path:'/',httpOnly:true,secure:production,sameSite:'strict'});res.json({ok:true});}catch(e){next(e)}});
app.get('/api/public/demos/:id',async(req,res,next)=>{try{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id))return fail(res,404,'Демо не найдено.');const {rows}=await pool.query('SELECT data FROM companies WHERE id=$1',[req.params.id]);if(!rows.length)return fail(res,404,'Демо не найдено.');const c=rows[0].data;res.set('Cache-Control','no-store').json({name:c.name,description:c.description,phone:c.phone,address:c.address});}catch(e){next(e)}});
app.use('/api',authenticate);
const defaultCampaign={name:'Моя кампания',category:'Автосервисы',city:'Москва',template:'Автосервис'};
app.get('/api/state',async(_req,res,next)=>{try{const [campaign,companies]=await Promise.all([pool.query("SELECT data FROM settings WHERE key='campaign'"),pool.query('SELECT data FROM companies ORDER BY created_at DESC')]);res.json({campaign:campaign.rows[0]?.data || defaultCampaign,companies:companies.rows.map(r=>r.data)});}catch(e){next(e)}});
const validCompany = c => c && typeof c.id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.id) && typeof c.name==='string' && c.name.trim().length>0 && c.name.length<=200 && ['Новая','Просмотрена','Отправлено'].includes(c.status) && ['category','address','rating','reviews','phone','telegram','description','source'].every(k=>typeof c[k]==='string' && c[k].length<=2000);
app.put('/api/campaign',async(req,res,next)=>{try{const c=req.body;if(!['name','category','city','template'].every(k=>typeof c[k]==='string'&&c[k].length<=200) || !c.name.trim())return fail(res,400,'Некорректные данные кампании.');await pool.query("INSERT INTO settings(key,data) VALUES ('campaign',$1) ON CONFLICT(key) DO UPDATE SET data=EXCLUDED.data",[JSON.stringify(c)]);res.json({ok:true});}catch(e){next(e)}});
app.put('/api/companies/:id',async(req,res,next)=>{try{const c=req.body;if(!validCompany(c)||c.id!==req.params.id)return fail(res,400,'Некорректная карточка.');const {rowCount}=await pool.query('UPDATE companies SET data=$2 WHERE id=$1',[c.id,JSON.stringify(c)]);if(!rowCount)return fail(res,404,'Компания не найдена.');res.json({ok:true});}catch(e){next(e)}});
async function insertCompanies(items) {const client=await pool.connect();let added=[];try{await client.query('BEGIN');for(const c of items){if(!validCompany(c))throw new Error('Некорректная карточка компании.');const r=await client.query('INSERT INTO companies(id,source,external_id,data) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',[c.id,c.source,c.externalId || null,JSON.stringify(c)]);if(r.rowCount)added.push(c);}await client.query('COMMIT');return added;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
app.post('/api/companies/import',async(req,res,next)=>{try{const items=req.body.items;if(!Array.isArray(items)||items.length>500||!items.every(validCompany))return fail(res,400,'Можно импортировать не более 500 корректных карточек за раз.');res.json({items:await insertCompanies(items)});}catch(e){next(e)}});
app.post('/api/collect',rateLimit({windowMs:60_000,limit:5,standardHeaders:'draft-7',legacyHeaders:false}),async(req,res)=>{try{const {category,city,source}=req.body;const count=Number(req.body.count);if(typeof category!=='string'||!category.trim()||category.length>100||typeof city!=='string'||!city.trim()||city.length>100||!Number.isInteger(count)||count<1||count>60)return fail(res,400,'Укажите категорию, город и количество от 1 до 60.');const found=await collect({category,city,source,count});const items=await insertCompanies(found);res.json({items,found:found.length});}catch(e){console.error('collect error',e.message);fail(res,502,e.message?.startsWith('Не задан')||e.message?.startsWith('Источник')||e.message?.startsWith('2ГИС')?e.message:'Не удалось получить данные из источника.');}});
app.use('/api',(_req,res)=>fail(res,404,'Маршрут не найден.'));
app.use(express.static(path.join(here,'../dist'),{index:false}));
app.get('/{*path}',(_req,res)=>res.sendFile(path.join(here,'../dist/index.html')));
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Ошибка сервера.'});});
async function start(){if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');if(production && (!process.env.STUDIO_ORIGIN || !process.env.ADMIN_PASSWORD_HASH))throw new Error('STUDIO_ORIGIN and ADMIN_PASSWORD_HASH are required');await pool.query(`CREATE TABLE IF NOT EXISTS admins(username TEXT PRIMARY KEY,password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS companies(id UUID PRIMARY KEY,source TEXT NOT NULL,external_id TEXT,data JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(source,external_id));`);
if(process.env.ADMIN_PASSWORD_HASH)await pool.query('INSERT INTO admins(username,password_hash) VALUES($1,$2) ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash',[process.env.ADMIN_USERNAME||'admin',process.env.ADMIN_PASSWORD_HASH]);
await pool.query('DELETE FROM sessions WHERE expires_at<NOW()');app.listen(Number(process.env.PORT||7777),process.env.NODE_ENV==='test' ? '127.0.0.1' : '0.0.0.0',()=>console.log(`Siteflow listening on ${process.env.PORT||7777}`));}
start().catch(e=>{console.error(e);process.exit(1)});
