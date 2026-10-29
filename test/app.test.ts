import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MongoMemoryServer} from 'mongodb-memory-server';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {Store} from '../src/store.js';
import type {Config} from '../src/config.js';
import type {Stalwart} from '../src/stalwart.js';
import {AppError} from '../src/errors.js';

async function setup(){const mongo=await MongoMemoryServer.create();const config:Config={NODE_ENV:'test',HOST:'127.0.0.1',PORT:3000,APP_ORIGIN:'http://localhost:5173',STALWART_URL:'https://mail.example.test',STALWART_AUTH_URL:'https://mail.example.test/api/auth',STALWART_TOKEN_URL:'https://mail.example.test/auth/token',STALWART_JMAP_SESSION_URL:'https://mail.example.test/.well-known/jmap',OAUTH_CLIENT_ID:'test',OAUTH_REDIRECT_URI:'https://app.example.test/callback',SESSION_ENCRYPTION_KEY:randomBytes(32).toString('base64'),MONGODB_URI:mongo.getUri(),MONGODB_DB_NAME:'webmail_test',SESSION_IDLE_MINUTES:30,SESSION_ABSOLUTE_HOURS:12};const store=await Store.connect(config);const adapter={login:async(email:string,password:string)=>{if(password!=='correct')throw new Error('bad');return {accountId:email,token:{access_token:'secret',expires_at:Date.now()+3600000}};},mailboxes:async(s:any)=>[{id:s.accountId,name:'Inbox',role:'inbox',unreadCount:0,totalCount:0}],messages:async(s:any,box:string)=>({messages:[{id:`${s.accountId}:${box}`}]}),send:async()=>{throw new AppError('SEND_STATUS_UNKNOWN',503,'Could not confirm send.');}} as unknown as Stalwart;const app=buildApp(config,store,adapter);return {app,store,close:async()=>{await app.close();await store.close();await mongo.stop();}};}
const origin={'origin':'http://localhost:5173'};
test('login, session restore, CSRF, logout and isolation',async()=>{const x=await setup();try{const log=async(email:string)=>{const r=await x.app.inject({method:'POST',url:'/api/app/v1/auth/login',headers:origin,payload:{email,password:'correct'}});assert.equal(r.statusCode,200);return {cookie:r.headers['set-cookie'] as string,csrf:r.json().csrfToken};};const a=await log('a@example.test'),b=await log('b@example.test');const boxes=async(c:string)=>x.app.inject({method:'GET',url:'/api/app/v1/mailboxes',headers:{cookie:c}});assert.equal((await boxes(a.cookie)).json().mailboxes[0].id,'a@example.test');assert.equal((await boxes(b.cookie)).json().mailboxes[0].id,'b@example.test');const forbidden=await x.app.inject({method:'POST',url:'/api/app/v1/auth/logout',headers:{...origin,cookie:a.cookie,'x-csrf-token':'wrong'}});assert.equal(forbidden.statusCode,403);const out=await x.app.inject({method:'POST',url:'/api/app/v1/auth/logout',headers:{...origin,cookie:a.cookie,'x-csrf-token':a.csrf}});assert.equal(out.statusCode,204);assert.equal((await boxes(a.cookie)).statusCode,401);assert.equal((await boxes(b.cookie)).statusCode,200);}finally{await x.close();}});
test('validation and send errors use contract envelope',async()=>{const x=await setup();try{const bad=await x.app.inject({method:'POST',url:'/api/app/v1/auth/login',headers:origin,payload:{email:'bad',password:'x'}});assert.equal(bad.statusCode,400);assert.equal(bad.json().error.code,'INVALID_REQUEST');const l=await x.app.inject({method:'POST',url:'/api/app/v1/auth/login',headers:origin,payload:{email:'a@example.test',password:'correct'}});const r=await x.app.inject({method:'POST',url:'/api/app/v1/messages/send',headers:{...origin,cookie:l.headers['set-cookie'] as string,'x-csrf-token':l.json().csrfToken},payload:{to:['b@example.test'],subject:'Hi',bodyText:'Hello',attachmentIds:[]}});assert.equal(r.statusCode,503);assert.equal(r.json().error.code,'SEND_STATUS_UNKNOWN');}finally{await x.close();}});

test('one session cannot hammer mailbox refresh endpoints',async()=>{
 const x=await setup();
 try{
  const login=await x.app.inject({method:'POST',url:'/api/app/v1/auth/login',headers:origin,payload:{email:'a@example.test',password:'correct'}});
  const headers={cookie:login.headers['set-cookie'] as string};
  for(let i=0;i<30;i++)assert.equal((await x.app.inject({method:'GET',url:'/api/app/v1/mailboxes',headers})).statusCode,200);
  const blockedBoxes=await x.app.inject({method:'GET',url:'/api/app/v1/mailboxes',headers});
  assert.equal(blockedBoxes.statusCode,429);
  assert.equal(blockedBoxes.json().error.code,'RATE_LIMITED');
  for(let i=0;i<60;i++)assert.equal((await x.app.inject({method:'GET',url:'/api/app/v1/messages?mailboxId=a%40example.test',headers})).statusCode,200);
  const blockedMessages=await x.app.inject({method:'GET',url:'/api/app/v1/messages?mailboxId=a%40example.test',headers});
  assert.equal(blockedMessages.statusCode,429);
  assert.equal(blockedMessages.json().error.code,'RATE_LIMITED');
 }finally{await x.close();}
});

test('browser session slides during activity but respects idle, absolute expiry and revocation',async(t)=>{
 const x=await setup();
 let now=Date.now();
 t.mock.method(Date,'now',()=>now);
 const minute=60000;
 let browserCookie='',cookieDeadline=0;
 const acceptCookie=(value:unknown)=>{
  assert.equal(typeof value,'string');
  const header=value as string;
  assert.match(header,/HttpOnly; SameSite=Lax/);
  browserCookie=header.split(';')[0];
  cookieDeadline=now+Number(/Max-Age=(\d+)/.exec(header)![1])*1000;
 };
 const signIn=async()=>{
  const r=await x.app.inject({method:'POST',url:'/api/app/v1/auth/login',headers:origin,payload:{email:'active@example.test',password:'correct'}});
  assert.equal(r.statusCode,200);
  acceptCookie(r.headers['set-cookie']);
  return r.json().csrfToken as string;
 };
 const boxes=()=>x.app.inject({method:'GET',url:'/api/app/v1/mailboxes',headers:{cookie:now<cookieDeadline?browserCookie:''}});
 try{
  await signIn();
  const start=now;
  assert.equal(cookieDeadline,start+30*minute);
  // Model browser expiry, not just Fastify injection with an immortal cookie.
  for(let elapsed=20;elapsed<720;elapsed+=20){
   now=start+elapsed*minute;
   const r=await boxes();
   assert.equal(r.statusCode,200,`active session at minute ${elapsed}`);
   acceptCookie(r.headers['set-cookie']);
   assert.equal(cookieDeadline,Math.min(now+30*minute,start+720*minute));
  }
  const originalCookie=browserCookie;
  now=start+720*minute;
  assert.equal((await boxes()).statusCode,401);
  // Absolute expiry is enforced server-side even if the client keeps the cookie.
  const absolute=await x.app.inject({method:'GET',url:'/api/app/v1/mailboxes',headers:{cookie:originalCookie}});
  assert.equal(absolute.statusCode,401);
  assert.equal(absolute.headers['set-cookie'],undefined);

  await signIn();
  const idleCookie=browserCookie;
  now+=30*minute;
  const idle=await x.app.inject({method:'GET',url:'/api/app/v1/mailboxes',headers:{cookie:idleCookie}});
  assert.equal(idle.statusCode,401);
  assert.equal(idle.headers['set-cookie'],undefined);

  const csrf=await signIn();
  const forbidden=await x.app.inject({method:'POST',url:'/api/app/v1/auth/logout',headers:{...origin,cookie:browserCookie,'x-csrf-token':'wrong'}});
  assert.equal(forbidden.statusCode,403);
  assert.equal(forbidden.headers['set-cookie'],undefined);
  const failed=await x.app.inject({method:'POST',url:'/api/app/v1/messages/send',headers:{...origin,cookie:browserCookie,'x-csrf-token':csrf},payload:{to:['b@example.test'],subject:'Hi',bodyText:'Hello',attachmentIds:[]}});
  assert.equal(failed.statusCode,503);
  assert.equal(failed.headers['set-cookie'],undefined);
  const out=await x.app.inject({method:'POST',url:'/api/app/v1/auth/logout',headers:{...origin,cookie:browserCookie,'x-csrf-token':csrf}});
  assert.equal(out.statusCode,204);
  assert.match(out.headers['set-cookie'] as string,/webmail_sid=;.*Max-Age=0/);
  assert.equal((await boxes()).statusCode,401);

  await signIn();
  await x.store.delete(browserCookie.slice('webmail_sid='.length));
  assert.equal((await boxes()).statusCode,401);
 }finally{
  t.mock.restoreAll();
  await x.close();
 }
});
