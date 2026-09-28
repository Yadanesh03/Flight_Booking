import { Router } from 'express';
import { requireAuth } from '../../platform/middleware/requireAuth.js';
import { authController } from './auth.controller.js';

/** Route table for Section 10.2. Paths are absolute so the request log shows the full route pattern. */
export function authRouter(): Router {
  const router = Router();
  router.post('/api/auth/register', requireAuth('public'), authController.register);
  router.post('/api/auth/login', requireAuth('public'), authController.login);
  router.post('/api/auth/logout', requireAuth('session'), authController.logout);
  router.get('/api/auth/me', requireAuth('session'), authController.me);
  return router;
}
