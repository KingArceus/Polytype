import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'polytype_admin';
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_RECORDS = 1000;

const digest = (value) => createHash('sha256').update(value).digest();

export class AdminAuth {
  constructor({ key = '', secureCookie = false, sessionTtlMs = 60 * 60 * 1000, now = Date.now } = {}) {
    if (typeof key !== 'string') throw new Error('The admin key must be a string.');
    if (!Number.isFinite(sessionTtlMs) || sessionTtlMs < 1) throw new Error('Invalid admin session lifetime.');
    this.keyHash = key ? digest(key) : null;
    this.secureCookie = secureCookie;
    this.sessionTtlMs = sessionTtlMs;
    this.now = now;
    this.sessions = new Map();
    this.attempts = new Map();
  }

  get configured() { return this.keyHash !== null; }

  token(request) {
    const cookie = (request.headers.cookie || '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`));
    const token = cookie?.slice(COOKIE_NAME.length + 1);
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  }

  authenticated(request) {
    const token = this.token(request);
    if (!token) return false;
    const key = digest(token).toString('hex');
    const expiry = this.sessions.get(key);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) { this.sessions.delete(key); return false; }
    return true;
  }

  sameOrigin(request) {
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!request.headers.origin) return true;
    try {
      const protocol = this.secureCookie || request.socket.encrypted ? 'https:' : 'http:';
      return new URL(request.headers.origin).origin === `${protocol}//${request.headers.host}`;
    } catch { return false; }
  }

  cookie(token, request, maxAge) {
    const secure = this.secureCookie || request.socket.encrypted;
    return `${COOKIE_NAME}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  prune(map, expiry) {
    const now = this.now();
    for (const [key, value] of map) if (expiry(value) <= now) map.delete(key);
    if (map.size >= MAX_RECORDS) map.delete(map.keys().next().value);
  }

  login(key, request) {
    if (!this.configured) return { status: 503, error: 'Quản trị chưa được cấu hình trên máy chủ.' };
    const address = request.socket.remoteAddress || 'unknown';
    const now = this.now();
    this.prune(this.attempts, (record) => record.until);
    const attempt = this.attempts.get(address);
    if (attempt?.count >= MAX_ATTEMPTS) {
      return { status: 429, error: 'Bạn đã thử quá nhiều lần. Vui lòng thử lại sau.', retryAfter: Math.ceil((attempt.until - now) / 1000) };
    }
    const validInput = typeof key === 'string' && key.length > 0 && key.length <= 4096;
    const candidate = digest(validInput ? key : '');
    if (!timingSafeEqual(candidate, this.keyHash) || !validInput) {
      this.attempts.set(address, { count: (attempt?.count || 0) + 1, until: attempt?.until || now + ATTEMPT_WINDOW_MS });
      return { status: 401, error: 'Khóa quản trị không đúng.' };
    }
    this.attempts.delete(address);
    this.logout(request);
    this.prune(this.sessions, (expiry) => expiry);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(digest(token).toString('hex'), now + this.sessionTtlMs);
    return { status: 200, cookie: this.cookie(token, request, Math.ceil(this.sessionTtlMs / 1000)) };
  }

  logout(request) {
    const token = this.token(request);
    if (token) this.sessions.delete(digest(token).toString('hex'));
    return this.cookie('', request, 0);
  }
}
