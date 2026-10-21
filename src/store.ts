import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.js';

export type Token = { access_token: string; refresh_token?: string; expires_at: number };
export type Session = { id: string; email: string; accountId: string; csrf: string; token: Token; createdAt: number; touchedAt: number; absoluteExpiresAt: number };
export type Upload = { id: string; sessionHash: string; blobId: string; name: string; type: string; size: number; expiresAt: number };
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
export class Store {
  private db: DatabaseSync;
  private key: Buffer;
  constructor(private config: Config) {
    mkdirSync(dirname(config.SESSION_DB_PATH), {recursive:true});
    this.db = new DatabaseSync(config.SESSION_DB_PATH);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, email TEXT NOT NULL, account_id TEXT NOT NULL, csrf_hash TEXT NOT NULL, token_cipher TEXT NOT NULL, created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, session_hash TEXT NOT NULL, blob_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS uploads_session ON uploads(session_hash); CREATE TABLE IF NOT EXISTS send_attempts (session_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL, submission_id TEXT, PRIMARY KEY(session_hash,payload_hash));');
    this.key = Buffer.from(config.SESSION_ENCRYPTION_KEY,'base64');
  }
  close(){ this.db.close(); }
  ready(){ this.db.prepare('SELECT 1').get(); }
  private seal(value: Token){ const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',this.key,iv); const body=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]); return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64'); }
  private open(value:string): Token { const b=Buffer.from(value,'base64'); const decipher=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12)); decipher.setAuthTag(b.subarray(12,28)); return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString()); }
  create(email:string, accountId:string, token:Token): Session { const now=Date.now(), id=randomBytes(32).toString('base64url'), csrf=randomBytes(32).toString('base64url'), end=now+this.config.SESSION_ABSOLUTE_HOURS*3600000; this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)').run(hash(id),email,accountId,hash(csrf),this.seal(token),now,now,end); return {id,email,accountId,csrf,token,createdAt:now,touchedAt:now,absoluteExpiresAt:end}; }
  get(id:string): Session|undefined { const row=this.db.prepare('SELECT * FROM sessions WHERE id_hash=?').get(hash(id)) as Record<string,unknown>|undefined; if(!row)return; const now=Date.now(); if(now>Number(row.absolute_expires_at)||now-Number(row.touched_at)>this.config.SESSION_IDLE_MINUTES*60000){this.delete(id);return;} this.db.prepare('UPDATE sessions SET touched_at=? WHERE id_hash=?').run(now,hash(id)); return {id,email:String(row.email),accountId:String(row.account_id),csrf:'',token:this.open(String(row.token_cipher)),createdAt:Number(row.created_at),touchedAt:now,absoluteExpiresAt:Number(row.absolute_expires_at)}; }
  rotateCsrf(id:string){ const csrf=randomBytes(32).toString('base64url'); this.db.prepare('UPDATE sessions SET csrf_hash=? WHERE id_hash=?').run(hash(csrf),hash(id)); return csrf; }
  checkCsrf(id:string,csrf:string){const row=this.db.prepare('SELECT csrf_hash FROM sessions WHERE id_hash=?').get(hash(id)) as {csrf_hash:string}|undefined; return !!row && hash(csrf)===row.csrf_hash;}
  updateToken(id:string,token:Token){this.db.prepare('UPDATE sessions SET token_cipher=? WHERE id_hash=?').run(this.seal(token),hash(id));}
  delete(id:string){this.db.prepare('DELETE FROM uploads WHERE session_hash=?').run(hash(id));this.db.prepare('DELETE FROM sessions WHERE id_hash=?').run(hash(id));}
  addUpload(sessionId:string, blobId:string, name:string, type:string, size:number):Upload {const upload={id:randomBytes(24).toString('base64url'),sessionHash:hash(sessionId),blobId,name,type,size,expiresAt:Date.now()+3600000};this.db.prepare('INSERT INTO uploads VALUES (?,?,?,?,?,?,?)').run(upload.id,upload.sessionHash,blobId,name,type,size,upload.expiresAt);return upload;}
  getUpload(sessionId:string,id:string):Upload|undefined {const row=this.db.prepare('SELECT * FROM uploads WHERE id=? AND session_hash=? AND expires_at>?').get(id,hash(sessionId),Date.now()) as Record<string,unknown>|undefined; return row?{id:String(row.id),sessionHash:String(row.session_hash),blobId:String(row.blob_id),name:String(row.name),type:String(row.type),size:Number(row.size),expiresAt:Number(row.expires_at)}:undefined;}
  reserveSend(sessionId:string,payloadHash:string){const r=this.db.prepare('INSERT OR IGNORE INTO send_attempts VALUES (?,?,?,NULL)').run(hash(sessionId),payloadHash,Date.now());return r.changes===1;}
  acceptSend(sessionId:string,payloadHash:string,submissionId:string){this.db.prepare('UPDATE send_attempts SET submission_id=? WHERE session_hash=? AND payload_hash=?').run(submissionId,hash(sessionId),payloadHash);}
  releaseSend(sessionId:string,payloadHash:string){this.db.prepare('DELETE FROM send_attempts WHERE session_hash=? AND payload_hash=?').run(hash(sessionId),payloadHash);}
  prune(){this.db.prepare('DELETE FROM send_attempts WHERE created_at<?').run(Date.now()-24*3600000);this.db.prepare('DELETE FROM uploads WHERE expires_at<?').run(Date.now());this.db.prepare('DELETE FROM sessions WHERE absolute_expires_at<? OR touched_at<?').run(Date.now(),Date.now()-this.config.SESSION_IDLE_MINUTES*60000);}
}
