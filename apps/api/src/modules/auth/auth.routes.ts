import { Router } from 'express';
import { rateLimit } from '../../platform/middleware/rateLimit.js';
import { requireAuth } from '../../platform/middleware/requireAuth.js';
import { authController } from './auth.controller.js';

/** Route table for Section 10.2. Paths are absolute so the request log shows the full route pattern. */
export function authRouter(): Router {
  const router = Router();
  router.post('/api/auth/register', requireAuth('public'), rateLimit('auth_register'), authController.register);
  router.post('/api/auth/login', requireAuth('public'), rateLimit('auth_login'), authController.login);
  router.post('/api/auth/logout', requireAuth('session'), authController.logout);
  router.get('/api/auth/me', requireAuth('session'), rateLimit('read'), authController.me);
  return router;
}
