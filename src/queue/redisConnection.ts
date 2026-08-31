import IORedis from "ioredis";

// BullMQ requires maxRetriesPerRequest: null on connections used for
// blocking operations (Worker, QueueEvents).
export function createRedisConnection(url: string): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}
