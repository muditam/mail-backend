import Fastify, {type FastifyInstance, type FastifyRequest} from 'fastify';
import multipart from '@fastify/multipart';
import {z} from 'zod';
import {Readable} from 'node:stream';
import type {Config} from './config.js';
import {AppError,invalid,unavailable} from './errors.js';
import {Store,type Session} from './store.js';
import {Stalwart} from './stalwart.js';

const address=z.string().email().max(254), id=z.string().min(1).max(255), recipients=z.array(address).max(100);
const payload=z.object({draftId:id.optional(),to:recipients,cc:recipients.optional().default([]),bcc:recipients.optional().default([]),subject:z.string().max(998),bodyText:z.string().max(1024*1024),attachmentIds:z.array(id).max(10)}).strict();
const login=z.object({email:address,password:z.string().min(1).max(1024)}).strict();
const cookieName='webmail_sid';
const rate=new Map<string,{count:number;until:number}>();
function throttle(key:string,max:number,windowMs:number){const now=Date.now();let item=rate.get(key);if(!item||item.until<now){item={count:0,until:now+windowMs};rate.set(key,item);}if(++item.count>max)throw new AppError('RATE_LIMITED',429,'Too many requests. Try again later.');}
function cookie(request:FastifyRequest){const raw=request.headers.cookie||'';return raw.split(';').map(x=>x.trim().split('=')).find(x=>x[0]===cookieName)?.[1]||'';}
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const r=schema.safeParse(value);if(!r.success)throw invalid();return r.data;}
function origin(request:FastifyRequest,config:Config){const value=request.headers.origin||request.headers.referer;if(value&&new URL(value).origin===new URL(config.APP_ORIGIN).origin)return;throw new AppError('CSRF_FAILED',403,'Request origin could not be verified.');}
function secureCookie(config:Config,id:string,maxAge:number){return `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.NODE_ENV==='production'?'; Secure':''}`;}
export function buildApp(config:Config,store:Store,stalwart:Stalwart):FastifyInstance{
 const app=Fastify({logger:{level:'info',redact:{paths:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie'],censor:'[redacted]'}},bodyLimit:1200000,trustProxy:false});
 app.register(multipart,{limits:{files:1,fileSize:20*1024*1024,fields:0,parts:1}});
 app.setErrorHandler((error,request,reply)=>{let e=error instanceof AppError?error:unavailable();if((error as any).code==='FST_REQ_FILE_TOO_LARGE')e=new AppError('ATTACHMENT_TOO_LARGE',413,'Attachment exceeds 20 MB.');else if((error as any).code==='FST_ERR_CTP_BODY_TOO_LARGE')e=new AppError('INVALID_REQUEST',413,'Request is too large.');request.log.warn({requestId:request.id,route:request.routeOptions.url,code:e.code,status:e.status},'request failed');reply.code(e.status).send({error:{code:e.code,message:e.message,requestId:request.id}});});
 app.addHook('onRequest',async(request,reply)=>{reply.header('Cache-Control','no-store');reply.header('X-Content-Type-Options','nosniff');});
 const authenticated=new WeakMap<FastifyRequest,Session>();
 const sessionCookie=(s:Session)=>{
  // Match the store's sliding idle deadline without extending the absolute lifetime.
  const deadline=Math.min(s.touchedAt+config.SESSION_IDLE_MINUTES*60000,s.absoluteExpiresAt);
  return secureCookie(config,s.id,Math.max(0,Math.floor((deadline-Date.now())/1000)));
 };
 app.addHook('onSend',async(request,reply,payload)=>{
  const s=authenticated.get(request);
  // Failed requests do not renew cookies; explicit login/logout cookies take precedence.
  if(s&&reply.statusCode>=200&&reply.statusCode<300&&!reply.hasHeader('Set-Cookie'))reply.header('Set-Cookie',sessionCookie(s));
  return payload;
 });
 const session=async(request:FastifyRequest)=>{const sid=cookie(request);const s=sid&&await store.get(sid);if(!s)throw new AppError('SESSION_EXPIRED',401,'Please sign in again.');authenticated.set(request,s);return s;};
 const state=async(request:FastifyRequest)=>{origin(request,config);const s=await session(request);const csrf=request.headers['x-csrf-token'];if(typeof csrf!=='string'||!await store.checkCsrf(s.id,csrf))throw new AppError('CSRF_FAILED',403,'Invalid CSRF token.');return s;};
 app.get('/health',async()=>({status:'ok'}));
 app.get('/ready',async()=>{await store.ready();return {status:'ok'};});
 app.post('/api/app/v1/auth/login',async(request,reply)=>{origin(request,config);const body=parse(login,request.body);const ip=request.ip;throttle(`ip:${ip}`,20,15*60000);throttle(`account:${body.email.toLowerCase()}`,10,15*60000);const {token,accountId}=await stalwart.login(body.email,body.password);const old=cookie(request);if(old)await store.delete(old);const s=await store.create(body.email.toLowerCase(),accountId,token);reply.header('Set-Cookie',sessionCookie(s));return {user:{email:s.email},csrfToken:s.csrf};});
 app.get('/api/app/v1/auth/session',async(request)=>{const s=await session(request);return {user:{email:s.email},csrfToken:store.csrfToken(s.id)};});
 app.post('/api/app/v1/auth/logout',async(request,reply)=>{const s=await state(request);await store.delete(s.id);reply.header('Set-Cookie',secureCookie(config,'',0)).code(204).send();});
 app.get('/api/app/v1/mailboxes',async(request)=>{const s=await session(request);throttle(`mailboxes:${s.id}`,30,60000);return {mailboxes:await stalwart.mailboxes(s)};});
 app.get('/api/app/v1/messages',async(request)=>{const q=parse(z.object({mailboxId:id.optional(),starred:z.enum(['true']).optional(),q:z.string().trim().min(1).max(256).optional(),cursor:z.string().regex(/^\d{1,8}$/).optional(),limit:z.coerce.number().int().min(1).max(100).default(30)}).strict().refine(q=>!!q.mailboxId||!!q.q||q.starred==='true'),request.query),s=await session(request);throttle(`messages:${s.id}`,60,60000);if(q.q)throttle(`search:${s.id}`,20,60000);return stalwart.messages(s,q.mailboxId,Number(q.cursor||0),q.limit,q.q,q.starred==='true'?true:undefined);});
 app.get('/api/app/v1/messages/:id',async(request)=>{const p=parse(z.object({id}),request.params);return {message:await stalwart.message(await session(request),p.id)};});
 app.post('/api/app/v1/messages/:id/report',async(request,reply)=>{const s=await state(request),p=parse(z.object({id}),request.params);parse(z.object({}).strict(),request.body);throttle(`report:${s.id}`,10,60000);const submissionId=await stalwart.report(s,p.id);return reply.code(202).send({status:'queued',submissionId});});
 app.patch('/api/app/v1/messages/:id',async(request)=>{const s=await state(request),p=parse(z.object({id}),request.params),b=parse(z.object({isRead:z.boolean()}).strict(),request.body);return {message:await stalwart.read(s,p.id,b.isRead)};});
 app.patch('/api/app/v1/messages/:id/star',async(request)=>{const s=await state(request),p=parse(z.object({id}),request.params),body=parse(z.object({isStarred:z.boolean()}).strict(),request.body);throttle(`star:${s.id}`,60,60000);return {message:await stalwart.star(s,p.id,body.isStarred)};});
 app.post('/api/app/v1/messages/:id/move',async(request)=>{const s=await state(request),p=parse(z.object({id}),request.params),body=parse(z.object({action:z.enum(['trash','restore'])}).strict(),request.body);throttle(`move:${s.id}`,60,60000);return {message:await stalwart.moveMessage(s,p.id,body.action)};});
 app.post('/api/app/v1/attachments',async(request,reply)=>{const s=await state(request);throttle(`upload:${s.id}`,30,60000);const part=await request.file();if(!part||part.fieldname!=='file')throw invalid();const chunks:Buffer[]=[];let size=0;for await(const chunk of part.file){size+=chunk.length;if(size>20*1024*1024)throw new AppError('ATTACHMENT_TOO_LARGE',413,'Attachment exceeds 20 MB.');chunks.push(chunk);}if(part.file.truncated)throw new AppError('ATTACHMENT_TOO_LARGE',413,'Attachment exceeds 20 MB.');const name=part.filename.replace(/[\r\n\\/\x00-\x1f]/g,'_').slice(0,255);const type=/^[\w.+-]+\/[\w.+-]+$/.test(part.mimetype)?part.mimetype:'application/octet-stream';return reply.code(201).send({attachment:await stalwart.upload(s,Buffer.concat(chunks),name,type)});});
 app.get('/api/app/v1/attachments/:id',async(request,reply)=>{const p=parse(z.object({id}),request.params),file=await stalwart.download(await session(request),p.id);const safe=file.name.replace(/["\\\r\n]/g,'_');reply.header('Content-Type','application/octet-stream').header('Content-Disposition',`attachment; filename="${safe}"`).header('X-Content-Type-Options','nosniff');return reply.send(Readable.fromWeb(file.body as any));});
 app.post('/api/app/v1/drafts',async(request)=>{const s=await state(request),p=parse(payload,request.body);return {draftId:await stalwart.draft(s,p)};});
 app.delete('/api/app/v1/drafts/:id',async(request,reply)=>{const s=await state(request),p=parse(z.object({id}),request.params);await stalwart.deleteDraft(s,p.id);return reply.code(204).send();});
 app.post('/api/app/v1/messages/send',async(request,reply)=>{const s=await state(request),p=parse(payload,request.body);if(!p.to.length)throw invalid();throttle(`send:${s.id}`,20,60000);const submissionId=await stalwart.send(s,p);return reply.code(202).send({submissionId,status:'queued'});});
 return app;
}
