/** Deterministic local commands: never send a task title or file query to AI. */
export async function executeLocalCommand(text, bridge) {
  const match = text.trim().match(/^\/(find|todo)(?:\s+([\s\S]*))?$/i)
  if (!match) return null
  const command = match[1].toLowerCase()
  const argument = (match[2] ?? '').trim()
  if (!argument) throw new Error(command === 'find' ? 'Usage: /find <file name>' : 'Usage: /todo <task>')
  if (command === 'find') {
    if (argument.length > 200) throw new Error('Use a file query of 200 characters or fewer.')
    return { type: 'files', query: argument }
  }
  if (argument.length > 500) throw new Error('Task title must be 500 characters or fewer.')
  if (typeof bridge?.tasksCreate !== 'function') throw new Error('Tasks are unavailable. Restart Aura and try again.')
  const task = await bridge.tasksCreate(argument)
  if (!Number.isSafeInteger(task?.id) || task.id < 1) throw new Error('Task storage did not return the new task')
  return { type: 'tasks', task }
}
