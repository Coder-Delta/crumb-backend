import { OAuth2Client } from 'google-auth-library';
import { User } from '../models.js';

const clientId = process.env.GOOGLE_CLIENT_ID;
const googleClient = clientId ? new OAuth2Client(clientId) : null;

function authError(message, status) {
  return Object.assign(new Error(message), { status });
}

export async function authenticateGoogleCredential(credential) {
  if (!googleClient) {
    throw authError('Google sign-in is not configured on this server.', 503);
  }

  let identity;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: clientId });
    identity = ticket.getPayload();
  } catch {
    throw authError('Google could not verify your sign-in. Please try again.', 401);
  }

  if (!identity?.sub || !identity.email || identity.email_verified !== true) {
    throw authError('Use a verified Google account to continue.', 401);
  }

  const email = identity.email.toLowerCase();
  let user = await User.findOne({ googleId: identity.sub }).select('+googleId');
  if (!user) user = await User.findOne({ email }).select('+googleId');

  if (user?.role === 'admin' && user.googleId !== identity.sub) {
    throw authError('Google sign-in is not enabled for this administrator account.', 403);
  }
  if (user?.googleId && user.googleId !== identity.sub) {
    throw authError('This email is already linked to a different Google account.', 409);
  }
  if (user && !user.active) {
    throw authError('This account has been disabled.', 403);
  }

  if (!user) {
    return User.create({
      name: String(identity.name || identity.given_name || email.split('@')[0])
        .trim()
        .slice(0, 80),
      email,
      googleId: identity.sub,
      role: 'customer',
    });
  }

  if (!user.googleId) {
    user.googleId = identity.sub;
    await user.save();
  }
  return user;
}
