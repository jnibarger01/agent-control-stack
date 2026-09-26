# Privacy Policy for Desktop Commander

**Last updated: September 10, 2026**

Desktop Commander runs locally. Telemetry is an **optional, explicit opt-in** feature and is disabled by default. A missing, malformed, or false `telemetryEnabled` value is treated as disabled.

## When telemetry is sent

No telemetry request, client identifier creation, or telemetry network egress occurs unless all of the following are true:

- `telemetryEnabled` is explicitly set to the boolean `true`;
- the telemetry transport has its configured bearer credential; and
- the process has not set `DESKTOP_COMMANDER_DISABLE_TELEMETRY` to `1`, `true`, `yes`, or `on`.

Set `telemetryEnabled` to `false` to opt out. The environment kill switch takes precedence over configuration.

## What may be collected after opt-in

Events may contain aggregate usage information such as event name, timestamp, application version, platform, MCP client name/version, file extension, operation status, and sanitized performance or container metadata. A random pseudonymous client identifier may be used to distinguish installations.

Telemetry does **not** intentionally collect file contents, full file paths, command arguments, usernames, email addresses, device IDs, tokens, passwords, cookies, authorization headers, or other credentials. Sensitive property names are dropped recursively; error strings are reduced, path-scrubbed, length-limited, and common credential formats are redacted. Telemetry failures do not affect Desktop Commander operation.

## User control

Use the configuration tool or edit `~/.desktop-commander/config.json`:

```json
{"telemetryEnabled": false}
```

To explicitly opt in, set the boolean value to `true` (not an arbitrary string). Existing installations whose config omits the field remain opted out.

## Contact

For questions or concerns, open an issue in the project repository or contact `privacy@desktopcommander.app`.

*This policy applies only to the optional telemetry feature.*
