# examples

Deliberately broken and deliberately clean fixtures used to test the guard. Both
are safe: nothing here is loaded unless you copy it into a profile yourself.

## `patch-layer-clean.yml`

The empty profile patch layer (`[]` plus DSH's own comment header). Copy it over
`<profile>\cordis.patch.yml` to get back to a clean state:

```sh
cp examples/patch-layer-clean.yml "$DSH_HOME/profiles/web/cordis.patch.yml"
```

## `patch-layer-broken-row.yml`

A user patch layer that inserts a loader row for a package that does not exist.
Starting DSH with this in place fails **before anything is written to disk**,
which is the class the guard's static audit is meant to name
(`row-package-missing`):

```sh
cp examples/patch-layer-broken-row.yml "$DSH_HOME/profiles/web/cordis.patch.yml"
dsh-plugin-guard bootcheck --profile web   # -> × [row-package-missing] ... exit 1
cp examples/patch-layer-clean.yml "$DSH_HOME/profiles/web/cordis.patch.yml"
```

## `bad-import-fixture/`

A tiny package whose entry imports a file that does not exist, mounted through
its own `dsh.bundle.patch`. It is the opposite test case: **every declaration
looks fine**, so the static audit passes, and the failure only shows up in the
loader — after the profile's include root has already been rewritten. That is
what the crash watchdog's start-attempt signal exists for.

```sh
dsh plugin --profile web add "link:$PWD/examples/bad-import-fixture"
dsh web                       # -> Cannot find module .../lib/not-here.js
dsh plugin --profile web remove dsh-bad-import-fixture
```

Note for Windows: `dsh plugin add` accepts `link:<absolute path>`; quoting the
path avoids trouble with spaces.

## Expected results

| Fixture | Static audit (`bootcheck`) | Loader / start |
|---|---|---|
| `patch-layer-broken-row.yml` | `× row-package-missing` (blocker) | fails inside `loadProfile`, writes nothing |
| `bad-import-fixture` | passes (nothing to see) | fails while applying loader entries, after `cordis.yml` is rewritten |
