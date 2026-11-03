import {randomUUID} from 'node:crypto';
import {MongoServerError,type Collection,type Db} from 'mongodb';
import {AppError} from './errors.js';
export type PasswordPolicy={_id:string;email:string;version:string;state:'required'|'changing'|'complete';markedAt:number;completedAt?:number;operation?:string;leaseUntil?:number};
export class Onboarding {
 private rows:Collection<PasswordPolicy>;
 constructor(db:Db){this.rows=db.collection<PasswordPolicy>('password_onboarding');}
 async get(accountId:string){return this.rows.findOne({_id:accountId});}
 // Called only after Stalwart has authenticated the employee. Canonical account
 // IDs make aliases and simultaneous logins share one requirement. Set-on-insert
 // preserves completion forever unless IT explicitly marks the account again.
 async enrollIfNew(accountId:string,email:string){
  try{await this.rows.updateOne({_id:accountId},{$setOnInsert:{email:email.toLowerCase(),version:randomUUID(),state:'required',markedAt:Date.now()}},{upsert:true});}
  catch(error){if(!(error instanceof MongoServerError&&error.code===11000))throw error;}
 }
 async mark(accountId:string,email:string){const row:PasswordPolicy={_id:accountId,email:email.toLowerCase(),version:randomUUID(),state:'required',markedAt:Date.now()};await this.rows.replaceOne({_id:accountId},row,{upsert:true});return row;}
 async begin(accountId:string,version:string){const now=Date.now(),operation=randomUUID();const row=await this.rows.findOneAndUpdate({_id:accountId,version,state:{$in:['required','changing']},$or:[{leaseUntil:{$exists:false}},{leaseUntil:{$lte:now}}]},{$set:{state:'changing',operation,leaseUntil:now+120000}},{returnDocument:'after'});if(!row)throw new AppError('PASSWORD_SETUP_BUSY',409,'Password setup is already in progress. Wait two minutes before trying again.');return operation;}
 async rejected(accountId:string,operation:string){await this.rows.updateOne({_id:accountId,operation,state:'changing'},{$set:{state:'required'},$unset:{operation:'',leaseUntil:''}});}
 async complete(accountId:string,operation:string){const result=await this.rows.updateOne({_id:accountId,operation,state:'changing'},{$set:{state:'complete',version:randomUUID(),completedAt:Date.now()},$unset:{operation:'',leaseUntil:''}});if(result.modifiedCount!==1)throw new AppError('PASSWORD_SETUP_UNCONFIRMED',503,'Password setup could not be finalized. Sign in with your current password and contact IT if setup is still required.');}
}
