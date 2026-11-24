import { FastifyError, FastifyRequest, FastifyReply } from 'fastify'
import { IllegalTransitionError } from '../modules/trips/stateMachine.js'
import { ConflictError } from '../modules/bookings/service.js'

export function errorHandler(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply
) {
  if (error instanceof IllegalTransitionError || error instanceof ConflictError) {
    return reply.status(409).send({ error: { code: 'CONFLICT', message: error.message } })
  }

  if (error.statusCode === 400) {
    return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: error.message } })
  }

  if (error.statusCode === 404) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: error.message } })
  }

  _request.log.error(error)
  return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
}
