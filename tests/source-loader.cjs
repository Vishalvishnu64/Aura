const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { transformSync } = require('esbuild')

// Use the existing build tool to load the app's ESM source under Node. Only
// Electron's OS boundary is substituted; filesystem and SQLite remain real.
module.exports = function loadSource(relative, mocks = {}) {
  const filename = path.resolve(__dirname, '..', relative)
  const code = transformSync(fs.readFileSync(filename, 'utf8'), {
    format: 'cjs', platform: 'node', loader: filename.endsWith('.jsx') ? 'jsx' : 'js',
    jsx: 'automatic', sourcefile: filename
  }).code
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  const original = loaded.require.bind(loaded)
  loaded.require = (name) => Object.hasOwn(mocks, name) ? mocks[name] : original(name)
  loaded._compile(code, filename)
  return loaded.exports
}
