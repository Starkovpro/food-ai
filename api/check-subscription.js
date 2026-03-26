export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  const SUPABASE_URL = 'https://siwibqrykqlyxiwtukst.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  try {
    // Get user from token
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SERVICE_KEY
      }
    });

    if (!userRes.ok) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const user = await userRes.json();
    const email = user.email;

    if (!email) {
      return res.status(400).json({ error: 'No email found' });
    }

    // Check subscription in table
    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}&active=eq.true&expires_at=gt.${new Date().toISOString()}&select=email,active,expires_at`,
      {
        headers: {
          'apikey': SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const subs = await subRes.json();
    const hasSubscription = Array.isArray(subs) && subs.length > 0;
    const expiresAt = hasSubscription ? subs[0].expires_at : null;

    return res.status(200).json({ hasSubscription, expiresAt, email });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
