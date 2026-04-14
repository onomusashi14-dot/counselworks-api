import { CookieOptions } from 'express';

const isProduction = process.env.NODE_ENV === 'production';

// Default the cookie domain to the apex in production so a session set by
// api.counselintake.com is readable by app.counselintake.com. Locally we
// leave it undefined so browsers scope to the current host.
const defaultDomain = isProduction ? '.counselintake.com' : undefined;

// sameSite must be 'lax' (not 'strict') so top-level navigations from
// app.counselintake.com → api.counselintake.com carry the session cookie.
// 'strict' would block the cross-subdomain auth flow.
const SAME_SITE: CookieOptions['sameSite'] = 'lax';

export const SESSION_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true' || isProduction,
  sameSite: SAME_SITE,
  domain: process.env.COOKIE_DOMAIN || defaultDomain,
  maxAge: 60 * 60 * 1000, // 1 hour
};

export const REFRESH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true' || isProduction,
  sameSite: SAME_SITE,
  domain: process.env.COOKIE_DOMAIN || defaultDomain,
  path: '/auth/refresh',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

export const SESSION_COOKIE_NAME = 'cw_session';
export const REFRESH_COOKIE_NAME = 'cw_refresh';
