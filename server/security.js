// Hardening for the auth endpoints.

const rateLimit = require('express-rate-limit');

// 20 attempts per IP per 15 minutes, shared across login + signup.
// Generous for humans who typo; hostile to credential-stuffing scripts.
// It also caps how much bcrypt CPU an attacker can burn by hammering
// signup (each hash is deliberately expensive — that's the point of
// bcrypt, but it cuts both ways).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts from this network — try again in a few minutes.' }
});

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Signup: enforce the password policy and normalize the email.
function checkSignup(body) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!EMAIL_RX.test(email) || email.length > 254) {
    return { error: 'Enter a valid email address.' };
  }
  if (password.length < 8 || password.length > 128) {
    return { error: 'Password must be 8-128 characters.' };
  }
  return { email, password };
}

// Login: only type/size sanity here — the length policy is enforced at
// signup, and the error stays generic so responses don't reveal whether
// an account exists.
function checkLogin(body) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password || email.length > 254 || password.length > 128) {
    return { error: 'Invalid email or password.' };
  }
  return { email, password };
}

module.exports = { authLimiter, checkSignup, checkLogin };
