import { redis, RedisClient } from "@budibase/backend-core"
import { getGlobalIDFromUserMetadataID } from "../db/utils"
import { ContextUser } from "@budibase/types"
import env from "../environment"

const APP_DEV_LOCK_SECONDS = 600
const AUTOMATION_TEST_FLAG_SECONDS = 60
let devAppClient: RedisClient,
  debounceClient: RedisClient,
  flagClient: RedisClient

// We need to maintain a duplicate client for socket.io pub/sub
let socketClient: RedisClient
let socketSubClient: any

// We init this as we want to keep the connection open all the time
// reduces the performance hit
export async function init() {
  ;[devAppClient, debounceClient, flagClient, socketClient] = await Promise.all(
    [
      redis.Client.init(redis.utils.Databases.DEV_LOCKS),
      redis.Client.init(redis.utils.Databases.DEBOUNCE),
      redis.Client.init(redis.utils.Databases.FLAGS),
      redis.clients.getSocketClient(),
    ]
  )

  // Duplicate the socket client for pub/sub
  if (!env.isTest()) {
    socketSubClient = socketClient.client.duplicate()
  }
}

export async function shutdown() {
  console.log("REDIS SHUTDOWN")
  if (devAppClient) await devAppClient.finish()
  if (debounceClient) await debounceClient.finish()
  if (flagClient) await flagClient.finish()
  if (socketSubClient) socketSubClient.disconnect()
  // shutdown core clients
  await redis.clients.shutdown()
  console.log("Redis shutdown")
}

export async function doesUserHaveLock(devAppId: string, user: ContextUser) {
  const value = await devAppClient.get(devAppId)
  if (!value) {
    return true
  }
  // make sure both IDs are global
  const expected = getGlobalIDFromUserMetadataID(value._id)
  const userId = getGlobalIDFromUserMetadataID(user._id!)
  return expected === userId
}

export async function getLocksById(appIds: string[]) {
  return await devAppClient.bulkGet(appIds)
}

export async function updateLock(devAppId: string, user: ContextUser) {
  // make sure always global user ID
  const globalId = getGlobalIDFromUserMetadataID(user._id!)
  const inputUser = {
    ...user,
    userId: globalId,
    _id: globalId,
    lockedAt: new Date().getTime(),
  }

  await devAppClient.store(devAppId, inputUser, APP_DEV_LOCK_SECONDS)
}

export async function clearLock(devAppId: string, user: ContextUser) {
  const value = await devAppClient.get(devAppId)
  if (!value) {
    return
  }
  const userId = getGlobalIDFromUserMetadataID(user._id!)
  if (value._id !== userId) {
    throw "User does not hold lock, cannot clear it."
  }
  await devAppClient.delete(devAppId)
}

export async function checkDebounce(id: string) {
  return debounceClient.get(id)
}

export async function setDebounce(id: string, seconds: number) {
  await debounceClient.store(id, "debouncing", seconds)
}

export async function checkTestFlag(id: string) {
  const flag = await flagClient?.get(id)
  return !!(flag && flag.testing)
}

export async function withTestFlag<R>(id: string, fn: () => Promise<R>) {
  // TODO(samwho): this has a bit of a problem where if 2 automations are tested
  // at the same time, the second one will overwrite the first one's flag. We
  // should instead use an atomic counter and only clear the flag when the
  // counter reaches 0.
  await flagClient.store(id, { testing: true }, AUTOMATION_TEST_FLAG_SECONDS)
  try {
    return await fn()
  } finally {
    await devAppClient.delete(id)
  }
}

export function getSocketPubSubClients() {
  return {
    pub: socketClient.client,
    sub: socketSubClient,
  }
}
