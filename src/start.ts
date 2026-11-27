import { closeServer, listen } from './http/server.js'

// Explicit executable entry point for containers and local development.
console.info('CoastRide API entry point executing')

const shutdown = async (signal: string) => {
  console.info(`CoastRide API received ${signal}; shutting down`)
  try {
    await closeServer()
  } catch (error) {
    console.error('CoastRide API shutdown failed', error)
    process.exitCode = 1
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

try {
  await listen()
} catch (error) {
  console.error('CoastRide API failed to start', error)
  process.exitCode = 1
}
