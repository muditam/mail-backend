import {AppError} from './errors.js';
function policy(message:string,reason:string){return Object.assign(new AppError('PASSWORD_POLICY',400,message),{authReason:reason});}
export function validateNewPassword(current:string,next:string){
 if(next.length<8)throw policy('Password is too short. Use at least 8 characters.','password_too_short');
 if(next.length>128)throw policy('Password is too long. Use at most 128 characters.','password_too_long');
 if(!next.trim())throw policy('Password cannot consist only of spaces.','password_whitespace');
 if(next===current)throw policy('Choose a password different from your current password.','password_same_as_current');
}
// Stalwart 0.16.26 provides these descriptions in notUpdated.singleton.
// Recognize policy categories but never forward arbitrary provider text or feedback.
export function providerPasswordPolicy(description:unknown){
 if(typeof description==='string'){
  const length=/^Password must be (at least|at most) ([1-9][0-9]{0,3}) characters long\.?$/.exec(description.trim());
  if(length&&Number(length[2])<=4096){const short=length[1]==='at least';return policy(`Password is too ${short?'short':'long'}. The mail server requires ${length[1]} ${Number(length[2])} characters.`,short?'password_too_short':'password_too_long');}
  if(/^Password is too weak(?:\.|$)/.test(description.trim()))return policy('Password is too weak. Choose a longer, less predictable password or passphrase.','password_too_weak');
 }
 return policy('The mail server rejected this password. Choose a different password or ask IT to check its password policy.','password_policy_unrecognized');
}
