import type {Config} from './config.js';

export const safetyProperties=['header:Authentication-Results:asText:all','header:X-Spam-Result:asText:all'] as const;
export type Safety={classification:'internal'|'external'|'suspicious';fromDomain:string|null;authentication:'aligned'|'unverified';spam:boolean};
const domainPattern=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
function headers(m:any,key:string):string[]{const v=m?.[key];return Array.isArray(v)&&v.every(x=>typeof x==='string')?v:[];}
export function classifySafety(m:any,config:Pick<Config,'INTERNAL_EMAIL_DOMAINS'|'STALWART_AUTHSERV_ID'>):Safety{
 const from=m?.from;
 const email=Array.isArray(from)&&from.length===1&&typeof from[0]?.email==='string'?from[0].email:'';
 const match=/^[^\s@<>(),;:"\\]+@([^\s@]+)$/.exec(email);
 const domain=match&&domainPattern.test(match[1]!)?match[1]!.toLowerCase():null;
 const internal=domain!==null&&(config.INTERNAL_EMAIL_DOMAINS??'muditam.com').split(',').some(d=>d.trim().toLowerCase()===domain);
 const auth=headers(m,safetyProperties[0]);
 // Duplicate results (even with the same authserv-id) are ambiguous and fail closed.
 const trusted=auth.filter(h=>(h.split(';')[0]??'').trim().toLowerCase()===config.STALWART_AUTHSERV_ID?.toLowerCase());
 const raw=trusted.length===1?trusted[0]!:'';
 // Comments cannot supply authentication properties. Ambiguous/nested syntax fails closed.
 const result=raw.replace(/\([^()]*\)/g,'');
 const dmarc=result.split(';').slice(1).filter(p=>/^\s*dmarc\s*=/i.test(p));
 const aligned=!/[()"\\]/.test(result)&&domain!==null&&dmarc.length===1&&/^\s*dmarc=pass\s/i.test(dmarc[0]!)&&new RegExp(`(?:^|\\s)header\\.from=${domain.replaceAll('.','\\.')}(?:\\s|$)`,'i').test(dmarc[0]!);
 const spam=headers(m,safetyProperties[1]).some(h=>/\b(?:yes|true|spam|reject|quarantine|discard)\b/i.test(h)&&!/^\s*(?:ham|no|false)\b/i.test(h));
 return {classification:!domain||spam||(internal&&!aligned)?'suspicious':internal?'internal':'external',fromDomain:domain,authentication:aligned?'aligned':'unverified',spam};
}
