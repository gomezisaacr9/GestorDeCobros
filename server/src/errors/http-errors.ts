/**
 * Domain errors thrown by services and translated to HTTP status codes by
 * controllers. Messages in Spanish (codebase convention).
 */
export class NotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message = 'Recurso no encontrado') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  readonly statusCode = 409;

  constructor(message = 'Conflicto con un recurso existente') {
    super(message);
    this.name = 'ConflictError';
  }
}