import {providerPasswordPolicy} from './passwordPolicy.js';
import {submissionOutcome} from './retries.js';
import {attachmentName} from './attachmentName.js';
import { classifySafety } from './safety.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { AppError, sessionExpired, unavailable } from './errors.js';
import type { Session, Store, Token } from './store.js';

const CORE='urn:ietf:params:jmap:core', MAIL='urn:ietf:params:jmap:mail', SUBMISSION='urn:ietf:params:jmap:submission';
type JSession={apiUrl:string;uploadUrl:string;downloadUrl:string;accounts:Record<string,{accountCapabilities:Record<string,unknown>;name?:string}>;primaryAccounts:Record<string,string>;capabilities:Record<string,unknown>};
type Call=[string,Record<string,unknown>,string];
type Reply={methodResponses:[string,any,string][];sessionState?:string};
const timeout=(ms:number)=>AbortSignal.timeout(ms);
export class Stalwart {
  private base:URL;
  constructor(private config:Config,private store:Store,private fetcher:typeof fetch=fetch){this.base=new URL(config.STALWART_URL);}
  private safeUrl(input:string){const url=new URL(input,this.base);if(url.protocol!=='https:'||url.origin!==this.base.origin)throw unavailable();return url.toString();}
  private async json(url:string,init:RequestInit,ms=12000):Promise<{status:number;body:any}>{
    let response:Response;
    try{response=await this.fetcher(this.safeUrl(url),{...init,signal:timeout(ms),redirect:'manual'});}catch{throw unavailable();}
    if(response.status>=300&&response.status<400){const location=response.headers.get('location');if(!location)throw unavailable();return this.json(this.safeUrl(location),init,ms);}
    let body:any;try{body=await response.json();}catch{throw unavailable();}
    return {status:response.status,body};
  }
  async login(email:string,password:string):Promise<{token:Token;accountId:string}>{
    const verifier=randomBytes(32).toString('base64url');
    const challenge=createHash('sha256').update(verifier).digest('base64url');
    const auth=await this.json(this.config.STALWART_AUTH_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'authCode',accountName:email,accountSecret:password,clientId:this.config.OAUTH_CLIENT_ID,redirectUri:this.config.OAUTH_REDIRECT_URI,codeChallenge:challenge,codeChallengeMethod:'S256'})});
    if(auth.body?.type==='mfaRequired')throw new AppError('MFA_REQUIRED',403,'Multi-factor authentication is not yet supported.');
    if(auth.body?.type==='failure'||auth.status===401)throw new AppError('INVALID_CREDENTIALS',401,'Email or password is incorrect.');
    const clientCode=auth.body?.client_code ?? auth.body?.clientCode;
    if(auth.status!==200||auth.body?.type!=='authenticated'||typeof clientCode!=='string')throw unavailable();
    const form=new URLSearchParams({grant_type:'authorization_code',code:clientCode,client_id:this.config.OAUTH_CLIENT_ID,redirect_uri:this.config.OAUTH_REDIRECT_URI,code_verifier:verifier});
    const exchange=await this.json(this.config.STALWART_TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form});
    if(exchange.status!==200||typeof exchange.body?.access_token!=='string')throw unavailable();
    const token:Token={access_token:exchange.body.access_token,refresh_token:exchange.body.refresh_token,expires_at:Date.now()+Math.max(1,Number(exchange.body.expires_in)||3600)*1000};
    const discovery=await this.discover(token.access_token);return {token,accountId:this.account(discovery)};
  }
  async setupPassword(s:Session,currentPassword:string,newPassword:string){
    const {access,session}=await this.context(s);
    if(!session.capabilities?.['urn:stalwart:jmap']&&!session.accounts?.[s.accountId]?.accountCapabilities?.['urn:stalwart:jmap'])throw new AppError('PASSWORD_SETUP_UNAVAILABLE',503,'Password setup is unavailable. Ask IT to check account permissions and server support.');
    let response:Response;
    try{response=await this.fetcher(this.safeUrl(session.apiUrl),{method:'POST',redirect:'error',signal:timeout(20000),headers:{authorization:`Bearer ${access}`,'content-type':'application/json'},body:JSON.stringify({using:[CORE,'urn:stalwart:jmap'],methodCalls:[['x:AccountPassword/set',{update:{singleton:{currentSecret:currentPassword,secret:newPassword}}},'password']]})});}
    catch{throw new AppError('PASSWORD_CHANGE_UNKNOWN',503,'Could not confirm the change. Do not keep submitting. Wait two minutes, then sign in using the password that works and complete setup.');}
    let body:any;try{body=await response.json();}catch{throw new AppError('PASSWORD_CHANGE_UNKNOWN',503,'Could not confirm the change. Sign in again with the password that works before retrying.');}
    const result=body?.methodResponses?.find((r:any)=>r?.[2]==='password');
    const error=result?.[0]==='error'?result[1]:result?.[1]?.notUpdated?.singleton;
    if(error){
      if(result?.[0]==='error'&&!['forbidden','unknownMethod','invalidArguments','accountNotFound'].includes(error.type))throw new AppError('PASSWORD_CHANGE_UNKNOWN',503,'Could not confirm the password change. Sign in with the password that works before retrying.');
      if(error.type==='invalidProperties')throw providerPasswordPolicy(error.description);
      if(error.type==='forbidden'&&/Current secret is incorrect/.test(error.description||''))throw new AppError('PASSWORD_CURRENT_INVALID',400,'Your current password is incorrect.');
      throw new AppError('PASSWORD_CHANGE_REJECTED',403,'The mail server rejected password setup. Verify your current password or contact IT to check permissions.');
    }
    if(!response.ok||result?.[0]!=='x:AccountPassword/set'||!Object.prototype.hasOwnProperty.call(result?.[1]?.updated||{},'singleton'))throw new AppError('PASSWORD_CHANGE_UNKNOWN',503,'Could not confirm the password change. Sign in with the password that works before retrying.');
  }
  private account(s:JSession){const id=s.primaryAccounts?.[MAIL];if(!id||!s.accounts?.[id]?.accountCapabilities?.[MAIL]||!s.capabilities?.[CORE]||!s.capabilities?.[MAIL])throw unavailable();return id;}
  async discover(accessToken:string):Promise<JSession>{const r=await this.json(this.config.STALWART_JMAP_SESSION_URL,{headers:{authorization:`Bearer ${accessToken}`}});if(r.status!==200||!r.body?.apiUrl||!r.body?.uploadUrl||!r.body?.downloadUrl)throw unavailable();this.safeUrl(r.body.apiUrl);this.safeUrl(r.body.uploadUrl);this.safeUrl(r.body.downloadUrl);return r.body;}
  private async token(s:Session):Promise<string>{if(s.token.expires_at>Date.now()+30000)return s.token.access_token;if(!s.token.refresh_token){await this.store.delete(s.id,'upstream_refresh_unavailable');throw sessionExpired('upstream_refresh_unavailable');}
    const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:s.token.refresh_token,client_id:this.config.OAUTH_CLIENT_ID});
    const r=await this.json(this.config.STALWART_TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
    if(r.status!==200||typeof r.body?.access_token!=='string'){await this.store.delete(s.id,'upstream_refresh_rejected');throw sessionExpired('upstream_refresh_rejected');}
    s.token={access_token:r.body.access_token,refresh_token:r.body.refresh_token||s.token.refresh_token,expires_at:Date.now()+Math.max(1,Number(r.body.expires_in)||3600)*1000};await this.store.updateToken(s.id,s.token);return s.token.access_token;
  }
  private async context(s:Session){const access=await this.token(s),session=await this.discover(access);if(this.account(session)!==s.accountId){await this.store.delete(s.id,'upstream_account_changed');throw sessionExpired('upstream_account_changed');}return {access,session};}
  private async call(s:Session,calls:Call[],submission=false):Promise<any[]>{const {access,session}=await this.context(s);let r:Response;
    try{r=await this.fetcher(this.safeUrl(session.apiUrl),{method:'POST',headers:{authorization:`Bearer ${access}`,'content-type':'application/json'},body:JSON.stringify({using:[CORE,MAIL,...(submission?[SUBMISSION]:[])],methodCalls:calls}),signal:timeout(submission?20000:12000)});}catch{throw submission?new AppError('SEND_STATUS_UNKNOWN',503,'Could not confirm send. Check Sent before retrying.'):unavailable();}
    if(!r.ok)throw unavailable();let result:Reply;try{result=await r.json() as Reply;}catch{throw unavailable();}
    if(!Array.isArray(result.methodResponses)||result.methodResponses.length<calls.length)throw unavailable();
    return result.methodResponses.slice(0,calls.length).map(([name,value],i)=>{if(name==='error')throw unavailable();if(name!==calls[i]?.[0])throw unavailable();return value;});
  }
  async mailboxes(s:Session){const [r]=await this.call(s,[['Mailbox/get',{accountId:s.accountId,properties:['id','name','role','unreadEmails','totalEmails']},'m']]);return (r.list||[]).map((m:any)=>({id:m.id,name:m.name,role:m.role||undefined,unreadCount:m.unreadEmails||0,totalCount:m.totalEmails||0}));}
  async messages(s:Session,mailboxId:string|undefined,cursor:number,limit:number,search?:string,starred?:boolean){if(mailboxId){const [box]=await this.call(s,[['Mailbox/get',{accountId:s.accountId,ids:[mailboxId],properties:['id']},'m']]);if(!box.list?.length)throw new AppError('MAILBOX_NOT_FOUND',404,'Mailbox not found.');}
    const match=search?{operator:'OR',conditions:[{from:search},{subject:search},{body:search}]}:undefined;
    const conditions=[...(mailboxId?[{inMailbox:mailboxId}]:[]),...(match?[match]:[]),...(starred?[{hasKeyword:'$flagged'}]:[])];
    const filter=conditions.length>1?{operator:'AND',conditions}:conditions[0];
    const [query]=await this.call(s,[['Email/query',{accountId:s.accountId,filter,sort:[{property:'receivedAt',isAscending:false}],position:cursor,limit:limit+1},'q']]);if(!Array.isArray(query?.ids)||query.ids.some((id:unknown)=>typeof id!=='string'||!id))throw unavailable();
    const ids=query.ids.slice(0,limit);if(!ids.length)return {messages:[]};
    const [get]=await this.call(s,[['Email/get',{accountId:s.accountId,ids,properties:['id','mailboxIds','from','to','subject','preview','receivedAt','keywords','attachments']},'e']]);if(!Array.isArray(get?.list)||get.list.some((m:any)=>!m||typeof m.id!=='string'))throw unavailable();
    const byId=new Map(get.list.map((m:any)=>[m.id,m]));
    // Only explicitly vanished messages may be absent between query and retrieval.
    if(ids.some((id:string)=>!byId.has(id)&&!get.notFound?.includes(id)))throw unavailable();
    const retries=await this.store.retries?.summaries(s.accountId,ids);
    return {messages:ids.map((id:string)=>({...this.summary(byId.get(id)),...(retries?.has(id)?{deliveryRetry:retries.get(id)}:{})})).filter((m:any)=>m.id),nextCursor:query.ids.length>limit?String(cursor+limit):undefined};
  }
  private summary(m:any){if(!m)return null;return {safety:classifySafety(m,this.config),id:m.id,mailboxIds:Object.keys(m.mailboxIds||{}),from:m.from||[],to:m.to||[],subject:m.subject||'',preview:m.preview||'',receivedAt:m.receivedAt||new Date(0).toISOString(),isRead:!!m.keywords?.['$seen'],hasAttachment:!!m.attachments?.length,keywords:m.keywords||{}};}
  async message(s:Session,id:string){const [r]=await this.call(s,[['Email/get',{accountId:s.accountId,ids:[id],properties:['id','mailboxIds','from','to','cc','bcc','subject','preview','receivedAt','keywords','attachments','textBody','bodyValues'] ,fetchTextBodyValues:true},'e']]);const m=r.list?.[0];if(!m)throw new AppError('MESSAGE_NOT_FOUND',404,'Message not found.');const body=(m.textBody||[]).map((p:any)=>m.bodyValues?.[p.partId]?.value||'').join('\n');const attachments=await Promise.all((m.attachments||[]).map(async(a:any)=>{const up=await this.store.addUpload(s.id,a.blobId,attachmentName(a.name,a.type),a.type||'application/octet-stream',a.size||0);return {id:up.id,name:up.name,type:up.type,size:up.size};}));const retry=await this.store.retries?.get(s.accountId,id);return {...this.summary(m),...(retry?{deliveryRetry:this.store.retries.summary(retry)}:{}),cc:m.cc||[],bcc:m.bcc||[],bodyText:body,attachments};}
  async report(s:Session,id:string){
    if(!this.config.IT_REPORT_EMAIL)throw new AppError('REPORT_UNAVAILABLE',503,'IT reporting is not configured.');
    const [r]=await this.call(s,[['Email/get',{accountId:s.accountId,ids:[id],properties:['id','from','subject','receivedAt']},'e']]);
    const m=r.list?.find((item:any)=>item.id===id);if(!m)throw new AppError('MESSAGE_NOT_FOUND',404,'Message not found.');
    // Explicit allow-list: never forward body, preview, attachments or arbitrary headers.
    const metadata={messageId:id,reporter:s.email,from:Array.isArray(m.from)?m.from.map((a:any)=>({email:String(a.email||'').slice(0,254)})):[],subject:String(m.subject||'').slice(0,998),receivedAt:String(m.receivedAt||'').slice(0,64),safety:classifySafety(m,this.config)};
    return this.send(s,{to:[this.config.IT_REPORT_EMAIL],cc:[],bcc:[],subject:'Reported suspicious email',bodyText:JSON.stringify(metadata,null,2),attachmentIds:[]});
  }
  async read(s:Session,id:string,isRead:boolean){const [r]=await this.call(s,[['Email/get',{accountId:s.accountId,ids:[id],properties:['id','keywords']},'e']]);const m=r.list?.[0];if(!m)throw new AppError('MESSAGE_NOT_FOUND',404,'Message not found.');const [updated]=await this.call(s,[['Email/set',{accountId:s.accountId,update:{[id]:{'keywords/$seen':isRead?true:null}}},'u']]);if(updated.notUpdated?.[id]||!Object.prototype.hasOwnProperty.call(updated.updated||{},id))throw unavailable();return {id,isRead};}
  async star(s:Session,id:string,isStarred:boolean){
    // Patch only this keyword so concurrent read/draft changes are preserved.
    const [result]=await this.call(s,[['Email/set',{accountId:s.accountId,update:{[id]:{'keywords/$flagged':isStarred?true:null}}},'u']]);
    if(result.notUpdated?.[id]?.type==='notFound')throw new AppError('MESSAGE_NOT_FOUND',404,'Message not found.');
    if(result.notUpdated?.[id]||!Object.prototype.hasOwnProperty.call(result.updated||{},id))throw unavailable();
    return {id,isStarred};
  }
  async moveMessage(s:Session,id:string,action:'trash'|'restore'){
    await this.assertNotRetrying(s,id,true);
    const boxes=await this.mailboxes(s);
    const trash=boxes.find((box:any)=>box.role==='trash');
    if(!trash)throw new AppError('MAILBOX_NOT_FOUND',404,'Trash folder is unavailable.');
    const [result]=await this.call(s,[['Email/get',{accountId:s.accountId,ids:[id],properties:['id','mailboxIds','keywords']},'e']]);
    const message=result.list?.find((m:any)=>m.id===id);
    if(!message)throw new AppError('MESSAGE_NOT_FOUND',404,'Message not found.');
    const current=Object.keys(message.mailboxIds||{});
    // Repeated requests are harmless, including a restore retried after success.
    if(action==='restore'&&!current.includes(trash.id))return {id,mailboxIds:current};
    const sentOrigin='muditam-restore-sent';
    const role=action==='trash'?'trash':message.keywords?.['$draft']?'drafts':message.keywords?.[sentOrigin]?'sent':'inbox';
    const destination=boxes.find((box:any)=>box.role===role);
    if(!destination)throw new AppError('MAILBOX_NOT_FOUND',404,`The ${role} folder is unavailable.`);
    if(current.length===1&&current[0]===destination.id)return {id,mailboxIds:current};
    // Record Sent origin atomically with the move, independent of the login session.
    // Patch only our marker, preserving read/star and other user keywords.
    const patch:Record<string,unknown>={mailboxIds:{[destination.id]:true}};
    const fromSent=boxes.some((box:any)=>box.role==='sent'&&current.includes(box.id));
    if(action==='trash'&&fromSent)patch[`keywords/${sentOrigin}`]=true;
    else if(message.keywords?.[sentOrigin])patch[`keywords/${sentOrigin}`]=null;
    const [updated]=await this.call(s,[['Email/set',{accountId:s.accountId,ifInState:result.state,update:{[id]:patch}},'u']]);
    const failure=updated.notUpdated?.[id];
    if(failure?.type==='notFound')throw new AppError('MESSAGE_NOT_FOUND',404,'Message not found.');
    if(failure||!Object.prototype.hasOwnProperty.call(updated.updated||{},id))throw unavailable();
    return {id,mailboxIds:[destination.id]};
  }
  async upload(s:Session,bytes:Buffer,name:string,type:string){const {access,session}=await this.context(s);const url=this.safeUrl(session.uploadUrl.replace('{accountId}',encodeURIComponent(s.accountId)));let r:Response;try{r=await this.fetcher(url,{method:'POST',headers:{authorization:`Bearer ${access}`,'content-type':type},body:bytes as unknown as BodyInit,signal:timeout(30000)});}catch{throw unavailable();}if(!r.ok)throw unavailable();let body:any;try{body=await r.json();}catch{throw unavailable();}if(typeof body.blobId!=='string'||body.accountId!==s.accountId)throw unavailable();const up=await this.store.addUpload(s.id,body.blobId,name,type,bytes.length);return {id:up.id,name,type,size:bytes.length};}
  async download(s:Session,id:string){const up=await this.store.getUpload(s.id,id);if(!up)throw new AppError('ATTACHMENT_NOT_FOUND',404,'Attachment not found.');const {access,session}=await this.context(s);const url=this.safeUrl(session.downloadUrl.replace('{accountId}',encodeURIComponent(s.accountId)).replace('{blobId}',encodeURIComponent(up.blobId)).replace('{name}',encodeURIComponent(up.name)).replace('{type}',encodeURIComponent(up.type)));let r:Response;try{r=await this.fetcher(url,{headers:{authorization:`Bearer ${access}`},signal:timeout(30000)});}catch{throw unavailable();}if(!r.ok||!r.body)throw unavailable();return {body:r.body,name:up.name,type:up.type};}
  private async draftMailbox(s:Session){const boxes=await this.mailboxes(s);const box=boxes.find((x:any)=>x.role==='drafts');if(!box)throw unavailable();return box.id as string;}
  private async draftObject(s:Session,p:any){const box=await this.draftMailbox(s);const attachments=await Promise.all(p.attachmentIds.map(async(id:string)=>{const up=await this.store.getUpload(s.id,id);if(!up)throw new AppError('ATTACHMENT_NOT_FOUND',404,'Attachment not found.');return {blobId:up.blobId,type:up.type,name:up.name,size:up.size};}));return {mailboxIds:{[box]:true},keywords:{'$draft':true,'$seen':true},from:[{email:s.email}],to:p.to.map((email:string)=>({email})),cc:p.cc.map((email:string)=>({email})),bcc:p.bcc.map((email:string)=>({email})),subject:p.subject,textBody:[{partId:'body',type:'text/plain'}],bodyValues:{body:{value:p.bodyText}},attachments};}
  async draft(s:Session,p:any){if(p.draftId)await this.assertNotRetrying(s,p.draftId);const value=await this.draftObject(s,p);
    if(p.draftId){const [existing]=await this.call(s,[["Email/get",{accountId:s.accountId,ids:[p.draftId],properties:['id','keywords']},'e']]);if(!existing.list?.[0]?.keywords?.['$draft'])throw new AppError('DRAFT_NOT_FOUND',404,'Draft not found.');value.keywords={...existing.list[0].keywords,...value.keywords};}
    const [r]=await this.call(s,[["Email/set",{accountId:s.accountId,create:{draft:value}},'s']]);const newId=r.created?.draft?.id;if(!newId)throw unavailable();
    if(p.draftId){const [removed]=await this.call(s,[["Email/set",{accountId:s.accountId,destroy:[p.draftId]},'d']]);if(removed.notDestroyed?.[p.draftId])throw unavailable();}
    return newId as string;}
  async deleteDraft(s:Session,id:string){await this.assertNotRetrying(s,id);const [existing]=await this.call(s,[['Email/get',{accountId:s.accountId,ids:[id],properties:['id','keywords']},'e']]);if(!existing.list?.[0]?.keywords?.['$draft'])throw new AppError('DRAFT_NOT_FOUND',404,'Draft not found.');const [r]=await this.call(s,[['Email/set',{accountId:s.accountId,destroy:[id]},'d']]);if(r.notDestroyed?.[id])throw unavailable();}
  private async assertNotRetrying(s:Session,id:string,activeOnly=false){
    const job=await this.store.retries?.get(s.accountId,id);
    if(job&&(!activeOnly||['waiting','working','dispatching'].includes(job.state)))throw new AppError('SEND_MANAGED',409,'This message has an automatic delivery record. Open its delivery status instead of editing or resending it.');
  }
  private async moveSubmittedToSent(s:Session,id:string,draftBox:string,sentBox:string){
    try{
      const [updated]=await this.call(s,[["Email/set",{accountId:s.accountId,update:{[id]:{[`mailboxIds/${draftBox}`]:null,[`mailboxIds/${sentBox}`]:true,'keywords/$draft':null}}},'sent']]);
      if(updated.notUpdated?.[id]||!Object.prototype.hasOwnProperty.call(updated.updated||{},id))throw unavailable();
    }catch{throw new AppError('SEND_STATUS_UNKNOWN',503,'Submission may have succeeded but its folder could not be updated. Do not resend.');}
  }
  async retryOne(now=Date.now()):Promise<boolean>{
    const queue=this.store.retries,job=await queue.claim(now);
    if(!job)return false;
    try{
      let token=queue.token(job);
      if(token.expires_at<Date.now()+90_000){
        if(!token.refresh_token)throw Error('Retry authorization expired');
        const r=await this.json(this.config.STALWART_TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:token.refresh_token,client_id:this.config.OAUTH_CLIENT_ID})});
        if(r.status!==200||typeof r.body?.access_token!=='string')throw Error('Retry authorization expired');
        token={access_token:r.body.access_token,refresh_token:r.body.refresh_token||token.refresh_token,expires_at:Date.now()+Math.max(1,Number(r.body.expires_in)||3600)*1000};
        if(!await queue.saveToken(job,token))return true;
      }
      if(token.expires_at<Date.now()+90_000)throw Error('Retry token lifetime too short');
      const session:Session={id:'',email:job.sender,accountId:job.accountId,csrf:'',token,createdAt:now,touchedAt:now,absoluteExpiresAt:job.deadline};
      const [email]=await this.call(session,[["Email/get",{accountId:job.accountId,ids:[job.emailId],properties:['id']},'exists']]);
      if(!email.list?.some((value:any)=>value.id===job.emailId))throw Error('Original email unavailable');
      // Persist an irreversible dispatch marker before contacting Stalwart.
      // Expired/stale claim holders cannot start another network submission.
      if(!await queue.dispatch(job))return true;
      const [created]=await this.call(session,[["EmailSubmission/set",{accountId:job.accountId,create:{retry:{emailId:job.emailId,identityId:job.identityId,envelope:{mailFrom:{email:job.sender},rcptTo:job.recipients.map(email=>({email}))}}}},'retry']],true);
      const id=created.created?.retry?.id;
      if(typeof id!=='string'){
        if(created.notCreated?.retry)await queue.finish(job,job.submissionId,{retry:[],accepted:0,failed:job.recipients.length},now);
        else await queue.attention(job,'unknown-submission',now);
        return true;
      }
      if(!await queue.recordSubmission(job,id))return true;
      const [get]=await this.call(session,[["EmailSubmission/get",{accountId:job.accountId,ids:[id]},'status']],true);
      const submission=get.list?.find((value:any)=>value.id===id&&value.emailId===job.emailId);
      const outcome=submissionOutcome(submission,job.recipients);
      if(!outcome){await queue.attention(job,'unknown-status',now);return true;}
      // Persist the recipient reduction before any cosmetic folder changes.
      await queue.finish(job,id,outcome,now);
      if(outcome.accepted){
        const boxes=await this.mailboxes(session),draft=boxes.find((b:any)=>b.role==='drafts'),sent=boxes.find((b:any)=>b.role==='sent');
        if(draft&&sent)await this.moveSubmittedToSent(session,job.emailId,draft.id,sent.id);
      }
    }catch{
      // No blind re-send after a timeout, crash, token failure or uncertain write.
      await queue.attention(job,'needs-review',now);
    }
    return true;
  }
  async send(s:Session,p:any){
    const boxes=await this.mailboxes(s);
    const draftBox=boxes.find((x:any)=>x.role==='drafts')?.id,sentBox=boxes.find((x:any)=>x.role==='sent')?.id;
    if(!draftBox||!sentBox)throw new AppError('SEND_REJECTED',422,'Required mailboxes are unavailable.');
    const [identity]=await this.call(s,[["Identity/get",{accountId:s.accountId},'i']],true);
    const sender=(identity.list||[]).find((x:any)=>String(x.email).toLowerCase()===s.email.toLowerCase());
    if(!sender)throw new AppError('SEND_REJECTED',422,'No sending identity is available for this account.');
    const uncertain=()=>new AppError('SEND_STATUS_UNKNOWN',503,'Could not confirm send. Check Sent and Drafts before retrying; the message may already have been submitted.');
    const digest=createHash('sha256').update(JSON.stringify(p)).digest('hex');
    if(!await this.store.reserveSend(s.id,digest))throw uncertain();
    let id:string;
    try{id=await this.draft(s,p);}catch(error){await this.store.releaseSend(s.id,digest);throw error;}
    // Creation of a submission does not mean its recipients were accepted.
    // Do not let onSuccessUpdateEmail move a rejected submission into Sent.
    let result:any;
    try{[result]=await this.call(s,[["EmailSubmission/set",{accountId:s.accountId,create:{send:{emailId:id,identityId:sender.id}}},'s']],true);}
    catch{throw uncertain();} // Keep the duplicate guard after ambiguous network/provider failures.
    const submissionId=result.created?.send?.id;
    if(typeof submissionId!=='string'||!submissionId){
      if(result.notCreated?.send){
        await this.store.releaseSend(s.id,digest);
        throw new AppError('SEND_REJECTED',422,'Mail server rejected the message. Your message remains in Drafts.',{draftId:id});
      }
      throw uncertain();
    }
    await this.store.acceptSend(s.id,digest,submissionId);
    let submission:any;
    try{
      const [get]=await this.call(s,[["EmailSubmission/get",{accountId:s.accountId,ids:[submissionId]},'status']],true);
      submission=get.list?.find((item:any)=>item.id===submissionId&&item.emailId===id);
    }catch{throw uncertain();}
    if(!submission)throw uncertain();
    const recipients=[...new Set<string>([...p.to,...p.cc,...p.bcc].map((email:string)=>email.toLowerCase()))];
    const outcome=submissionOutcome(submission,recipients);
    if(!outcome)throw uncertain();
    if(outcome.retry.length){
      // Persist before acknowledging a retry. A DB failure retains the original
      // duplicate guard and cannot masquerade as a safely queued operation.
      if(!this.store.retries)throw uncertain();
      try{await this.store.retries.schedule({accountId:s.accountId,emailId:id,sourceDraftId:p.draftId,identityId:sender.id,sender:s.email,submissionId,outcome,token:s.token});}
      catch{throw uncertain();}
      if(outcome.accepted)await this.moveSubmittedToSent(s,id,draftBox,sentBox);
      return {submissionId,status:'retrying' as const,messageId:id,failedRecipients:outcome.failed};
    }
    if(outcome.failed===recipients.length){
      await this.store.releaseSend(s.id,digest);
      throw new AppError('SEND_REJECTED',422,'Message not sent: the mail server rejected delivery to all recipients. Your message remains in Drafts.',{draftId:id});
    }
    await this.moveSubmittedToSent(s,id,draftBox,sentBox);
    if(outcome.failed){
      // Some recipients may already have received it. Keep the duplicate guard,
      // and do not expose BCC addresses or raw provider replies in the error.
      throw new AppError('SEND_PARTIAL_FAILURE',409,'The message was not sent to all recipients. A copy is in Sent. Do not resend to everyone; some recipients may already have received it.');
    }
    return submissionId as string;
  }
}
