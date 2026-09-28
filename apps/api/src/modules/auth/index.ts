/** Public API of the `auth` module (Section 3.3). Everything else in this folder is private. */
export { authRouter } from './auth.routes.js';
export { authService, type AuthResult, type CreateUserInput } from './auth.service.js';
/** Wired into the HTTP pipeline by app.ts as the session resolver. */
export { sessionService } from './session.service.js';
