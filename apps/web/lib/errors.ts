/** An expected failure whose message is safe to show the user. Anything else becomes a generic 500. */
export class UserFacingError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "UserFacingError";
  }
}
