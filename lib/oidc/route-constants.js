'use strict';

// Path and header constants shared by the OIDC route, the auth seam and the
// mount (#4267). Kept apart from route.js so the seam does not pull the whole
// route module in just to learn a header name.

const LOGIN_PATH = '/auth/oidc/login';
const CALLBACK_PATH = '/auth/oidc/callback';
const SESSION_PATH = '/auth/session';
const LOGOUT_PATH = '/auth/logout';
const OIDC_PATHS = Object.freeze([LOGIN_PATH, CALLBACK_PATH, SESSION_PATH, LOGOUT_PATH]);
const CSRF_HEADER = 'x-huqan-csrf';
const POST_LOGIN_PATH = '/viewer';

function isOidcPath(pathname) {
  return OIDC_PATHS.includes(pathname);
}

module.exports = {
  LOGIN_PATH,
  CALLBACK_PATH,
  SESSION_PATH,
  LOGOUT_PATH,
  OIDC_PATHS,
  CSRF_HEADER,
  POST_LOGIN_PATH,
  isOidcPath,
};
