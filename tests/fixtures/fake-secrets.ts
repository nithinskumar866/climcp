// FAKE secrets for tests. None of these are real.
//
// Each one is glued together from pieces ("ghp_" + "..."), so the complete
// fake key never appears written out in this file. Otherwise GitHub's own
// secret scanning could block our push, thinking we leaked a real key.

const r = (s: string, n: number) => s.repeat(n);

export interface FakeSecret {
  name: string;
  /** The secret value itself: it must NOT survive scrubbing. */
  secret: string;
  /** How it appears in a note. */
  text: string;
  /** The type we expect in [REDACTED: type]. */
  type: string;
}

function fake(name: string, type: string, before: string, secret: string, after = ""): FakeSecret {
  return { name, type, secret, text: before + secret + after };
}

export const FAKE_SECRETS: FakeSecret[] = [
  fake("GitHub token", "github", "token: ", "ghp_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z5A"),
  fake("Anthropic key", "anthropic", "ANTHROPIC_API_KEY=", "sk-ant-api03-" + r("x7Yb2Qp9Lm", 9) + "-St7UvAA"),
  fake("OpenAI key", "openai", "OPENAI_API_KEY=", "sk-proj-" + r("Ab1Cd2Ef3G", 7) + "Ab1C" + "T3BlbkFJ" + r("Xy9Wv8Ut7S", 7) + "Xy9W"),
  fake("AWS key id", "aws", "key ", "AKIA" + "Z7QRSTUVWXYZ2345"),
  fake("Stripe live key", "stripe", "", "sk_" + "live_" + "51Hx9QrLm2Np4Tv6Xz8Bd0Fh2Jl4Np6Rt8Vx0Zb2"),
  fake("Slack token", "slack", "", "xoxb-" + "123456789012-1234567890123-" + "AbCdEfGhIjKlMnOpQrStUvWx"),
  fake("npm token", "npm", "//registry.npmjs.org/:_authToken=", "npm_" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2"),
  fake(
    "Private key",
    "privatekey",
    "",
    "-----BEGIN RSA PRIVATE " + "KEY-----\nMIIEowIBAAKCAQEA" + r("q7Zp3Lk9Xw2Rt5Yv8Bn1Mc4Jd6Hf0Gs2Ke7Ua9", 3) + "\n-----END RSA PRIVATE KEY-----",
  ),
  fake("Database URL", "database-connection-string", "DATABASE_URL=", "postgres://admin:" + "S3cr3tPassw0rd" + "@db.example.com:5432/app"),
  fake("Password in a URL", "basicauth", "curl ", "https://user:" + "hunter2pass" + "@api.example.com"),
  fake("JWT", "jwt", "session ", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
  fake("PASSWORD= in .env style", "password", "PASSWORD=", "Tr0ub4dor" + "&3"),
  fake("password: in YAML", "password", 'db_password: "', "Tr0ub4dor" + "&3", '"'),
  fake("password in a sentence", "password", "the staging db password is ", "Tr0ub4dor" + "&3"),
  fake("generic api_key", "password", "api_key = ", "a8f5f167f44f" + "4964e6c998dee827110c"),
  fake("AWS secret key", "password", "aws_secret_access_key = ", "q7Zp3Lk9Xw2Rt5Yv8Bn1" + "Mc4Jd6Hf0Gs2Ke7Ua9Pi3"),
  fake("Bearer token", "bearer-token", "Authorization: Bearer ", "q7Zp3Lk9Xw2Rt5Yv" + "8Bn1Mc4Jd6"),
];

/** Text that looks a bit like secrets but is NOT, and must stay exactly as it is. */
export const SAFE_TEXTS: string[] = [
  "We decided to use Postgres instead of MySQL. Next step: add tests.",
  "PASSWORD=${DB_PASSWORD}",
  "password: process.env.DB_PASS",
  "api_key: <your-api-key-here>",
  "The password is required. Fixed the reset password flow.",
  "max_tokens: 4096",
  "token: [REDACTED: github]",
  "See src/auth/token-refresh.ts for details.",
];
