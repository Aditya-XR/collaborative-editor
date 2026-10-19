import { createContext } from 'react'
import type { Credentials, Registration } from './api'
import type { User } from './session'

export interface AuthValue {
  user: User | null
  /** 'loading' until the first silent refresh has said whether a session exists. */
  status: 'loading' | 'ready'
  signIn(credentials: Credentials): Promise<void>
  signUp(registration: Registration): Promise<void>
  signOut(): Promise<void>
  signOutEverywhere(): Promise<void>
  /** Shows a change the server made to the signed-in person (a verified address). */
  updateUser(user: User): void
}

export const AuthContext = createContext<AuthValue | null>(null)
