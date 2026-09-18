/** Tiny prefixed logger so host and backend output stay readable in one terminal. */
const started = Date.now()

function stamp() {
  const ms = Date.now() - started
  return `+${(ms / 1000).toFixed(1)}s`.padStart(7)
}

export function createLogger(scope) {
  const prefix = `[${scope}]`
  const write = (level, args) => {
    const line = `${stamp()} ${prefix.padEnd(18)} ${level}`
    if (level === 'ERROR') console.error(line, ...args)
    else console.log(line, ...args)
  }
  return {
    info: (...args) => write('', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
  }
}
