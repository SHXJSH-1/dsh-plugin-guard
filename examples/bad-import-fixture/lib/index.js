// Deliberately missing target: the loader aborts with "Cannot find module".
// Declaration-level checks (dsh.client / dsh.bundle.patch / row targets) all
// look fine, which is the point of this fixture.
import './not-here.js'

export const name = 'dsh-bad-import-fixture'

export function apply() {}
