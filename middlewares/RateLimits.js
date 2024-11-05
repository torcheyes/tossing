const rateLimit = require('express-rate-limit')

const flatCache = require('flat-cache')
const path = require('path')

const cache = flatCache.load('rate-limit-cache', path.resolve('./storage/rate-limit-cache'))

class FlatCacheStore {
  constructor(options) {
    this.cache = cache
    this.options = options
  }

  init(options) {
    this.windowMs = options.windowMs
  }

  async increment(key) {
    let current = this.cache.getKey(key) || { hits: 0, resetTime: Date.now() + this.options.windowMs }

    if (Date.now() > current.resetTime) {
        current.hits = 0
        current.resetTime = Date.now() + this.options.windowMs
    }

    current.hits += 1
    this.cache.setKey(key, current)
    this.cache.save()

    return {
      totalHits: current.hits,
      resetTime: new Date(current.resetTime),
    }
  }

  async decrement(key) {
    let current = this.cache.getKey(key) || { hits: 0, resetTime: Date.now() + this.options.windowMs }
    if (current.hits > 0) {
      current.hits -= 1
      this.cache.setKey(key, current)
      this.cache.save()
    }
  }

  async resetKey(key) {
    this.cache.removeKey(key)
    this.cache.save()
  }

  async resetAll() {
    this.cache.destroy()
  }
}


const createLimiter = (max, delay, field) => {
    const limiter = rateLimit({
        store: new FlatCacheStore({ windowMs: delay }),
        max: max,
        windowMs: delay,
        handler: (req, res, next) => {
            const timeLeftInSeconds = (new Date(req.rateLimit.resetTime).getTime() - Date.now()) / 1000;

            const hours = Math.floor(timeLeftInSeconds / 3600);
            const minutes = Math.floor((timeLeftInSeconds % 3600) / 60);
            const seconds = Math.floor(timeLeftInSeconds % 60);

            res.status(429).json({
                error: 'This action cannot be performed due to slowmode rate limit.',
                timeLeft: timeLeftInSeconds > 0 ? timeLeftInSeconds : 0,
                [field]: `Rate limit exceeded. Try again after ${hours}h ${minutes}m ${seconds}s`
            });
        },
    })

    return limiter
}

module.exports = {
    createLimiter
}