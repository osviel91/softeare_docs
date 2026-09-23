/**
 * The resource-path boundary's error.
 *
 * `normalizeResourcePath` lives in the persistence layer because it is the
 * filesystem boundary, but the *failure* it reports is part of the contract the
 * application layer consumes: a use case catches it and reports `invalid`. Keeping
 * the class here is what stops `project-catalog` from importing a persistence
 * module just to name the type it catches.
 */
export class InvalidResourcePathError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Invalid resource path ${JSON.stringify(path)}: ${reason}`);
    this.name = "InvalidResourcePathError";
    this.path = path;
  }
}
