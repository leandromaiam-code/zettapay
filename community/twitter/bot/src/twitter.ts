import crypto from 'node:crypto';

export interface TwitterCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface PostedTweet {
  id: string;
  text: string;
}

export class TwitterApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TwitterApiError';
  }
}

const TWEETS_ENDPOINT = 'https://api.twitter.com/2/tweets';

/** RFC 3986 percent-encoding — note that URLSearchParams encodes per
 *  application/x-www-form-urlencoded which is NOT compatible with OAuth 1.0a. */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function nonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

function buildAuthHeader(
  method: string,
  url: string,
  creds: TwitterCredentials,
  now: Date = new Date(),
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(now.getTime() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };

  // Signature base string. The body for /2/tweets is JSON, NOT form-encoded,
  // so it does NOT contribute to the signature — only the OAuth params do.
  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(oauthParams[k]!)}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    rfc3986(url),
    rfc3986(paramString),
  ].join('&');

  const signingKey = `${rfc3986(creds.apiSecret)}&${rfc3986(creds.accessTokenSecret)}`;
  const signature = crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  const authParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };
  const header = Object.keys(authParams)
    .sort()
    .map((k) => `${rfc3986(k)}="${rfc3986(authParams[k]!)}"`)
    .join(', ');

  return `OAuth ${header}`;
}

export async function postTweet(
  text: string,
  creds: TwitterCredentials,
): Promise<PostedTweet> {
  const auth = buildAuthHeader('POST', TWEETS_ENDPOINT, creds);

  let res: Response;
  try {
    res = await fetch(TWEETS_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'zettapay-twitter-bot/0.1',
      },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    throw new TwitterApiError(
      `network error posting tweet: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new TwitterApiError(
      `tweet rejected: ${res.status} ${body}`,
      res.status,
    );
  }

  const json = (await res.json()) as { data?: { id?: string; text?: string } };
  const id = json.data?.id ?? '';
  return { id, text };
}

export const __test__ = { rfc3986, buildAuthHeader };
