import {timed} from './timings.js';
import {createCipheriv,createDecipheriv,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {type Collection,type Db,MongoServerError} from 'mongodb';
import type {Token} from './store.js';
import type {Config} from './config.js';
import {AppError,sessionExpired} from './errors.js';
type Grant={_id:string;accountId:string;tokenCipher:string;state:'ready'|'refreshing'|'uncertain'|'revoked';owner?:string;leaseUntil?:number;retryAt?:number;expireAt:Date};
const temporary=(reason:string)=>Object.assign(new AppError('UPSTREAM_UNAVAILABLE',503,'Could not renew the mail connection right now. Please try again shortly.'),{authReason:reason});
export class OAuthTokens{
 private rows:Collection<Grant>;private key:Buffer;
 constructor(db:Db,private config:Config){this.rows=db.collection('oauth_credentials');this.key=Buffer.from(config.SESSION_ENCRYPTION_KEY,'base64')}
 async init(){await this.rows.createIndex({expireAt:1},{expireAfterSeconds:0})}
 private seal(token:Token){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);const data=Buffer.concat([c.update(JSON.stringify(token)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64')}
 private open(value:string):Token{const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString())}
 async register(accountId:string,token:Token,deadline:number):Promise<Token>{
  const credentialId=token.credentialId||createHmac('sha256',this.key).update(JSON.stringify(['webmail:oauth:v1',this.config.OAUTH_CLIENT_ID,accountId,token.refresh_token||token.access_token])).digest('hex');
  const managed={...token,credentialId};const expireAt=new Date(Math.max(deadline,Date.now()+(this.config.SEND_RETRY_MAX_AGE_HOURS??24)*3600000));
  try{await this.rows.updateOne({_id:credentialId},{$setOnInsert:{accountId,tokenCipher:this.seal(managed),state:'ready'},$max:{expireAt}},{upsert:true})}catch(error){if(!(error instanceof MongoServerError&&error.code===11000))throw error}
  return managed;
 }
 async access(accountId:string,input:Token,deadline:number,refresh:(token:Token)=>Promise<Token>,minimumValidity=30000):Promise<Token>{
  // Registered grants must never be recreated from stale session snapshots.
  const managed=input.credentialId?input:await this.register(accountId,input,deadline);const id=managed.credentialId!;
  for(let attempt=0;attempt<120;attempt++){
   const now=Date.now(),row=await timed('credential_db',()=>this.rows.findOne({_id:id,accountId}));if(!row)throw temporary('upstream_credential_missing');
   if(row.expireAt.getTime()<deadline)await this.rows.updateOne({_id:id,accountId},{$max:{expireAt:new Date(deadline)}});
   if(row.state==='revoked')throw sessionExpired('upstream_refresh_rejected');
   if(row.state==='uncertain')throw temporary('upstream_refresh_uncertain');
   if(row.state==='refreshing'){
    // An interrupted owner may have renewed at Stalwart without saving the reply.
    // Do not reclaim/replay that work; keep the session and surface uncertainty.
    if((row.leaseUntil??0)<=now){await this.rows.updateOne({_id:id,state:'refreshing',owner:row.owner,leaseUntil:{$lte:now}},{$set:{state:'uncertain'},$unset:{owner:'',leaseUntil:''}});throw temporary('upstream_refresh_uncertain');}
    await new Promise(r=>setTimeout(r,100));continue;
   }
   const token=this.open(row.tokenCipher);
   if(token.expires_at>now+minimumValidity)return token;
   if((row.retryAt??0)>now)throw temporary('upstream_refresh_backoff');
   const owner=randomUUID();const claimed=await this.rows.updateOne({_id:id,accountId,state:'ready',tokenCipher:row.tokenCipher,$or:[{retryAt:{$exists:false}},{retryAt:{$lte:now}}]},{$set:{state:'refreshing',owner,leaseUntil:now+30000}});if(!claimed.modifiedCount)continue;
   let next:Token;
   try{next={...await timed('upstream_refresh',()=>refresh(token)),credentialId:id}}
   catch(error){
    const revoked=error instanceof AppError&&error.code==='SESSION_EXPIRED';
    await this.rows.updateOne({_id:id,state:'refreshing',owner},{$set:{state:revoked?'revoked':'ready',retryAt:Date.now()+5000},$unset:{owner:'',leaseUntil:'',...(revoked?{tokenCipher:''}:{})}});
    throw error;
   }
   // Do not release a lease after a lost DB write: its result is uncertain.
   const saved=await this.rows.updateOne({_id:id,state:'refreshing',owner,leaseUntil:{$gt:Date.now()}},{$set:{state:'ready',tokenCipher:this.seal(next)},$unset:{owner:'',leaseUntil:'',retryAt:''}});
   if(!saved.modifiedCount)throw temporary('upstream_refresh_uncertain');return next;
  }
  throw temporary('upstream_refresh_busy');
 }
}
