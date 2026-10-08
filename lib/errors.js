/** @fileoverview Stable conversion failures shared by validation and projection modules. */
export class SpatialError extends Error {
  constructor(code, message, path = '$', options) {
    super(`${path}: ${message}`, options);
    this.name = 'SpatialError';
    this.code = code;
    this.path = path;
    this.detail = message;
  }
}
export function fail(code, message, path, options) {
  throw new SpatialError(code, message, path, options);
}
