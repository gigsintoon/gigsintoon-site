// Who is asking? Static Web Apps passes the signed-in user in this header.
function principal(request) {
  const header = request.headers.get('x-ms-client-principal');
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function isOwner(request) {
  const p = principal(request);
  return !!p && (p.userRoles || []).includes('owner');
}

// Owners see everything (drafts, not posted, do-not-post). Everyone else only sees posted releases.
// An owner can add ?view=public to see the site exactly as a visitor would.
function seesAll(request) {
  return isOwner(request) && request.query.get('view') !== 'public';
}

// Launch: Saturday 14 November 2026, 12:00 UK time (GMT = UTC). Until then visitors only get the countdown page;
// the owner sees everything. Nothing needs deploying at launch – the check below just starts passing.
const LAUNCH_AT = process.env.LAUNCH_AT || '2026-11-14T12:00:00Z';
function isLive() { return Date.now() >= Date.parse(LAUNCH_AT); }
function prelaunch(request) { return !isLive() && !isOwner(request); }
function prelaunchResponse() {
  return { status: 403, jsonBody: { prelaunch: true, launchAt: LAUNCH_AT, error: 'Not launched yet.' },
           headers: { 'Cache-Control': 'no-store' } };
}

module.exports = { principal, isOwner, seesAll, LAUNCH_AT, isLive, prelaunch, prelaunchResponse };
