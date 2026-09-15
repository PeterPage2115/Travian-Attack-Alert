# Security Policy

## Reporting a Vulnerability

Report vulnerabilities via **GitHub Issues**:

- https://github.com/PeterPage2115/Travian-Attack-Alert/issues

Open a new issue describing the suspected vulnerability. There is no
dedicated security contact email and no responsible-disclosure timeline for
this project.

This is a client-side userscript (Tampermonkey) with no server component,
no hosted service, and no user accounts. Do not include real secrets in any
report:

- Never paste Discord webhook URLs, tokens, cookies, passwords, raw page
  HTML, or full settings exports.
- Attach only the redacted incident bundle from the Diagnostics tab
  (Export incident bundle), after verifying it holds no webhook, token,
  cookie, or raw DOM.
- Use synthetic or redacted data for reproduction steps, as described in the
  bug report template.

Reports containing secrets will be asked to redact, not processed as-is.

## Scope

In scope: the userscript source in `src/`, the deterministic build in
`tools/build.cjs`, the installable artifact in `dist/`, and the update
channel pinned by `config/userscript.json` (`updateURL`/`downloadURL`
pointing at the protected `main` branch raw dist URL).

Out of scope: Travian game servers, Discord infrastructure, browsers, and
userscript managers themselves.
