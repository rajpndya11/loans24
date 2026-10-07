// Built-in keys so the site works on Vercel with zero setup (demo use).
// Setting INTERNAL_API_KEY / SESSION_SECRET in Vercel overrides these. Do that before real customers use it.
export const DEMO_DEFAULTS = {
  // Password for the review console at /admin/
  internalApiKey: 'demo-jeGtf-2kmmrsLkB-_YmxJy6gQXE3nTuQ',
  // Signs login cookies
  sessionSecret: 'l9dpvO8F7_7dVE6603181CsuklMvatw6MfPBoROEolA',
};

// Fixed login code used in demo mode (no SMS provider configured).
export const DEMO_OTP = '123456';