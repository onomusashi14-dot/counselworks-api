import cors, { CorsOptions } from 'cors';

const DEV_DEFAULTS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
];

// Hardcoded production origins. ALLOWED_ORIGINS env can add more (e.g. a
// preview domain) but these are always permitted in production so a missing
// env var cannot silently open the API to every caller.
const PROD_DEFAULTS = [
  'https://app.counselintake.com',
  'https://counselintake.com',
  'https://counselworks-os.vercel.app',
  'https://counselworks-os-6ptq-hm82zwget-onomusashi14-dots-projects.vercel.app',
];

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const isProduction = process.env.NODE_ENV === 'production';

// In development, always allow the local Vite/Next dev servers. In production,
// union the hardcoded PROD_DEFAULTS with any explicit ALLOWED_ORIGINS.
const effectiveOrigins = isProduction
  ? Array.from(new Set([...ALLOWED_ORIGINS, ...PROD_DEFAULTS]))
  : Array.from(new Set([...ALLOWED_ORIGINS, ...DEV_DEFAULTS]));

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Same-origin / server-to-server (no Origin header) is always allowed.
    if (!origin) return callback(null, true);
    if (effectiveOrigins.includes(origin)) return callback(null, true);
    // In non-production, fall back to permissive behavior if the effective
    // list is empty so local scripts and tools still work. In production we
    // always have PROD_DEFAULTS, so an unknown origin is rejected.
    if (!isProduction && effectiveOrigins.length === 0) {
      return callback(null, true);
    }
    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

export const corsConfig = cors(corsOptions);
