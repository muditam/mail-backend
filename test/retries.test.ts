import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {MongoMemoryServer} from 'mongodb-memory-server';
import {RetryQueue,submissionOutcome} from '../src/retries.js';
import {Stalwart} from '../src/stalwart.js';
import type {Store,Token} from '../src/store.js';
import type {Config} from '../src/config.js';
let mongo:MongoMemoryServer,client:MongoClient;
const key=randomBytes(32).toString('base64');
const config={STALWART_URL:'https://mail.test',SESSION_ENCRYPTION_KEY:key,SEND_RETRY_MAX_ATTEMPTS:3} as Config;
const token:Token={access_token:'private-access-token',refresh_token:'private-refresh-token',expires_at:Date.now()+86400_000};
const temporary={delivered:'no',smtpReply:'452 4.4.5 Rate limit exceeded, try again later.'};
const permanent={delivered:'no',smtpReply:'550 5.1.1 No such mailbox'};
before(async()=>{mongo=await MongoMemoryServer.create();client=await new MongoClient(mongo.getUri()).connect();});
after(async()=>{await client.close();await mongo.stop();});
async function setup(overrides:Partial<Config>={}){const db=client.db('retry_'+randomUUID().replaceAll('-',''));const q=new RetryQueue(db,{...config,...overrides});await q.init();return {q,db};}
async function schedule(q:RetryQueue,recipients=['blocked@example.test'],now=Date.now()-300_001){await q.schedule({accountId:'A',emailId:'E1',identityId:'I1',sender:'sender@example.test',submissionId:'S0',outcome:{retry:recipients,accepted:1,failed:0},token},now);}
function adapter(q:RetryQueue,status:Record<string,any>,mode='normal'){
 const provider=new Stalwart(config,{retries:q} as Store);const envelopes:any[]=[];let moves=0;
 (provider as any).call=async(session:any,calls:any[])=>{
  assert.equal(session.accountId,'A');const [method,args]=calls[0];assert.equal(args.accountId,'A');
  if(method==='Email/get')return [{list:mode==='deleted'?[]:[{id:'E1'}]}];
  if(method==='EmailSubmission/set'){
   assert.equal(args.create.retry.emailId,'E1');assert.equal(args.create.retry.identityId,'I1');envelopes.push(args.create.retry.envelope);
   assert.equal(args.onSuccessUpdateEmail,undefined);
   if(mode==='timeout')throw Error('Response lost after acceptance');
   if(mode==='not-created')return [{notCreated:{retry:{type:'forbiddenToSend'}}}];
   if(mode==='malformed-create')return [{}];
   return [{created:{retry:{id:'S1'}}}];
  }
  if(method==='EmailSubmission/get'){
   if(mode==='lookup-fails')throw Error('unavailable');
   return [{list:mode==='missing'?[]:[{id:'S1',emailId:'E1',deliveryStatus:status}]}];
  }
  if(method==='Mailbox/get')return [{list:[{id:'D',role:'drafts'},{id:'S',role:'sent'}]}];
  if(method==='Email/set'){moves++;assert.equal(args.create,undefined);assert.deepEqual(args.update.E1,{'mailboxIds/D':null,'mailboxIds/S':true,'keywords/$draft':null});return [{updated:{E1:null}}];}
  throw Error(method);
 };
 return {provider,envelopes,get moves(){return moves}};
}
test('only final no + 4xx recipients qualify, including BCC; queued/unknown/yes/5xx never retry',()=>{
 const result=submissionOutcome({deliveryStatus:{'a@x.test':temporary,'b@x.test':permanent,'c@x.test':{delivered:'queued',smtpReply:'451 try later'},'d@x.test':{delivered:'yes'},'e@x.test':{delivered:'unknown'}}},['A@x.test','a@x.test','b@x.test','c@x.test','d@x.test','e@x.test']);
 assert.deepEqual(result,{retry:['a@x.test'],accepted:3,failed:1});
 assert.equal(submissionOutcome({deliveryStatus:{}},['a@x.test']),undefined);
});
test('persistent jobs survive restart, encrypt credentials and isolate account status',async()=>{
 const {q,db}=await setup();await schedule(q);await schedule(q);assert.equal(await db.collection('delivery_retries').countDocuments(),1);
 const raw=await db.collection('delivery_retries').findOne();assert.ok(!JSON.stringify(raw).includes(token.access_token));assert.ok(!JSON.stringify(raw).includes(token.refresh_token));
 const restarted=new RetryQueue(db,config);assert.equal(await restarted.get('B','E1'),null);assert.equal((await restarted.summaries('B',['E1'])).size,0);
 const job=await restarted.claim();assert.ok(job);assert.deepEqual(restarted.token(job),token);
});
test('two workers claim only once and submit ONLY the failed recipient with original email ID',async()=>{
 const {q,db}=await setup();await schedule(q,['hidden@example.test']);
 const a=adapter(q,{'hidden@example.test':{delivered:'yes'}}),b=adapter(new RetryQueue(db,config),{'hidden@example.test':{delivered:'yes'}});
 await Promise.all([a.provider.retryOne(),b.provider.retryOne()]);
 assert.equal(a.envelopes.length+b.envelopes.length,1);
 assert.deepEqual([...a.envelopes,...b.envelopes][0],{mailFrom:{email:'sender@example.test'},rcptTo:[{email:'hidden@example.test'}]});
 const job=await q.get('A','E1');assert.equal(job?.state,'completed');assert.equal(job?.accepted,2);assert.equal(job?.credential,undefined);
 assert.equal(await a.provider.retryOne(),false);
 assert.ok(!JSON.stringify(q.summary(job!)).includes('hidden@example.test'));
});
test('each round removes successful and permanent recipients and retains only temporary failures',async()=>{
 const {q}=await setup();await schedule(q,['a@x.test','b@x.test','c@x.test']);
 const a=adapter(q,{'a@x.test':{delivered:'queued'},'b@x.test':temporary,'c@x.test':permanent});await a.provider.retryOne();
 let job=(await q.get('A','E1'))!;assert.equal(job.state,'waiting');assert.deepEqual(job.recipients,['b@x.test']);assert.equal(job.failed,1);assert.equal(job.attempts,1);
 const b=adapter(q,{'b@x.test':{delivered:'yes'}});await b.provider.retryOne(job.nextAt+1);
 assert.deepEqual(b.envelopes[0].rcptTo,[{email:'b@x.test'}]);job=(await q.get('A','E1'))!;assert.equal(job.state,'failed');assert.equal(job.failed,1);assert.equal(job.accepted,3);
});
for(const mode of ['timeout','lookup-fails','missing','malformed-create','deleted'])test(`${mode} stops automatic retry rather than duplicate uncertain delivery`,async()=>{
 const {q}=await setup();await schedule(q);const a=adapter(q,{},mode);await a.provider.retryOne();
 const job=(await q.get('A','E1'))!;assert.equal(job.state,'attention');assert.equal(job.credential,undefined);if(mode==='lookup-fails'||mode==='missing')assert.equal(job.submissionId,'S1');
 await a.provider.retryOne(Date.now()+3600_000);assert.equal(a.envelopes.length,mode==='deleted'?0:1);
});
test('stale workers are fenced and interrupted dispatches are never reclaimed for sending',async()=>{
 const {q}=await setup();await schedule(q);const old=(await q.claim())!;
 assert.equal(await q.claim(old.leaseUntil!+1),null);assert.equal(await q.dispatch(old),false);assert.equal((await q.get('A','E1'))?.state,'attention');
 const x=await setup();await schedule(x.q);const started=(await x.q.claim())!;assert.equal(await x.q.dispatch(started),true);
 assert.equal(await x.q.claim(started.leaseUntil!+1),null);assert.equal((await x.q.get('A','E1'))?.state,'attention');
});
test('confirmed response lost during MongoDB finish cannot cause a second network submission',async()=>{
 const {q}=await setup();await schedule(q);q.finish=async()=>{throw Error('database unavailable')};
 const a=adapter(q,{'blocked@example.test':{delivered:'yes'}});await a.provider.retryOne();await a.provider.retryOne(Date.now()+3600_000);
 assert.equal(a.envelopes.length,1);assert.equal((await q.get('A','E1'))?.state,'attention');
});
test('retry count and deadline are bounded and terminal jobs delete credentials',async()=>{
 const {q}=await setup({SEND_RETRY_MAX_ATTEMPTS:2});await schedule(q);const a=adapter(q,{'blocked@example.test':temporary});await a.provider.retryOne();let job=(await q.get('A','E1'))!;assert.equal(job.state,'waiting');await a.provider.retryOne(job.nextAt+1);job=(await q.get('A','E1'))!;assert.equal(job.state,'failed');assert.equal(job.failed,1);assert.equal(job.credential,undefined);assert.equal(a.envelopes.length,2);
 const x=await setup({SEND_RETRY_MAX_AGE_HOURS:1});await schedule(x.q,undefined,Date.now()-2*3600_000);assert.equal(await x.q.claim(),null);assert.equal((await x.q.get('A','E1'))?.state,'failed');assert.equal((await x.q.get('A','E1'))?.failed,1);
});
test('authorization failure never attempts a submission or leaks a credential',async()=>{
 const {q,db}=await setup();await schedule(q);await db.collection('delivery_retries').updateOne({},{$set:{credential:'corrupt'}});const a=adapter(q,{});await a.provider.retryOne();assert.equal(a.envelopes.length,0);assert.equal((await q.get('A','E1'))?.state,'attention');
});
test('queued draft and source draft cannot be edited/resubmitted, including after session changes',async()=>{
 const {q}=await setup();await q.schedule({accountId:'A',emailId:'E1',sourceDraftId:'old-draft',identityId:'I1',sender:'sender@example.test',submissionId:'S0',outcome:{retry:['blocked@example.test'],accepted:0,failed:0},token});
 assert.equal((await q.get('A','old-draft'))?.emailId,'E1');assert.equal(await q.get('B','old-draft'),null);
 const p=new Stalwart(config,{retries:q} as Store);let calls=0;(p as any).call=async()=>{calls++;throw Error('Must not reach provider')};
 for(const id of ['E1','old-draft']){
  const session={accountId:'A',id:'different-session'} as any;
  await assert.rejects(()=>p.draft(session,{draftId:id}),{code:'SEND_MANAGED'});
  await assert.rejects(()=>p.moveMessage(session,id,'trash'),{code:'SEND_MANAGED'});
  await assert.rejects(()=>p.deleteDraft(session,id),{code:'SEND_MANAGED'});
 }
 assert.equal(calls,0);
});
test('expired job token refresh is persisted before submission and can outlive browser session',async()=>{
 const {q}=await setup();await q.schedule({accountId:'A',emailId:'E1',identityId:'I1',sender:'sender@example.test',submissionId:'S0',outcome:{retry:['blocked@example.test'],accepted:0,failed:0},token:{...token,expires_at:0}},Date.now()-300_001);
 const a=adapter(q,{'blocked@example.test':temporary});let refreshed=0;
 (a.provider as any).json=async(_url:string,request:any)=>{refreshed++;assert.equal(request.body.get('grant_type'),'refresh_token');return {status:200,body:{access_token:'renewed',refresh_token:'renewed-refresh',expires_in:3600}}};
 await a.provider.retryOne();const job=(await q.get('A','E1'))!;
 assert.equal(refreshed,1);assert.equal(a.envelopes.length,1);assert.equal(job.state,'waiting');assert.equal(q.token(job).access_token,'renewed');
});
test('provider authorization revocation stops retries without a send',async()=>{
 const {q}=await setup();await q.schedule({accountId:'A',emailId:'E1',identityId:'I1',sender:'sender@example.test',submissionId:'S0',outcome:{retry:['blocked@example.test'],accepted:0,failed:0},token:{...token,expires_at:0}},Date.now()-300_001);
 const a=adapter(q,{});(a.provider as any).json=async()=>({status:401,body:{}});await a.provider.retryOne();assert.equal(a.envelopes.length,0);assert.equal((await q.get('A','E1'))?.state,'attention');
});
