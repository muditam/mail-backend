import { classifySafety } from './safety.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { AppError, unavailable } from './errors.js';
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
  private account(s:JSession){const id=s.primaryAccounts?.[MAIL];if(!id||!s.accounts?.[id]?.accountCapabilities?.[MAIL]||!s.capabilities?.[CORE]||!s.capabilities?.[MAIL])throw unavailable();return id;}
  async discover(accessToken:string):Promise<JSession>{const r=await this.json(this.config.STALWART_JMAP_SESSION_URL,{headers:{authorization:`Bearer ${accessToken}`}});if(r.status!==200||!r.body?.apiUrl||!r.body?.uploadUrl||!r.body?.downloadUrl)throw unavailable();this.safeUrl(r.body.apiUrl);this.safeUrl(r.body.uploadUrl);this.safeUrl(r.body.downloadUrl);return r.body;}
  private async token(s:Session):Promise<string>{if(s.token.expires_at>Date.now()+30000)return s.token.access_token;if(!s.token.refresh_token){await this.store.delete(s.id);throw new AppError('SESSION_EXPIRED',401,'Please sign in again.');}
    const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:s.token.refresh_token,client_id:this.config.OAUTH_CLIENT_ID});
    const r=await this.json(this.config.STALWART_TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
    if(r.status!==200||typeof r.body?.access_token!=='string'){await this.store.delete(s.id);throw new AppError('SESSION_EXPIRED',401,'Please sign in again.');}
    s.token={access_token:r.body.access_token,refresh_token:r.body.refresh_token||s.token.refresh_token,expires_at:Date.now()+Math.max(1,Number(r.body.expires_in)||3600)*1000};await this.store.updateToken(s.id,s.token);return s.token.access_token;
  }
  private async context(s:Session){const access=await this.token(s),session=await this.discover(access);if(this.account(session)!==s.accountId){await this.store.delete(s.id);throw new AppError('SESSION_EXPIRED',401,'Please sign in again.');}return {access,session};}
  private async call(s:Session,calls:Call[],submission=false):Promise<any[]>{const {access,session}=await this.context(s);let r:Response;
    try{r=await this.fetcher(this.safeUrl(session.apiUrl),{method:'POST',headers:{authorization:`Bearer ${access}`,'content-type':'application/json'},body:JSON.stringify({using:[CORE,MAIL,...(submission?[SUBMISSION]:[])],methodCalls:calls}),signal:timeout(submission?20000:12000)});}catch{throw submission?new AppError('SEND_STATUS_UNKNOWN',503,'Could not confirm send. Check Sent before retrying.'):unavailable();}
    if(!r.ok)throw unavailable();let result:Reply;try{result=await r.json() as Reply;}catch{throw unavailable();}
    if(!Array.isArray(result.methodResponses)||result.methodResponses.length<calls.length)throw unavailable();
    return result.methodResponses.slice(0,calls.length).map(([name,value],i)=>{if(name==='error')throw unavailable();if(name!==calls[i]?.[0])throw unavailable();return value;});
  }
  async mailboxes(s:Session){const [r]=await this.call(s,[['Mailbox/get',{accountId:s.accountId,properties:['id','name','role','unreadEmails','totalEmails']},'m']]);return (r.list||[]).map((m:any)=>({id:m.id,name:m.name,role:m.role||undefined,unreadCount:m.unreadEmails||0,totalCount:m.totalEmails||0}));}
  async messages(s:Session,mailboxId:string,cursor:number,limit:number){const [box]=await this.call(s,[['Mailbox/get',{accountId:s.accountId,ids:[mailboxId],properties:['id']},'m']]);if(!box.list?.length)throw new AppError('MAILBOX_NOT_FOUND',404,'Mailbox not found.');
    const [query]=await this.call(s,[['Email/query',{accountId:s.accountId,filter:{inMailbox:mailboxId},sort:[{property:'receivedAt',isAscending:false}],position:cursor,limit:limit+1},'q']]);const ids=(query.ids||[]).slice(0,limit);if(!ids.length)return {messages:[]};
    const [get]=await this.call(s,[['Email/get',{accountId:s.accountId,ids,properties:['id','mailboxIds','from','to','subject','preview','receivedAt','keywords','attachments']},'e']]);const byId=new Map((get.list||[]).map((m:any)=>[m.id,m]));return {messages:ids.map((id:string)=>this.summary(byId.get(id))).filter(Boolean),nextCursor:query.ids.length>limit?String(cursor+limit):undefined};
  }
  private summary(m:any){if(!m)return null;return {safety:classifySafety(m,this.config),id:m.id,mailboxIds:Object.keys(m.mailboxIds||{}),from:m.from||[],to:m.to||[],subject:m.subject||'',preview:m.preview||'',receivedAt:m.receivedAt||new Date(0).toISOString(),isRead:!!m.keywords?.['$seen'],hasAttachment:!!m.attachments?.length,keywords:m.keywords||{}};}
  async message(s:Session,id:string){const [r]=await this.call(s,[['Email/get',{accountId:s.accountId,ids:[id],properties:['id','mailboxIds','from','to','cc','bcc','subject','preview','receivedAt','keywords','attachments','textBody','bodyValues'] ,fetchTextBodyValues:true},'e']]);const m=r.list?.[0];if(!m)throw new AppError('MESSAGE_NOT_FOUND',404,'Message not found.');const body=(m.textBody||[]).map((p:any)=>m.bodyValues?.[p.partId]?.value||'').join('\n');const attachments=await Promise.all((m.attachments||[]).map(async(a:any)=>{const up=await this.store.addUpload(s.id,a.blobId,a.name||'attachment',a.type||'application/octet-stream',a.size||0);return {id:up.id,name:up.name,type:up.type,size:up.size};}));return {...this.summary(m),cc:m.cc||[],bodyText:body,attachments};}
  async report(s:Session,id:string){
    if(!this.config.IT_REPORT_EMAIL)throw new AppError('REPORT_UNAVAILABLE',503,'IT reporting is not configured.');
    const [r]=await this.call(s,[['Email/get',{accountId:s.accountId,ids:[id],properties:['id','from','subject','receivedAt']},'e']]);
    const m=r.list?.find((item:any)=>item.id===id);if(!m)throw new AppError('MESSAGE_NOT_FOUND',404,'Message not found.');
    // Explicit allow-list: never forward body, preview, attachments or arbitrary headers.
    const metadata={messageId:id,reporter:s.email,from:Array.isArray(m.from)?m.from.map((a:any)=>({email:String(a.email||'').slice(0,254)})):[],subject:String(m.subject||'').slice(0,998),receivedAt:String(m.receivedAt||'').slice(0,64),safety:classifySafety(m,this.config)};
    return this.send(s,{to:[this.config.IT_REPORT_EMAIL],cc:[],bcc:[],subject:'Reported suspicious email',bodyText:JSON.stringify(metadata,null,2),attachmentIds:[]});
  }
  async read(s:Session,id:string,isRead:boolean){const [r]=await this.call(s,[['Email/get',{accountId:s.accountId,ids:[id],properties:['id','keywords']},'e']]);const m=r.list?.[0];if(!m)throw new AppError('MESSAGE_NOT_FOUND',404,'Message not found.');const keywords={...m.keywords};if(isRead)keywords['$seen']=true;else delete keywords['$seen'];const [updated]=await this.call(s,[['Email/set',{accountId:s.accountId,update:{[id]:{keywords}}},'u']]);if(updated.notUpdated?.[id])throw unavailable();return {id,isRead};}
  async upload(s:Session,bytes:Buffer,name:string,type:string){const {access,session}=await this.context(s);const url=this.safeUrl(session.uploadUrl.replace('{accountId}',encodeURIComponent(s.accountId)));let r:Response;try{r=await this.fetcher(url,{method:'POST',headers:{authorization:`Bearer ${access}`,'content-type':type},body:bytes as unknown as BodyInit,signal:timeout(30000)});}catch{throw unavailable();}if(!r.ok)throw unavailable();let body:any;try{body=await r.json();}catch{throw unavailable();}if(typeof body.blobId!=='string'||body.accountId!==s.accountId)throw unavailable();const up=await this.store.addUpload(s.id,body.blobId,name,type,bytes.length);return {id:up.id,name,type,size:bytes.length};}
  async download(s:Session,id:string){const up=await this.store.getUpload(s.id,id);if(!up)throw new AppError('ATTACHMENT_NOT_FOUND',404,'Attachment not found.');const {access,session}=await this.context(s);const url=this.safeUrl(session.downloadUrl.replace('{accountId}',encodeURIComponent(s.accountId)).replace('{blobId}',encodeURIComponent(up.blobId)).replace('{name}',encodeURIComponent(up.name)).replace('{type}',encodeURIComponent(up.type)));let r:Response;try{r=await this.fetcher(url,{headers:{authorization:`Bearer ${access}`},signal:timeout(30000)});}catch{throw unavailable();}if(!r.ok||!r.body)throw unavailable();return {body:r.body,name:up.name,type:up.type};}
  private async draftMailbox(s:Session){const boxes=await this.mailboxes(s);const box=boxes.find((x:any)=>x.role==='drafts');if(!box)throw unavailable();return box.id as string;}
  private async draftObject(s:Session,p:any){const box=await this.draftMailbox(s);const attachments=await Promise.all(p.attachmentIds.map(async(id:string)=>{const up=await this.store.getUpload(s.id,id);if(!up)throw new AppError('ATTACHMENT_NOT_FOUND',404,'Attachment not found.');return {blobId:up.blobId,type:up.type,name:up.name,size:up.size};}));return {mailboxIds:{[box]:true},keywords:{'$draft':true,'$seen':true},from:[{email:s.email}],to:p.to.map((email:string)=>({email})),cc:p.cc.map((email:string)=>({email})),bcc:p.bcc.map((email:string)=>({email})),subject:p.subject,textBody:[{partId:'body',type:'text/plain'}],bodyValues:{body:{value:p.bodyText}},attachments};}
  async draft(s:Session,p:any){const value=await this.draftObject(s,p);
    if(p.draftId){const [existing]=await this.call(s,[["Email/get",{accountId:s.accountId,ids:[p.draftId],properties:['id','keywords']},'e']]);if(!existing.list?.[0]?.keywords?.['$draft'])throw new AppError('DRAFT_NOT_FOUND',404,'Draft not found.');}
    const [r]=await this.call(s,[["Email/set",{accountId:s.accountId,create:{draft:value}},'s']]);const newId=r.created?.draft?.id;if(!newId)throw unavailable();
    if(p.draftId){const [removed]=await this.call(s,[["Email/set",{accountId:s.accountId,destroy:[p.draftId]},'d']]);if(removed.notDestroyed?.[p.draftId])throw unavailable();}
    return newId as string;}
  async deleteDraft(s:Session,id:string){const [existing]=await this.call(s,[['Email/get',{accountId:s.accountId,ids:[id],properties:['id','keywords']},'e']]);if(!existing.list?.[0]?.keywords?.['$draft'])throw new AppError('DRAFT_NOT_FOUND',404,'Draft not found.');const [r]=await this.call(s,[['Email/set',{accountId:s.accountId,destroy:[id]},'d']]);if(r.notDestroyed?.[id])throw unavailable();}
  async send(s:Session,p:any){const id=await this.draft(s,p);const boxes=await this.mailboxes(s);const draftBox=boxes.find((x:any)=>x.role==='drafts')?.id;const sentBox=boxes.find((x:any)=>x.role==='sent')?.id;if(!draftBox||!sentBox)throw new AppError('SEND_REJECTED',422,'Required mailboxes are unavailable.');
    const [identity]=await this.call(s,[["Identity/get",{accountId:s.accountId},'i']],true);const sender=(identity.list||[]).find((x:any)=>String(x.email).toLowerCase()===s.email.toLowerCase());if(!sender)throw new AppError('SEND_REJECTED',422,'No sending identity is available for this account.');
    const digest=createHash('sha256').update(JSON.stringify(p)).digest('hex');if(!await this.store.reserveSend(s.id,digest))throw new AppError('SEND_STATUS_UNKNOWN',409,'This message was already submitted or its status is unknown. Check Sent before retrying.');
    const [r]=await this.call(s,[["EmailSubmission/set",{accountId:s.accountId,create:{send:{emailId:id,identityId:sender.id}},onSuccessUpdateEmail:{'#send':{[`mailboxIds/${draftBox}`]:null,[`mailboxIds/${sentBox}`]:true,'keywords/$draft':null}}},'s']],true);const submissionId=r.created?.send?.id;if(!submissionId){await this.store.releaseSend(s.id,digest);throw new AppError('SEND_REJECTED',422,'Mail server rejected the message.');}await this.store.acceptSend(s.id,digest,submissionId);return submissionId as string;}
}
