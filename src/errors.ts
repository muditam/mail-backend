export class AppError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}
export const invalid = () => new AppError('INVALID_REQUEST',400,'Invalid request.');
export const unavailable = () => new AppError('UPSTREAM_UNAVAILABLE',503,'Mail service is temporarily unavailable.');
