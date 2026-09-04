import { test as base, expect } from '@playwright/test'
import { createOpenPhotoTestClient } from './client.mjs'

export function withOpenPhoto(options = {}) {
  return {
    test: base.extend({
      client: async ({}, use) => {
        const client = await createOpenPhotoTestClient(options)
        try {
          await use(client)
        } finally {
          await client.close()
        }
      }
    }),
    expect
  }
}
