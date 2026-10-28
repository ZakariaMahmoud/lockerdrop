export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

export const notFound = (what) => new AppError(404, `${what} not found`);
export const badRequest = (message) => new AppError(400, message);
export const conflict = (message) => new AppError(409, message);
export const tooLarge = (message) => new AppError(413, message);
export const workspaceFull = () => new AppError(413, 'This workspace is full: its storage limit is reached');
