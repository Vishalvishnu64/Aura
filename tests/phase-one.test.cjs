const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const loadSource = require('./source-loader.cjs')

// Fixtures deliberately live under tests, not AppData or the user's actual
// folders. Each test cleans up only the unique directory it just created.
function fixture(t, extraMocks = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, 'fixtures-'))
  const data = path.join(root, 'user-data')
  const documents = path.join(root, 'Documents')
  fs.mkdirSync(data)
  fs.mkdirSync(documents)
  const calls = []
  const electron = {
    app: { getPath: (key) => { assert.equal(key, 'userData'); return data } },
    shell: {
      openPath: async (file) => { calls.push(['open', file]); return '' },
      showItemInFolder: (file) => calls.push(['reveal', file])
    },
    clipboard: { writeText: (text) => calls.push(['copy', text]) }
  }
  let tasks
  t.after(() => {
    tasks?.stopTasksService()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const loadFiles = () => loadSource('src/main/fileService.js', { electron, ...extraMocks })
  const files = loadFiles()
  files.initFileService()
  return {
    root, data, documents, files, calls, loadFiles,
    loadTasks() {
      tasks?.stopTasksService()
      tasks = loadSource('src/main/tasksService.js', { electron })
      tasks.initTasksService()
      return tasks
    },
    write(relative, content = 'fixture only') {
      const file = path.join(root, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
      return file
    }
  }
}

test('tasks: create, edit, complete and read back after closing/reopening SQLite', (t) => {
  const f = fixture(t)
  let tasks = f.loadTasks()
  const a = tasks.createTask('  Check   the file finder  ')
  const b = tasks.createTask('Keep this task active')
  assert.equal(a.title, 'Check the file finder')
  const completed = tasks.updateTask(a.id, { title: 'Edited task', completed: true })
  assert.equal(completed.completed, true)
  assert.ok(completed.completedAt >= a.createdAt)
  tasks = f.loadTasks()
  assert.deepEqual(tasks.listTasks().map((item) => item.id), [b.id, a.id])
  assert.deepEqual(tasks.listTasks()[1], completed)
  assert.equal(tasks.updateTask(a.id, { completed: false }).completedAt, null)
  assert.ok(fs.existsSync(path.join(f.data, 'tasks.db')))
  assert.equal(fs.existsSync(path.join(f.data, 'photographic-memory.db')), false)
})

test('tasks: deletion and clearing completed never remove active tasks', (t) => {
  const tasks = fixture(t).loadTasks()
  const a = tasks.createTask('Active')
  const b = tasks.createTask('Finished')
  tasks.updateTask(b.id, { completed: true })
  assert.equal(tasks.clearCompletedTasks(), 1)
  assert.deepEqual(tasks.listTasks().map((item) => item.id), [a.id])
  assert.equal(tasks.clearCompletedTasks(), 0)
  assert.equal(tasks.deleteTask(a.id), true)
  assert.equal(tasks.deleteTask(a.id), false)
  assert.equal(tasks.updateTask(a.id, { title: 'Gone' }), null)
  assert.ok(tasks.createTask('New').id > b.id)
})

test('tasks: invalid IPC input leaves persisted records unchanged', (t) => {
  const tasks = fixture(t).loadTasks()
  const task = tasks.createTask('Original')
  for (const bad of ['', ' \n ', null, {}, 'x'.repeat(501)]) assert.throws(() => tasks.createTask(bad))
  for (const bad of [0, -1, NaN, 1.5, '1', true]) assert.throws(() => tasks.deleteTask(bad))
  for (const patch of [null, [], { completed: 'false' }, { id: 8 }, { title: '' }]) {
    assert.throws(() => tasks.updateTask(task.id, patch))
  }
  assert.deepEqual(tasks.listTasks(), [task])
  tasks.stopTasksService()
  assert.throws(() => tasks.listTasks(), /unavailable/)
})

test('files: start with no access; persist two roots and revocation across restart', async (t) => {
  const f = fixture(t)
  const file = f.write('Documents/resume.txt')
  const second = path.join(f.root, 'Projects')
  fs.mkdirSync(second)
  assert.deepEqual((await f.files.searchFiles('resume')).results, [])
  await f.files.addAuthorizedFolder(f.documents)
  await f.files.addAuthorizedFolder(second)
  await f.files.addAuthorizedFolder(f.documents)
  let files = f.loadFiles()
  files.initFileService()
  assert.equal(files.getAuthorizedFolders().length, 2)
  assert.equal((await files.searchFiles('RESUME')).results[0].path, file)
  files.removeAuthorizedFolder(f.documents)
  files = f.loadFiles()
  files.initFileService()
  assert.deepEqual(files.getAuthorizedFolders().map((item) => item.path), [second])
  assert.deepEqual((await files.searchFiles('resume')).results, [])
  await assert.rejects(files.openFile(file), /outside/)
  assert.ok(fs.existsSync(file), 'revocation must not delete the file')
})

test('files: filename/path search excludes hidden, credential, system and dependency files', async (t) => {
  const f = fixture(t)
  const good = f.write('Documents/Invoices/receipt.txt', 'SearchContentOnlyToken')
  for (const relative of ['.env', '.git/receipt.txt', 'node_modules/receipt.txt', 'AppData/receipt.txt', 'private.key', 'credentials.json']) {
    f.write(`Documents/${relative}`)
  }
  await f.files.addAuthorizedFolder(f.documents)
  const matches = (await f.files.searchFiles('Invoices txt')).results
  assert.equal(matches.length, 1)
  assert.equal(matches[0].path, good)
  assert.equal(matches[0].extension, 'TXT')
  assert.equal(matches[0].canOpen, true)
  assert.ok(matches[0].size > 0 && matches[0].modifiedAt > 0)
  assert.equal((await f.files.searchFiles('SearchContentOnlyToken')).results.length, 0)
  assert.equal((await f.files.searchFiles('Documents')).results.length, 1)
  await assert.rejects(f.files.copyFilePath(path.join(f.documents, 'private.key')), /excluded|outside/)
})

test('files: successful OS handoff uses the validated path; dangerous/out-of-scope paths never reach shell', async (t) => {
  const f = fixture(t)
  const document = f.write('Documents/readme.txt')
  const script = f.write('Documents/run.cmd')
  const sibling = f.write('Documents-Private/readme.txt')
  await f.files.addAuthorizedFolder(f.documents)
  assert.equal(await f.files.openFile(document), true)
  assert.equal(await f.files.revealFile(document), true)
  assert.equal(await f.files.copyFilePath(document), document)
  assert.deepEqual(f.calls, [['open', document], ['reveal', document], ['copy', document]])
  for (const invalid of [sibling, `${f.documents}${path.sep}..${path.sep}Documents-Private${path.sep}readme.txt`, 'readme.txt', 'https://example.com']) {
    await assert.rejects(f.files.openFile(invalid))
    await assert.rejects(f.files.revealFile(invalid))
    await assert.rejects(f.files.copyFilePath(invalid))
  }
  await assert.rejects(f.files.openFile(script), /only opens documents/)
  assert.equal((await f.files.searchFiles('run.cmd')).results[0].canOpen, false)
  fs.unlinkSync(document)
  await assert.rejects(f.files.openFile(document))
  assert.equal(f.calls.length, 3)
})

test('local commands: /find stays local and /todo uses only the task bridge', async () => {
  const { executeLocalCommand } = loadSource('src/renderer/src/services/localCommands.js')
  assert.deepEqual(await executeLocalCommand('/find quarterly report', {}), {
    type: 'files', query: 'quarterly report'
  })
  const created = await executeLocalCommand('/todo Review the local search', {
    tasksCreate: async (title) => ({ id: 9, title })
  })
  assert.deepEqual(created, { type: 'tasks', task: { id: 9, title: 'Review the local search' } })
  await assert.rejects(executeLocalCommand('/find', {}), /Usage: \/find/)
  await assert.rejects(executeLocalCommand('/todo', {}), /Usage: \/todo/)
  await assert.rejects(executeLocalCommand('/todo private', {}), /unavailable/)
})
