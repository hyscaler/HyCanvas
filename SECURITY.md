# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately. Do not open a public issue or
pull request for a security problem.

- Preferred: open a private security advisory through the repository's security
  tab (GitHub Security Advisories), or
- Email: security@hycanvas.app

Include a description of the issue, steps to reproduce, the affected component
(frontend, Go backend, a specific `@hc/*` package), and any proof-of-concept.
We aim to acknowledge reports within a few business days and will keep you
updated on remediation.

Please give us a reasonable opportunity to fix the issue before any public
disclosure.

## Supported versions

HyCanvas is pre-1.0 and under active development. Security fixes target the
latest released version and the default branch.

## Deployment hardening

Self-hosters should review the production guidance in `README.md`. At minimum:

- Set a strong, random `JWT_SECRET` (the API refuses to start without one). It
  also encrypts stored provider keys and MFA secrets unless a separate
  `AI_SECRET` is set.
- Serve over HTTPS and set `NODE_ENV=production` so session cookies are marked
  Secure.
- Configure object storage and database credentials via environment variables;
  never commit them.
