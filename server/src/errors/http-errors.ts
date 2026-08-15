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

/**
 * 410 Gone — the resource once existed but is no longer usable (expired or
 * already-consumed single-use invitation, dead unit chain). Mapped by the
 * existing `errorHandler` via `err.statusCode` (design D6).
 */
export class GoneError extends Error {
  readonly statusCode = 410;

  constructor(message = 'Recurso ya no disponible') {
    super(message);
    this.name = 'GoneError';
  }
}