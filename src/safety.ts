import type {Config} from './config.js';

export type Safety={classification:'internal'|'external'|'suspicious';fromDomain:string|null};
const domainPattern=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
export function classifySafety(m:any,config:Pick<Config,'INTERNAL_EMAIL_DOMAINS'>):Safety{
 const from=m?.from;
 const email=Array.isArray(from)&&from.length===1&&typeof from[0]?.email==='string'?from[0].email:'';
 // Accept a complete dot-atom mailbox; unsupported quoted/localized forms fail closed.
 const match=/^[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@([^\s@]+)$/i.exec(email);
 const domain=match&&email.length<=254&&email.lastIndexOf('@')<=64&&match[1]!.length<=253&&match[1]!.split('.').every(label=>label.length<=63)&&domainPattern.test(match[1]!)?match[1]!.toLowerCase():null;
 const internal=domain!==null&&(config.INTERNAL_EMAIL_DOMAINS??'muditam.com').split(',').some(d=>d.trim().toLowerCase()===domain);
 // This is an exact visible From-domain check, not sender authentication.
 return {classification:!domain?'suspicious':internal?'internal':'external',fromDomain:domain};
}
