# Host integration and detection

brigadier supports seven hosts: `claude-code`, `codex`, `opencode`, `cursor`,
`windsurf`, `antigravity`, and `claude-desktop`. `brigadier init` is the setup
step that detects them, records the user's choices, and installs the selected
integrations. `brigadier install` refreshes those integrations later.

## Install the binary

The release installer is the primary path:

```sh
curl -fsSL https://raw.githubusercontent.com/stephen-golban/brigadier/main/install.sh | sh
```

The Homebrew formula is in the public `stephen-golban/homebrew-tap` tap.
Homebrew 6 requires that third-party tap to be trusted explicitly, so use all
three commands:

```sh
brew tap stephen-golban/tap
brew trust stephen-golban/tap
brew install brigadier
```

After the binary is available, run the single host-setup command:

```sh
brigadier init
```

## How host detection works

Detection is read-only. For the three command-line hosts, brigadier first looks
for the host's executable on `$PATH`. It splits `$PATH` into entries without
trimming them, ignores an empty entry instead of treating it as the current
directory, requires the candidate to be a file, and calls `access(X_OK)` to
prove it is executable. It never infers executability from stat mode bits.

If the executable probe does not prove the host present, brigadier checks that
host's marker candidates in the order listed below. A marker must have the
listed kind: a file where a file is expected, or a directory where a directory
is expected. Any error while probing a candidate means “not present; keep
looking.” Successful evidence is reported as an absolute path.

The environment-based markers for Claude Code, Codex, and opencode are
additive. When `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, or `$XDG_CONFIG_HOME` is
set, its marker is checked first and the `$HOME` marker is still checked after
it.

### `claude-code`

Detection, in order:

1. executable `claude` on `$PATH`;
2. file `$CLAUDE_CONFIG_DIR/settings.json`, when the variable is set;
3. file `$HOME/.claude/settings.json`;
4. file `$HOME/.claude.json`.

The install root is `$CLAUDE_CONFIG_DIR` when that value is usable, with
`$HOME/.claude` as its default. brigadier writes:

- `skills/brigadier/SKILL.md`;
- `skills/brigadier/.claude-plugin/plugin.json`;
- `skills/brigadier/hooks/hooks.json`;
- executable `skills/brigadier/hooks/handoff.mjs`;
- executable `skills/brigadier/hooks/nudge.mjs`; and
- `skills/brigadier/hooks/README.md`.

### `codex`

Detection, in order:

1. executable `codex` on `$PATH`;
2. file `$CODEX_HOME/config.toml`, when the variable is set;
3. file `$CODEX_HOME/auth.json`, when the variable is set;
4. file `$HOME/.codex/config.toml`;
5. file `$HOME/.codex/auth.json`.

brigadier writes the shared skill files under
`$HOME/.agents/skills/brigadier`:

- `SKILL.md`;
- executable `hooks/handoff.mjs`; and
- `hooks/README.md`.

It also writes `AGENTS.md` under `$CODEX_HOME` (default
`$HOME/.codex`) and merges its `PreCompact` hook entry into `hooks.json` in
that same Codex root.

### `opencode`

Detection, in order:

1. executable `opencode` on `$PATH`;
2. file `$XDG_CONFIG_HOME/opencode/opencode.json`, when the variable is set;
3. file `$HOME/.config/opencode/opencode.json`.

The install root is `$XDG_CONFIG_HOME/opencode`, with
`$HOME/.config/opencode` as its default. brigadier writes:

- `plugin/brigadier.js`; and
- `brigadier.README.md`.

`brigadier install opencode` does not write a skill. The Codex skill at
`$HOME/.agents/skills/brigadier` is shared with opencode; the opencode-specific
files provide its hook integration.

### Why bare skill directories are not evidence

A bare `$HOME/.claude`, `$HOME/.codex`, or
`$HOME/.config/opencode` directory proves nothing because brigadier can create
those roots while installing its own files. Detection therefore uses only the
host-owned files listed above as marker evidence.

`$HOME/.agents/skills` is never a detection signal. Codex and opencode both
read it, and brigadier creates it when installing the Codex integration.

## GUI hosts

The four GUI hosts have no executable probe. Their candidates are directories
and are checked in exactly the following order.

### `cursor`

Detection candidates:

1. `$HOME/.cursor`;
2. `$HOME/.config/Cursor`;
3. `$HOME/Applications/Cursor.app`;
4. `/Applications/Cursor.app`;
5. `$HOME/Library/Application Support/Cursor`;
6. `$APPDATA/Cursor`, when `$APPDATA` is set.

brigadier merges this entry into `mcpServers.brigadier` in
`$HOME/.cursor/mcp.json`:

```json
{ "type": "stdio", "command": "<command>", "args": ["mcp"] }
```

### `windsurf`

Detection candidates:

1. `$HOME/.codeium/windsurf`;
2. `$HOME/.config/Windsurf`;
3. `$HOME/Applications/Windsurf.app`;
4. `/Applications/Windsurf.app`;
5. `$HOME/Library/Application Support/Windsurf`;
6. `$APPDATA/Windsurf`, when `$APPDATA` is set.

brigadier merges this entry into `mcpServers.brigadier` in
`$HOME/.codeium/windsurf/mcp_config.json`:

```json
{ "command": "<command>", "args": ["mcp"] }
```

### `antigravity`

Detection candidates:

1. `$HOME/.antigravity`;
2. `$HOME/.gemini/antigravity`;
3. `$HOME/.config/Antigravity`;
4. `$HOME/Applications/Antigravity.app`;
5. `/Applications/Antigravity.app`;
6. `$HOME/Library/Application Support/Antigravity`;
7. `$APPDATA/Antigravity`, when `$APPDATA` is set;
8. `$LOCALAPPDATA/Antigravity`, when `$LOCALAPPDATA` is set.

brigadier merges this entry into `mcpServers.brigadier` in
`$HOME/.gemini/config/mcp_config.json`:

```json
{ "command": "<command>", "args": ["mcp"] }
```

### `claude-desktop`

Detection candidates:

1. `$HOME/Applications/Claude.app`;
2. `/Applications/Claude.app`;
3. `$HOME/Library/Application Support/Claude`;
4. `$HOME/.config/Claude`;
5. `$APPDATA/Claude`, when `$APPDATA` is set.

brigadier merges this entry into `mcpServers.brigadier` in
`$HOME/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{ "command": "<command>", "args": ["mcp"] }
```

It also stages two bundle files under
`$BRIGADIER_HOME/surfaces/claude-desktop` (default
`$HOME/.brigadier/surfaces/claude-desktop`): `manifest.json` and `README.md`.
Staging those files does not install the bundle into Claude Desktop.

### `$APPDATA` and `$LOCALAPPDATA` are not platform-gated

The GUI candidate builder reads `$APPDATA` and `$LOCALAPPDATA` directly from
the environment. There is no operating-system check around them. If either
variable is set on macOS or Linux, its candidates above are probed there too.

The paths used as detection evidence and the paths used for installation are
separate decisions. For example, an `$APPDATA/Cursor` directory can prove
Cursor present, while the integration target remains `$HOME/.cursor/mcp.json`.

### The command in a GUI registration

`<command>` is the trimmed, nonblank value of `$BRIGADIER_MCP_COMMAND` when supplied.
Without that override, a compiled executable named `brigadier` records its own
path; other launch forms record the bare command `brigadier`. The installer
prints a warning whenever that recorded command is not absolute.

## Presence, consent, and the later directory check

GUI registration has two independent gates:

1. **Presence.** The host must be detected. A failed presence check prints
   `not detected on this machine`. Install the host itself to make its own
   executable or marker exist; running `brigadier init` cannot make an absent
   host detected.
2. **Consent.** Parsed configuration must contain
   `"guiRegistrationConsent": true`. A missing, unreadable, invalid, or explicit
   false value is not consent. Run an interactive `brigadier init` and answer
   yes to `Register brigadier's MCP server with detected GUI hosts` to record
   it. `--force` never grants consent.

These gates are independent: consent does not prove presence, and presence does
not grant consent.

There is a separate, later configuration-directory check. In an ordinary
unforced install, it is reached only after host detection and consent have
passed. A GUI host can be detected from its application bundle while its
configuration directory is still absent. In that case registration is skipped
with:

```text
<root> does not exist, so this host is not installed on this machine. brigadier does not create another product's configuration directory.
```

That message is not the detection failure. brigadier proved the host present,
then declined to create another product's configuration directory.

## `init` and `install` selection rules

`brigadier init` performs one detection pass, offers only detected hosts, writes
the configuration, and hands the chosen nonempty host set plus that same
detection result to the installer. If nothing was detected, or the user says no
to every host, it writes the configuration and returns `0` immediately. The
installer is not called, so there is no install report.

The standalone install forms select differently:

- Bare `brigadier install` uses the recorded `enabledHosts`. If none are
  recorded, it prints
  `brigadier install: no enabled hosts are recorded; run \`brigadier init\` to choose which detected hosts to install.`
  and exits `1` before host detection runs.
- `brigadier install --all` considers all seven hosts but installs only those
  currently detected. If none are detected, it exits `1`.
- `brigadier install <host>` checks the named host. When it is undetected, the
  command skips it and exits `0`; adding `--force` installs that explicitly
  named host anyway.
- `--force` bypasses failed presence only for explicitly named hosts. It does
  not widen bare or `--all` selection and does not bypass GUI consent.

`brigadier init --yes` enables detected skill hosts. It does not newly enable a
GUI host, but it retains a detected GUI host already recorded in
`enabledHosts`, because that host previously received an explicit human yes.

For files brigadier owns outright, `$BRIGADIER_HOME/surfaces.json` records the
hash last written. An unrecognized or subsequently edited destination is
refused unless `--force` is supplied. Shared Codex and GUI configuration files
are merged instead: brigadier changes only its own hook entry or
`mcpServers.brigadier` entry.
