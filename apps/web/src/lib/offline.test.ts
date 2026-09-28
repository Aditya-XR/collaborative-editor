import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forgetOfflineDatabase,
  offlineDatabaseName,
  rememberOfflineDatabase,
  wipeOfflineDatabases,
} from './offline'

function fakeIndexedDB(existing: string[]) {
  const deleted: string[] = []
  vi.stubGlobal('indexedDB', {
    databases: async () => existing.map((name) => ({ name, version: 1 })),
    deleteDatabase: (name: string) => {
      deleted.push(name)
      const request: { onsuccess?: () => void } = {}
      queueMicrotask(() => request.onsuccess?.())
      return request
    },
  })
  return deleted
}

beforeEach(() => localStorage.clear())

describe('offline copies', () => {
  it('names each copy by user and document', () => {
    expect(offlineDatabaseName('u1', 'd1')).toBe('collabedit:u1:d1')
  })

  it('deletes every copy on sign-out, including ones only the registry knows', async () => {
    rememberOfflineDatabase('collabedit:u1:registry-only')
    rememberOfflineDatabase('collabedit:u1:d1')
    const deleted = fakeIndexedDB(['collabedit:u1:d1', 'collabedit:u2:d9', 'some-other-app'])

    await wipeOfflineDatabases()

    expect(deleted.sort()).toEqual([
      'collabedit:u1:d1',
      'collabedit:u1:registry-only',
      'collabedit:u2:d9',
    ])
    expect(localStorage.getItem('collabedit:offline-databases')).toBe('[]')
  })

  it('forgets a copy once its data is cleared', async () => {
    rememberOfflineDatabase('collabedit:u1:d1')
    forgetOfflineDatabase('collabedit:u1:d1')
    const deleted = fakeIndexedDB([])

    await wipeOfflineDatabases()

    expect(deleted).toEqual([])
  })
})
