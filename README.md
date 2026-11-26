# Our Days — Shared Calendar Web App

A shared calendar for couples to record daily moments and personal wellbeing. Guests can browse an empty calendar; registering a site account is required to save entries. The interface defaults to English and also supports Chinese and French.

**Live demo:** https://liangren-jilu-2026.pleasantcider16.chatgpt.site/

## Features

- Add multiple dated markers and timed notes for daily life, focus, intimacy, and menstrual periods.
- Link two accounts with an invitation code while keeping each person's records separate.
- Keep new markers and notes private by default, with optional sharing for individual entries.
- View estimated next period, ovulation, and fertile-window dates based on recorded cycle history. Estimates are informational and must not be used for contraception.
- Export personal data, unlink a partner, or delete an account and its records.

## Implementation

The project uses a JavaScript Worker, a D1 database, SQL migrations in `drizzle/`, and a browser interface in `worker/`. Hosting credentials, the production database, and user records are not included in this repository. The build includes a local `.openai/hosting.json` only when one is present. See [the Chinese documentation](README.zh-CN.md) for account and deployment details.

## Local validation

With Node.js and Python 3 available:

```sh
bash scripts/build.sh
node scripts/validate-artifact.mjs
node tests/integration.mjs
```

`tests/preview.mjs` can serve a local preview with a temporary SQLite database; it does not connect to production data.
