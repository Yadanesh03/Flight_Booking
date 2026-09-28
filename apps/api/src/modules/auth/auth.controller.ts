import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { SESSION_ABSOLUTE_MAX_SECONDS, SESSION_COOKIE_NAME, loginSchema, registerSchema } from '@flight/shared';
import { config } from '../../platform/config.js';
import { readCookie } from '../../platform/middleware/session.js';
import { requireUser } from '../../platform/requestContext.js';
import { authService } from './auth.service.js';

/** `sid=<sid>; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`, plus `Secure` when COOKIE_SECURE=true. */
function cookieOptions(): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', path: '/', secure: config.cookieSecure };
}

function setSessionCookie(res: Response, sid: string): void {
  res.cookie(SESSION_COOKIE_NAME, sid, { ...cookieOptions(), maxAge: SESSION_ABSOLUTE_MAX_SECONDS * 1000 });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions());
}

function currentSid(req: Request): string | undefined {
  return readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
}

const register: RequestHandler = async (req, res) => {
  const input = registerSchema.parse(req.body);
  const { user, sid } = await authService.register(input);
  setSessionCookie(res, sid);
  res.status(201).json({ user });
};

const login: RequestHandler = async (req, res) => {
  const input = loginSchema.parse(req.body);
  const { user, sid } = await authService.login(input, currentSid(req), req.ip ?? 'unknown');
  setSessionCookie(res, sid);
  res.status(200).json({ user });
};

const logout: RequestHandler = async (req, res) => {
  const { id } = requireUser(req);
  await authService.logout(currentSid(req), id);
  clearSessionCookie(res);
  res.status(204).end();
};

const me: RequestHandler = async (req, res) => {
  const { id } = requireUser(req);
  try {
    const user = await authService.me(id, currentSid(req));
    res.json({ user });
  } catch (error) {
    // The session pointed at a user that no longer exists; the service already deleted it.
    clearSessionCookie(res);
    throw error;
  }
};

export const authController = { register, login, logout, me };
