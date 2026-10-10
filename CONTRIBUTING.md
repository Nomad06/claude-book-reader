# Contributing

Pull requests are welcome: bug fixes, support for more terminals, desktops and
browsers, and better text extraction. For a larger change, open an issue first
so we can agree on the shape.

## Run it

You need Node.js 22.13 or newer and Claude Code.

```bash
git clone https://github.com/Nomad06/claude-book-reader.git
cd claude-book-reader
npm install          # TypeScript for npm run typecheck; @napi-rs/canvas (optional) for figures
claude --plugin-dir .  # loads the mod; also writes the API types to .claude-plugin/types/
```

Claude Code reloads the mod (`hooks/`) when you save. After changing anything
in `server/`, run `/book restart` in that session. The mod and its tests are
described under [Development](README.md#development) in the README.

## Test and validate

```bash
npm test                  # node --test "test/*.test.mjs" and claude plugin test .
claude plugin validate .  # the manifest and the mod, as Claude Code loads them
npm run typecheck         # the mod, with TypeScript (needs .claude-plugin/types/, see above)
```

All three must pass before a pull request is merged. CI runs `node --test` on
macOS, Linux and Windows (Node 22 and 24, and 22.13 on Linux), and
`claude plugin validate .` and `claude plugin test .` on the same three. It
cannot run `npm run typecheck`: the API types come only from a Claude Code
session that loads the mod, so run it yourself. Add a test with each fix or
feature: server code in
`test/*.test.mjs` (`node --test`), the mod in `hooks/*.test.ts(x)`
(`claude plugin test .`, with the stand-in machine in `hooks/test-world.ts`).

## Code style

Match the code around your change: its naming, its comments (short, saying
why), its formatting (no semicolons, single quotes, two-space indent) and its
plain wording in anything a reader sees. There is no linter or formatter to
run. Keep the server free of required dependencies; `@napi-rs/canvas` stays
optional.

## Changelog

Add a line for any change a user would notice to the top section of
[CHANGELOG.md](CHANGELOG.md).

## Security issues

Do not open a public issue for a security problem: see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), like the rest of the project.
