# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in SkyTwin, please report it responsibly.

**Do not open a public issue.** Instead, email **jay@skytwin.dev** with:

- A description of the vulnerability
- Steps to reproduce
- Impact assessment (what could an attacker do?)
- Any suggested fix, if you have one

You should receive an acknowledgment within 48 hours. We'll work with you to understand the issue and coordinate a fix before any public disclosure.

## Scope

SkyTwin is a delegated judgment system that acts on behalf of users. Security is foundational to the project. The following areas are especially sensitive:

- **Policy engine bypasses** -- any way to execute actions without policy checks
- **Trust tier escalation** -- gaining higher autonomy without earning it through feedback
- **Spend limit circumvention** -- executing actions that exceed configured limits
- **Explanation tampering** -- modifying or suppressing audit records
- **OAuth token exposure** -- leaking or misusing stored credentials
- **Twin model poisoning** -- manipulating the preference model to cause harmful actions

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.3.x   | Yes       |
| < 0.3   | No        |

## Security Design

SkyTwin's safety model is documented in detail at [docs/safety-model.md](./docs/safety-model.md). Key design principles:

- Every action passes through the policy engine before execution
- Trust is earned incrementally through user feedback, never granted by default
- Spend limits are enforced as hard limits with no approximation
- Every automated action produces an auditable explanation record
- The user can inspect, override, narrow, or shut off the system at any time
