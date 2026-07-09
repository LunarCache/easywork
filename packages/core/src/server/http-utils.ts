import type { FastifyRequest } from "fastify";

export type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };
