export class AppError extends Error {
  authReason?:string;
  constructor(public code: string, public status: number, message: string, public details?: {draftId:string}) { super(message); }
}
export const invalid = () => new AppError('INVALID_REQUEST',400,'Invalid request.');
export const unavailable = () => new AppError('UPSTREAM_UNAVAILABLE',503,'Mail service is temporarily unavailable.');

export const sessionExpired=(reason:string)=>Object.assign(new AppError('SESSION_EXPIRED',401,'Please sign in again.'),{authReason:reason});
