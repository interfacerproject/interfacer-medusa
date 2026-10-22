// Medusa 2.10.3 migration generation still reads Dirent.path (removed in Node 24).
// Opt-in only when generating migrations; no dependency files are modified.
const { Dirent } = require('node:fs')
if (!Object.getOwnPropertyDescriptor(Dirent.prototype, 'path')) {
  Object.defineProperty(Dirent.prototype, 'path', { get() { return this.parentPath } })
}
