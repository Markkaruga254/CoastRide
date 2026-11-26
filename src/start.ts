import { listen } from './http/server.js'

// Explicit executable entry point for containers and local development.
try {
  await listen()
} catch (error) {
  console.error('CoastRide API failed to start', error)
  process.exitCode = 1
}
