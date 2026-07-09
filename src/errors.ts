import type { FastifyInstance, FastifyError, FastifyReply, FastifyRequest } from "fastify";

/** The single error envelope every failure response uses: { error: { code, message } }. */
export function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function formatValidation(err: FastifyError): string {
  if (!err.validation || err.validation.length === 0) return err.message;
  return err.validation
    .map((v) => {
      const where = v.instancePath && v.instancePath.length > 0 ? v.instancePath.replace(/^\//, "") : (v.params as { missingProperty?: string })?.missingProperty ?? "body";
      return `${where} ${v.message}`;
    })
    .join("; ");
}

/**
 * Maps framework and unexpected errors onto our documented error envelope.
 * Business rejections (insufficient funds, already-claimed, key reuse) are NOT
 * thrown — they are returned as normal results — so they never reach here.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    // Schema validation failure at the boundary (bad body/param/header shape).
    if (err.validation) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", formatValidation(err)));
    }

    const statusCode = err.statusCode ?? 500;

    // Malformed / empty JSON body → Fastify surfaces this as a 400.
    if (statusCode === 400) {
      return reply.code(400).send(errorBody("VALIDATION_ERROR", err.message));
    }
    // Body over the configured bodyLimit.
    if (statusCode === 413) {
      return reply.code(413).send(errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the allowed size."));
    }
    // Wrong / missing Content-Type on a body route.
    if (statusCode === 415) {
      return reply.code(415).send(errorBody("UNSUPPORTED_MEDIA_TYPE", err.message));
    }

    req.log.error({ err }, "unhandled error");
    return reply.code(500).send(errorBody("INTERNAL", "Internal server error."));
  });

  app.setNotFoundHandler((_req: FastifyRequest, reply: FastifyReply) => {
    return reply.code(404).send(errorBody("NOT_FOUND", "No such route."));
  });
}
