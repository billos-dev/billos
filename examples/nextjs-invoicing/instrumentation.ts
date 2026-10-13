// Runs once when the server starts (next dev, next start), before it takes a request.
export async function register() {
  // The check exits the process, which only the Node.js runtime can do, so it is loaded there.
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./instrumentation-node')
}
