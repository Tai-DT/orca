---
name: orca-emulator
description: >-
  iOS Simulator and physical iPhone/iPad control from inside Orca, with the
  live device view in Orca's emulator pane. Use when driving a booted Apple
  Simulator or a paired physical iOS device on macOS: taps, gestures, typing,
  hardware buttons, rotation, the accessibility tree, app install/launch, and
  device diagnostics (syslog, crash reports), or when an iOS change needs
  on-device evidence. For an Android device or emulator use the Android
  emulator skill; build and install the app with xcodebuild or simctl first.
license: Apache-2.0
---

# Orca Emulator (iOS)

`ORCA` is a placeholder for the executable you resolved in the stub; substitute it before running.

## Command surface

`ORCA emulator --help` lists the wrapped verbs. Anything else goes through
`ORCA emulator exec --command "<serve-sim command>"`, which forwards the string to serve-sim
unvalidated with the active device injected.

`install`, `launch`, `permissions`, and `logcat` fail against a simulator with
`emulator_unsupported`. A paired physical iPhone or iPad (the `ios-device` backend) adds
`install` (.ipa), `launch` (bundle identifier), and `logcat` (unified syslog) through
`devicectl`; `permissions` stays Android-only. `tap`, `type`, `gesture`, `button`,
`rotate`, `ax`, and `exec` work on both backends — on physical devices input is driven by
WebDriverAgent, which Orca signs, builds, and launches on demand.

Commands drive devices on the host that runs the Orca runtime. Simulators need that host to
be a Mac, so a Linux `orca serve` or SSH host can drive only Android devices.

## Prerequisites

- macOS with the Xcode Command Line Tools (`xcrun --version`).
- A booted simulator (`xcrun simctl list devices booted`), or let `attach` boot one.
- An active session for the worktree before any input verb: run `ORCA emulator attach` or
  open the emulator pane.
- In a `pnpm dev` checkout, run `pnpm build:cli` before the first emulator command so the
  dev CLI shim reaches this worktree's runtime instead of a packaged install.

Orca reports a clear error when the host is missing macOS or the Xcode tools.

For a physical device, the device must be paired to the Mac and appear in
`ORCA emulator devices --json` with backend `ios-device`. The first `attach` builds and
signs WebDriverAgent with the configured Apple team, which requires Xcode (not only the
CLT) and may take a few minutes; later attaches reuse the cached build. Syslog capture
uses `idevicesyslog` (libimobiledevice) and crash reports use `pymobiledevice3`; Orca
fails with `emulator_unsupported` when the tool a diagnostic needs is missing.

## Operations

Use `--json` for agent-driven calls. Unqualified commands target the worktree's active
device.

| Goal                     | Command                                                                 | Constraint                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List available / running | `ORCA emulator list --json`                                             | Orca-managed sessions plus raw serve-sim streams. Use its ids for `--device` / `--emulator`.                                                                          |
| List devices everywhere  | `ORCA emulator devices --json`                                          | Every backend's devices with a platform column, booted and shutdown.                                                                                                  |
| Attach / make active     | `ORCA emulator attach "iPhone 16 Pro" --json`                           | Starts the helper if needed and makes the device active for the worktree. `--focus` switches the UI; it does not by default.                                          |
| Single tap               | `ORCA emulator tap <x> <y> --json`                                      | Normalized 0..1 coordinates.                                                                                                                                          |
| Multi-step gesture       | `ORCA emulator gesture '<json>' --json`                                 | Begin/move/end points. Use `tap` for a single tap.                                                                                                                    |
| Type text                | `ORCA emulator type "text" --json`                                      | US-ASCII only.                                                                                                                                                        |
| Hardware button          | `ORCA emulator button home --json`                                      | `home` and `side_button` are documented by the CLI spec; other names such as `swipe_home`, `app_switcher`, `lock`, and `siri` are forwarded to serve-sim unvalidated. |
| Rotate device            | `ORCA emulator rotate landscape_left --json`                            | The orientation persists for subsequent gestures.                                                                                                                     |
| Accessibility tree       | `ORCA emulator ax --json`                                               | serve-sim node tree, capped at 500 nodes, frames normalized 0..1 with a top-left origin. Needs an active session.                                                     |
| Raw passthrough          | `ORCA emulator exec --command "ca-debug blended on" --json`             | serve-sim subcommand string, without a `serve-sim` prefix.                                                                                                            |
| Syslog (physical only)   | `ORCA emulator logcat --lines 200 --json`                               | Captures the unified log via `idevicesyslog`, parsed to entries. `--filter proc:SpringBoard` filters by process, other `--filter` values match message text.          |
| List crash reports       | `ORCA emulator exec --command "crashlogs" --json`                       | Physical only. Lists crash reports on the device via `pymobiledevice3`.                                                                                               |
| Pull crash reports       | `ORCA emulator exec --command "crashlogs pull /abs/dir [regex]" --json` | Physical only. Copies matching reports into an absolute local directory and returns the filenames.                                                                    |
| Device screenshot        | `ORCA emulator exec --command "screenshot /abs/path.png" --json`        | Physical only. Captures the device screen through `devicectl`.                                                                                                        |
| List installed apps      | `ORCA emulator exec --command "apps" --json`                            | Physical only. Installed apps on the device.                                                                                                                          |
| Lock state               | `ORCA emulator exec --command "lockstate" --json`                       | Physical only. Whether the device is locked.                                                                                                                          |
| Stop the helper          | `ORCA emulator kill --json`                                             | Leaves the device booted.                                                                                                                                             |
| Stop and power off       | `ORCA emulator shutdown --json`                                         | Stops the helper and shuts the simulator device down.                                                                                                                 |

## Targeting

`attach`, or opening the emulator pane, makes one device active per worktree, and unqualified
commands target it. Pass a selector only to override that or reach a second device. With no
active session an unqualified command fails with `emulator_no_active`; attach or open the pane
and retry.

- `--device "iPhone 16 Pro"` or `--device <udid>`, from `list` or `devices`.
  `--emulator <id>` is an alternative spelling: the bridge resolves both through the same lookup. These
  selectors apply to the action verbs; `list` and `devices` take only `--worktree`, and
  `attach` names its device as a positional argument.
- `--worktree id:<fullWorktreeId>` or `--worktree active`. The full id is the exact
  `<repo-id>::<path>` value returned by `ORCA worktree list --json`; a bare repo id is not
  valid here.
- `--worktree all` drops worktree scoping on every verb, not only on listing, so a mutating
  command passed `all` runs unscoped. Use it only for listing.

## Constraints

- All coordinates are normalized 0..1 with a top-left origin, never pixels. Tap an `ax`
  element at its frame center: `x + width / 2`, `y + height / 2`.
- Prefer `tap` over `gesture` for a single tap. A separate gesture begin/end pair can be
  interpreted as a long press because of WebSocket overhead; `tap` sends the quick sequence.
- `type` sends US-ASCII only, and unsupported characters error rather than degrading.
- The pane and the CLI share one stream and one helper, so closing the pane can stop the
  stream.
- Run `kill` when you are done. A helper left running holds the device until Orca quits.
- The iOS backend drives private simulator APIs, so an Xcode update can change its behavior.

## Examples

```text
ORCA emulator list --json
ORCA emulator attach "iPhone 16 Pro" --json
ORCA emulator tap 0.5 0.8 --json
ORCA emulator type "user@example.com" --json
ORCA emulator button home --json
ORCA emulator ax --json
ORCA emulator exec --command "ca-debug blended on" --json
ORCA emulator kill --device "iPhone 16 Pro" --json
```

See also: `orca-emulator-android` for Android devices, `orca-cli` for terminals, worktrees,
and the built-in browser, and `computer-use` for desktop UI outside the simulator.
