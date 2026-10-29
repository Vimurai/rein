# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue or pull request.

- **GitHub:** use *Report a vulnerability* on the repository's Security tab (private advisory), or
- **Email:** emirkovacevic@protonmail.com — write "Rein security" in the subject.

Include what you found, how to reproduce it, the version or commit, and the impact you expect.
If you have a fix, describe it in the report rather than opening a public pull request.

## What to expect

| Step | Time |
| :--- | :--- |
| Acknowledgement of your report | within 7 days |
| First assessment (confirmed, needs more information, or not a vulnerability) | within 14 days |
| Fix or mitigation for a confirmed issue | as soon as practical; we aim for 90 days at most |

Rein is maintained by one person in their own time, so these are commitments made in good
faith rather than a contractual service level. You will be told when a fix is released and, if
you wish, credited in the release notes.

## Scope

In scope: the code in this repository — the `rein` CLI, the installer, the hooks and gates, the MCP
servers, the agents and skills. Especially welcome: ways to get past the tool-call gate, the
pre-commit or pre-push gates, the secret rule or the role boundaries, and anything that could leak
a user's code or data off their machine.

Out of scope: Claude Code itself (report to Anthropic), and third-party MCP servers or packages
(report to their maintainers).

## Supported versions

Only the latest release receives security fixes.
