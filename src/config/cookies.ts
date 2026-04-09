import { CookieOptions } from 'express';

const isProduction = process.env.NODE_ENV === 'production';

export const SESSION_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true' || isProduction,
  sameSite: 'strict',
  domain: process.env.COOKIE_DOMAIN || undefined,
  maxAge: 60 * 60 * 1000, // 1 hour
};

export const REFRESH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true' || isProduction,
  sameSite: 'strict',
  domain: process.env.COOKIE_DOMAIN || undefined,
  path: '/auth/refresh',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

export const SESSION_COOKIE_NAME = 'cw_session';
export const REFRESH_COOKIE_NAME = 'cw_refresh';
