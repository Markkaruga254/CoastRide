import { FastifyError, FastifyRequest, FastifyReply } from 'fastify'
import { IllegalTransitionError } from '../modules/trips/stateMachine.js'
import { ConflictError } from '../modules/bookings/service.js'

const isFastifyError = (e: unknown): e is FastifyError & { statusCode: number } => {
  return typeof e === 'object' && e !== null && 'statusCode' in e && typeof (e as Record<string, unknown>).statusCode === 'number'
}

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const { statusCode = 500 } = error
  const logMeta = { reqId: request.id, path: request.url, method: request.method }

  // Check for specific error types first
  if (error instanceof IllegalTransitionError || error instanceof ConflictError) {
    return reply.status(409).send({ error: { code: 'CONFLICT', message: error.message } })
  }

  if (statusCode >= 500) {
    request.log.error({ err: error, ...logMeta }, 'server error')
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
  }

  if (statusCode >= 400) {
    request.log.warn({ ...logMeta, message: error.message }, 'client error')
    if (isFastifyError(error) && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        error: { code: error.code || 'CLIENT_ERROR', message: error.message },
      })
    }
  }

  if (statusCode === 400) {
    return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: error.message } })
  }

  if (statusCode === 404) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: error.message } })
  }

  request.log.error({ err: error, ...logMeta }, 'unhandled error')
  return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
}