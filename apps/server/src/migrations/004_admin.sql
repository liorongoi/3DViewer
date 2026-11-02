-- WP 3.9: admin sign-in. The password hash itself lives in settings ('admin.password').
-- Only a SHA-256 of each session token is kept, so a copy of the database cannot sign in.
CREATE TABLE admin_sessions (
  token_hash  text PRIMARY KEY,
  ip          text NOT NULL DEFAULT '',
  host        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
