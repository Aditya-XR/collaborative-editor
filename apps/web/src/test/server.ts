import { setupServer } from 'msw/node'

/** Intercepts fetch at the network layer; each test registers the endpoints it expects. */
export const server = setupServer()
