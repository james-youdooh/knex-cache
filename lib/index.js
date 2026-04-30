"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachCache = attachCache;
const knex_1 = __importDefault(require("knex"));
function createCacheStore(maxSize = 500) {
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
function attachCache(maxSize = 500) {
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
            if (firstKey !== undefined)
                store.cache.delete(firstKey);
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
    function setCache(options) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const cacheKey = (_a = options === null || options === void 0 ? void 0 : options.key) !== null && _a !== void 0 ? _a : this.toString();
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
            if (inflight)
                return inflight;
            const promise = (() => __awaiter(this, void 0, void 0, function* () {
                try {
                    const data = yield this;
                    evictExpired();
                    evictOldestIfFull();
                    store.cache.set(cacheKey, {
                        data,
                        expiresAt: (options === null || options === void 0 ? void 0 : options.ttl) ? now + options.ttl * 1000 : null,
                    });
                    return data;
                }
                finally {
                    store.inflight.delete(cacheKey);
                }
            }))();
            store.inflight.set(cacheKey, promise);
            return promise;
        });
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
    function invalidateCache(options) {
        var _a;
        const cacheKey = (_a = options === null || options === void 0 ? void 0 : options.key) !== null && _a !== void 0 ? _a : this.toString();
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
    function clearCache() {
        store.cache.clear();
        store.inflight.clear();
        return this;
    }
    knex_1.default.QueryBuilder.extend("cache", setCache);
    knex_1.default.QueryBuilder.extend("invalidate", invalidateCache);
    knex_1.default.QueryBuilder.extend("clearCache", clearCache);
}
