import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { MongoClient, MongoServerError, type Collection, type Db } from 'mongodb';
import type { Config } from './config.js';

export type Token = { access_token: string; refresh_token?: string; expires_at: number };
export type Session = { id: string; email: string; accountId: string; csrf: string; token: Token; createdAt: number; touchedAt: number; absoluteExpiresAt: number };
export type Upload = { id: string; sessionHash: string; blobId: string; name: string; type: string; size: number; expiresAt: number };
type SessionRow = { _id: string; email: string; accountId: string; csrfHash: string; tokenCipher: string; createdAt: number; touchedAt: number; absoluteExpiresAt: number; expireAt: Date };
type UploadRow = { _id: string; sessionHash: string; blobId: string; name: string; type: string; size: number; expiresAt: number; expireAt: Date };
type SendRow = { _id: string; sessionHash: string; payloadHash: string; createdAt: number; submissionId?: string; expireAt: Date };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export class Store {
  private key: Buffer;
  private sessions: Collection<SessionRow>;
  private uploads: Collection<UploadRow>;
  private sends: Collection<SendRow>;

  private constructor(private config: Config, private client: MongoClient, db: Db) {
    this.key = Buffer.from(config.SESSION_ENCRYPTION_KEY, 'base64');
    this.sessions = db.collection<SessionRow>('sessions');
    this.uploads = db.collection<UploadRow>('uploads');
    this.sends = db.collection<SendRow>('send_attempts');
  }

  static async connect(config: Config): Promise<Store> {
    const client = new MongoClient(config.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    try {
      await client.connect();
      const store = new Store(config, client, client.db(config.MONGODB_DB_NAME));
      await Promise.all([
        store.sessions.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
        store.uploads.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
        store.uploads.createIndex({ sessionHash: 1 }),
        store.sends.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
        store.sends.createIndex({ sessionHash: 1 }),
      ]);
      return store;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async close() { await this.client.close(); }
  async ready() { await this.client.db(this.config.MONGODB_DB_NAME).command({ ping: 1 }); }

  private seal(value: Token) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  private open(value: string): Token {
    const b = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    decipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString());
  }

  async create(email: string, accountId: string, token: Token): Promise<Session> {
    const now = Date.now(), id = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
    const end = now + this.config.SESSION_ABSOLUTE_HOURS * 3600000;
    await this.sessions.insertOne({ _id: hash(id), email, accountId, csrfHash: hash(csrf), tokenCipher: this.seal(token), createdAt: now, touchedAt: now, absoluteExpiresAt: end, expireAt: new Date(end) });
    return { id, email, accountId, csrf, token, createdAt: now, touchedAt: now, absoluteExpiresAt: end };
  }
  async get(id: string): Promise<Session | undefined> {
    const now = Date.now();
    const row = await this.sessions.findOneAndUpdate(
      { _id: hash(id), absoluteExpiresAt: { $gt: now }, touchedAt: { $gt: now - this.config.SESSION_IDLE_MINUTES * 60000 } },
      { $set: { touchedAt: now } }, { returnDocument: 'after' },
    );
    if (!row) return undefined;
    return { id, email: row.email, accountId: row.accountId, csrf: '', token: this.open(row.tokenCipher), createdAt: row.createdAt, touchedAt: row.touchedAt, absoluteExpiresAt: row.absoluteExpiresAt };
  }
  async rotateCsrf(id: string): Promise<string> {
    const csrf = randomBytes(32).toString('base64url');
    await this.sessions.updateOne({ _id: hash(id) }, { $set: { csrfHash: hash(csrf) } });
    return csrf;
  }
  async checkCsrf(id: string, csrf: string): Promise<boolean> {
    return !!(await this.sessions.findOne({ _id: hash(id), csrfHash: hash(csrf) }, { projection: { _id: 1 } }));
  }
  async updateToken(id: string, token: Token) {
    await this.sessions.updateOne({ _id: hash(id) }, { $set: { tokenCipher: this.seal(token) } });
  }
  async delete(id: string) {
    const sessionHash = hash(id);
    await this.sessions.deleteOne({ _id: sessionHash });
    await Promise.all([this.uploads.deleteMany({ sessionHash }), this.sends.deleteMany({ sessionHash })]);
  }
  async addUpload(sessionId: string, blobId: string, name: string, type: string, size: number): Promise<Upload> {
    const upload = { id: randomBytes(24).toString('base64url'), sessionHash: hash(sessionId), blobId, name, type, size, expiresAt: Date.now() + 3600000 };
    await this.uploads.insertOne({ _id: upload.id, sessionHash: upload.sessionHash, blobId, name, type, size, expiresAt: upload.expiresAt, expireAt: new Date(upload.expiresAt) });
    return upload;
  }
  async getUpload(sessionId: string, id: string): Promise<Upload | undefined> {
    const row = await this.uploads.findOne({ _id: id, sessionHash: hash(sessionId), expiresAt: { $gt: Date.now() } });
    return row ? { id: row._id, sessionHash: row.sessionHash, blobId: row.blobId, name: row.name, type: row.type, size: row.size, expiresAt: row.expiresAt } : undefined;
  }
  async reserveSend(sessionId: string, payloadHash: string): Promise<boolean> {
    const sessionHash = hash(sessionId), _id = `${sessionHash}:${payloadHash}`, now = Date.now();
    await this.sends.deleteOne({ _id, expireAt: { $lte: new Date(now) } });
    try {
      await this.sends.insertOne({ _id, sessionHash, payloadHash, createdAt: now, expireAt: new Date(now + 24 * 3600000) });
      return true;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) return false;
      throw error;
    }
  }
  async acceptSend(sessionId: string, payloadHash: string, submissionId: string) {
    await this.sends.updateOne({ _id: `${hash(sessionId)}:${payloadHash}` }, { $set: { submissionId } });
  }
  async releaseSend(sessionId: string, payloadHash: string) {
    await this.sends.deleteOne({ _id: `${hash(sessionId)}:${payloadHash}` });
  }
  async prune() {
    const now = Date.now();
    await Promise.all([
      this.sends.deleteMany({ expireAt: { $lte: new Date(now) } }),
      this.uploads.deleteMany({ expiresAt: { $lte: now } }),
      this.sessions.deleteMany({ $or: [{ absoluteExpiresAt: { $lte: now } }, { touchedAt: { $lte: now - this.config.SESSION_IDLE_MINUTES * 60000 } }] }),
    ]);
  }
}
