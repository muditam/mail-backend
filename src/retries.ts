import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {type Collection,type Db,MongoServerError} from 'mongodb';
import type {Token} from './store.js';
import type {Config} from './config.js';

export type RetryState='waiting'|'working'|'dispatching'|'completed'|'failed'|'attention';
export type RetrySummary={state:RetryState;attempts:number;nextAttemptAt?:string;pending:number;failed:number;accepted:number};
export type RetryJob={_id:string;accountId:string;emailId:string;sourceDraftId?:string;identityId:string;sender:string;recipients:string[];submissionId:string;credential?:string;state:RetryState;attempts:number;nextAt:number;deadline:number;failed:number;accepted:number;lease?:string;leaseUntil?:number;reason?:string;expireAt?:Date};
export type Outcome={retry:string[];failed:number;accepted:number};
// "no" is a terminal recipient result even when SMTP suggests a later attempt.
// "queued" is owned by Stalwart; "unknown" may already have been handed off.
export function submissionOutcome(submission:any,recipients:string[]):Outcome|undefined{
 if(!submission||!submission.deliveryStatus||typeof submission.deliveryStatus!=='object')return;
 const statuses=new Map(Object.entries(submission.deliveryStatus).map(([email,value])=>[email.toLowerCase(),value as any]));
 const result:Outcome={retry:[],failed:0,accepted:0};
 for(const email of [...new Set(recipients.map(x=>x.toLowerCase()))]){
  const value=statuses.get(email);
  if(!value||!['yes','no','queued','unknown'].includes(value.delivered))return;
  if(value.delivered==='no'){
   if(typeof value.smtpReply==='string'&&/^4\d\d(?:[ -]|$)/.test(value.smtpReply))result.retry.push(email);
   else result.failed++;
  }else result.accepted++;
 }
 return result;
}
export class RetryQueue{
 private jobs:Collection<RetryJob>;
 private key:Buffer;
 constructor(db:Db,private config:Config){this.jobs=db.collection<RetryJob>('delivery_retries');this.key=Buffer.from(config.SESSION_ENCRYPTION_KEY,'base64');}
 async init(){await this.jobs.createIndex({state:1,nextAt:1});await this.jobs.createIndex({accountId:1,emailId:1});await this.jobs.createIndex({accountId:1,sourceDraftId:1});await this.jobs.createIndex({expireAt:1},{expireAfterSeconds:0});}
 private id(accountId:string,emailId:string){return createHash('sha256').update(JSON.stringify([accountId,emailId])).digest('hex');}
 private seal(token:Token){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);const data=Buffer.concat([c.update(JSON.stringify(token)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');}
 token(job:RetryJob):Token{if(!job.credential)throw Error('Retry credential unavailable');const b=Buffer.from(job.credential,'base64'),d=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}
 private delay(attempts:number){return Math.min(5*60_000*3**attempts,60*60_000);}
 async schedule(input:{accountId:string;emailId:string;sourceDraftId?:string;identityId:string;sender:string;submissionId:string;outcome:Outcome;token:Token},now=Date.now()){
  const job:RetryJob={_id:this.id(input.accountId,input.emailId),accountId:input.accountId,emailId:input.emailId,sourceDraftId:input.sourceDraftId,identityId:input.identityId,sender:input.sender,submissionId:input.submissionId,recipients:input.outcome.retry,failed:input.outcome.failed,accepted:input.outcome.accepted,credential:this.seal(input.token),state:'waiting',attempts:0,nextAt:now+this.delay(0),deadline:now+(this.config.SEND_RETRY_MAX_AGE_HOURS??24)*3600_000};
  try{await this.jobs.insertOne(job);}catch(error){if(!(error instanceof MongoServerError&&error.code===11000))throw error;}
 }
 async get(accountId:string,emailId:string){return this.jobs.findOne({accountId,$or:[{emailId},{sourceDraftId:emailId}]});}
 summary(job:RetryJob):RetrySummary{return {state:job.state,attempts:job.attempts,...(job.state==='waiting'?{nextAttemptAt:new Date(job.nextAt).toISOString()}:{}),pending:['waiting','working','dispatching'].includes(job.state)?job.recipients.length:0,failed:job.failed,accepted:job.accepted};}
 async summaries(accountId:string,emailIds:string[]){const rows=await this.jobs.find({accountId,emailId:{$in:emailIds}},{projection:{credential:0}}).toArray();return new Map(rows.map(row=>[row.emailId,this.summary(row)]));}
 async claim(now=Date.now()){
  // Never reclaim a send that might have reached the provider. A crashed worker
  // is fenced out, and ambiguous work becomes visible for manual investigation.
  await this.jobs.updateMany({state:{$in:['working','dispatching']},leaseUntil:{$lte:now}},{$set:{state:'attention',reason:'interrupted',expireAt:new Date(now+7*86400_000)},$unset:{credential:'',lease:''}});
  await this.jobs.updateMany({state:'waiting',deadline:{$lte:now}},[{$set:{state:'failed',reason:'deadline',failed:{$add:['$failed',{$size:'$recipients'}]},expireAt:new Date(now+7*86400_000)}},{$unset:'credential'}]);
  return this.jobs.findOneAndUpdate({state:'waiting',nextAt:{$lte:now},deadline:{$gt:now}},{$set:{state:'working',lease:randomUUID(),leaseUntil:now+120_000}},{sort:{nextAt:1},returnDocument:'after'});
 }
 async saveToken(job:RetryJob,token:Token){const r=await this.jobs.updateOne({_id:job._id,state:'working',lease:job.lease},{$set:{credential:this.seal(token)}});return r.modifiedCount===1;}
 async dispatch(job:RetryJob,now=Date.now()){const r=await this.jobs.updateOne({_id:job._id,state:'working',lease:job.lease,leaseUntil:{$gt:now},deadline:{$gt:now}},{$set:{state:'dispatching'},$inc:{attempts:1}});return r.modifiedCount===1;}
 async recordSubmission(job:RetryJob,submissionId:string){const r=await this.jobs.updateOne({_id:job._id,state:'dispatching',lease:job.lease},{$set:{submissionId}});return r.matchedCount===1;}
 async attention(job:RetryJob,reason:string,now=Date.now()){await this.jobs.updateOne({_id:job._id,lease:job.lease,state:{$in:['working','dispatching']}},{$set:{state:'attention',reason,expireAt:new Date(now+7*86400_000)},$unset:{credential:'',lease:''}});}
 async finish(job:RetryJob,submissionId:string,outcome:Outcome,now=Date.now()){
  const attempts=job.attempts+1,failed=job.failed+outcome.failed,accepted=job.accepted+outcome.accepted;
  const again=outcome.retry.length>0&&attempts<(this.config.SEND_RETRY_MAX_ATTEMPTS??6)&&now+this.delay(attempts)<job.deadline;
  const state:RetryState=again?'waiting':(failed||outcome.retry.length?'failed':'completed');
  await this.jobs.updateOne({_id:job._id,state:'dispatching',lease:job.lease},{$set:{state,submissionId,recipients:outcome.retry,failed:failed+(again?0:outcome.retry.length),accepted,nextAt:now+this.delay(attempts),...(!again?{expireAt:new Date(now+7*86400_000)}:{})},$unset:{lease:'',...(!again?{credential:''}:{})}});
 }
}
