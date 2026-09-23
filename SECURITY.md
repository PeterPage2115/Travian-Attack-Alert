# Security Policy

## Supported versions

`docs/release-state.json` currently records `stable: false`: the published
`1.0.1` is a release candidate, not a stable release. Security fixes are
best-effort, and no response-time promise is made.

| Version | Supported |
| --- | --- |
| 1.0.1 (release candidate; `docs/release-state.json` `stable: false`) | Best-effort security fixes |
| Older than 1.0.1 | No |

Nothing here claims stable or long-term support. `stable` may become `true`
only through the owner-only process documented in `docs/release-state.json`
and `docs/REPOSITORY-SETTINGS.md`.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Private Vulnerability
Reporting / Security Advisories:

- https://github.com/PeterPage2115/Travian-Attack-Alert/security/advisories/new

That is the repository Security tab → "Report a vulnerability" form. The
report stays private between you and the owner until an advisory is published;
GitHub Security Advisories are the only publication path for a confirmed
vulnerability.

**Never open a public issue for a vulnerability.** Public issues are for
ordinary bugs only, and a public issue must never contain secrets or player
data. Private vulnerability reporting is an owner-gated repository setting
(`docs/REPOSITORY-SETTINGS.md` §8) that the public API reported as disabled on
2026-09-23; if the private form is unavailable to you, open a public issue that
says only that you have a security report and asks the owner to enable private
vulnerability reporting — with no vulnerability detail, no secret, and no
player data.

There is no dedicated security contact email and no responsible-disclosure
timeline for this project.

This is a client-side userscript (Tampermonkey) with no server component,
no hosted service, and no user accounts. Do not include real secrets in any
report:

- Never paste Discord webhook URLs, tokens, cookies, passwords, raw page
  HTML, or full settings exports.
- Never paste player data (roster names, coordinates, alliance data) into a
  public issue.
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
pointing at the default release branch `release/public-1.0.0` raw dist
file):

```text
https://raw.githubusercontent.com/PeterPage2115/Travian-Attack-Alert/release/public-1.0.0/dist/travian-attack-alert.user.js
```

Branch-protection and release-state truth is recorded in
`docs/release-state.json`, not asserted here. That file currently records
the owner attestation as unrecorded (`ownerManual.branchProtection: false`)
and `stable: false`; any public API observation of branch protection
belongs to that release-state record, not to this policy.

Out of scope: Travian game servers, Discord infrastructure, browsers, and
userscript managers themselves.

## Trust boundary (same-origin)

The monitor envelope stored in userscript storage carries an `integrity`
field. It is a 32-bit non-cryptographic checksum (FNV-1a) over the
canonical serialization of the envelope. It detects accidental corruption
and a torn or partial write. It is **not** a message authentication code:
it carries no secret key and no keyed construction, so any code that can
run on the Travian origin, or otherwise reach the same storage, can
recompute it.

What that means, stated plainly:

- The checksum is an integrity check against accidents, not a defense
  against a same-origin attacker. Any other script, extension, or injected
  code executing on the Travian origin is outside this protection model:
  it can read, rewrite, or forge the stored envelope and its checksum.
- This release deliberately adds no HMAC, no GM-held integrity key, and no
  storage migration. A keyed MAC would not change the same-origin boundary
  here, because the key would live in the same reachable storage or in
  userscript-manager storage readable by the same manager.
- The boundary is accepted, not overlooked. The webhook secret stays in
  userscript storage via `GM_setValue`, the diagnostic bundle stays
  bounded and redacted, and nothing in this document weakens those
  controls.

The threat model is therefore: protect against accidental state damage and
ordinary network or webhook misuse, not against a compromised Travian page
or a hostile co-resident script.
