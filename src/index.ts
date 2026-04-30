import knex, { Knex } from "knex";

interface CacheEntry {
  data: unknown;
  expiresAt: number | null; // null = no expiry
}

interface CacheOptions {
  key?: string;
  ttl?: number; // seconds
}

interface CacheStore {
  cache: Map<string, CacheEntry>;
  inflight: Map<string, Promise<unknown>>;
  maxSize: number;
}

function createCacheStore(maxSize = 500): CacheStore {
  return {
    cache: new Map(),
    inflight: new Map(),
    maxSize,
  };
}

/**
 * Attaches caching methods (`cache`, `invalidate`, `clearCache`) to the Knex
 * QueryBuilder prototype. Call once during application setup, before any
 * queries are made.
 *
 * @param maxSize - Maximum number of entries to hold in the cache before the
 *   oldest entry is evicted. Defaults to `500`.
 *
 * @example
 * import { attachCache } from "knex-cache-plugin";
 * attachCache();
 */
export function attachCache(maxSize = 500) {
  const store = createCacheStore(maxSize);

  function evictExpired() {
    const now = Date.now();
    for (const [key, entry] of store.cache) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        store.cache.delete(key);
      }
    }
  }

  function evictOldestIfFull() {
    if (store.cache.size >= store.maxSize) {
      // Map preserves insertion order — delete the first (oldest) entry
      const firstKey = store.cache.keys().next().value;
      if (firstKey !== undefined) store.cache.delete(firstKey);
    }
  }

  /**
   * Executes the query and caches the result. Subsequent calls with the same
   * cache key return the cached value without hitting the database.
   *
   * Concurrent calls for the same key are deduplicated — only one query is
   * issued and all callers receive the same result.
   *
   * @param options.key - Custom cache key. Defaults to the SQL string of the
   *   query.
   * @param options.ttl - Time-to-live in seconds. Omit for an entry that never
   *   expires.
   *
   * @example
   * const rows = await knex("users").where("active", true).cache({ ttl: 60 });
   */
  async function setCache(
    this: Knex.QueryBuilder,
    options?: CacheOptions,
  ): Promise<any> {
    const cacheKey = options?.key ?? this.toString();
    const now = Date.now();

    // Return valid cached entry
    const existing = store.cache.get(cacheKey);
    if (existing) {
      if (existing.expiresAt === null || existing.expiresAt > now) {
        return existing.data;
      }
      store.cache.delete(cacheKey); // expired — remove it
    }

    // Deduplicate in-flight requests for the same key
    const inflight = store.inflight.get(cacheKey);
    if (inflight) return inflight;

    const promise = (async () => {
      try {
        const data = await this;
        evictExpired();
        evictOldestIfFull();
        store.cache.set(cacheKey, {
          data,
          expiresAt: options?.ttl ? now + options.ttl * 1000 : null,
        });
        return data;
      } finally {
        store.inflight.delete(cacheKey);
      }
    })();

    store.inflight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Removes a single entry from the cache. The query itself is **not**
   * re-executed; chain `.cache()` afterwards if you want a fresh result.
   *
   * @param options.key - Cache key to remove. Defaults to the SQL string of
   *   the query.
   *
   * @example
   * knex("users").where("active", true).invalidate();
   * knex("users").invalidate({ key: "fetchUsers" });
   */
  function invalidateCache(
    this: Knex.QueryBuilder,
    options?: CacheOptions,
  ): Knex.QueryBuilder {
    const cacheKey = options?.key ?? this.toString();
    store.cache.delete(cacheKey);
    return this;
  }

  /**
   * Removes **all** entries from the cache and cancels any tracked in-flight
   * requests. Useful for test teardown or when a bulk write invalidates every
   * cached result.
   *
   * @example
   * knex("users").clearCache();
   */
  function clearCache(this: Knex.QueryBuilder): Knex.QueryBuilder {
    store.cache.clear();
    store.inflight.clear();
    return this;
  }

  knex.QueryBuilder.extend("cache", setCache);
  knex.QueryBuilder.extend("invalidate", invalidateCache);
  knex.QueryBuilder.extend("clearCache", clearCache);
}
