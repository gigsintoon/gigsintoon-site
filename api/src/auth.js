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

module.exports = { principal, isOwner, seesAll };
