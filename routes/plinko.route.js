const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const rateLimit = require('express-rate-limit')


const { db } = require("../handler")
const { authJwt } = require('../middlewares/authJwt')
const payoutValues = require('../storage/plinkoPayouts.json')
const chancesValues = require('../storage/plinkoChances.json')
const dropCords = require('../storage/plinkoDropCords.json')


const User = db.user
const Game = db.game


const dropBallLimiter = rateLimit({
    store: new rateLimit.MemoryStore(),
    max: 1,
    windowMs: 300,
    standardHeaders: true, 
    legacyHeaders: false,
    handler: (req, res, next) => {
        const timeLeft = (req.rateLimit.resetTime - Date.now()) / 1000
        res.status(429).json({
            error: 'This action cannot be performed due to slowmode rate limit.',
            timeLeft: timeLeft > 0 ? timeLeft : 0,
        })
    },
    keyGenerator: function(req) {
        return String(req.userData.id)
    }
})

function generateRandomId(length) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length }, () => characters[Math.floor(Math.random() * characters.length)]).join('');
}

function generateServerSeed() {
    const seed = crypto.randomBytes(32).toString('hex');
    const seedHashRaw = crypto.createHash('sha256').update(seed);
    const seedHash = seedHashRaw.digest('hex');
  
    return {
      seed,
      seedHash,
    }
}
  
const generatePlinkoEndPos = (serverSeed, clientSeed, nonce, percentages) => {
    const gameSeed = `${serverSeed}${clientSeed}${nonce}`;
    const gameHash = crypto.createHash('sha512').update(gameSeed).digest('hex');
    const resultNumber = parseInt(gameHash.substring(0, 13), 16);
    const totalWeight = percentages.reduce((sum, percentage) => sum + percentage, 0);
  
    const scaledResult = resultNumber % totalWeight;
  
    let accumulatedWeight = 0;
    let resultIndex = -1;
    for (let i = 0; i < percentages.length; i++) {
        accumulatedWeight += percentages[i];
        if (scaledResult < accumulatedWeight) {
            resultIndex = i;
            break;
        }
    }
  
    return { resultIndex, gameHash };
}

const generateEndPosFromPath = (path) => {
    let currentPos = Math.round(16 / 2) + 1

    path.forEach( dir => {
        if( dir === 'right' ) {
            currentPos += .5
        } else {
            currentPos -= .5
        }
    } )

    const endPos = Math.floor(currentPos) - 1

    return endPos
}

function* byteGenerator({ serverSeed, clientSeed, nonce, cursor }) {
    // Initialize cursor variables
    let currentRound = Math.floor(cursor / 32);
    let currentRoundCursor = cursor % 32;
  
    while (true) {
      // Create HMAC for the current round
      const hmac = crypto.createHmac('sha256', serverSeed);
      hmac.update(`${clientSeed}:${nonce}:${currentRound}`);
      const buffer = hmac.digest();
  
      // Yield bytes from the buffer
      while (currentRoundCursor < 32) {
        yield buffer[currentRoundCursor];
        currentRoundCursor++;
      }
  
      // Move to the next round
      currentRoundCursor = 0;
      currentRound++;
    }
}
const _ = require('lodash')

function generateFloats({ serverSeed, clientSeed, nonce, cursor, count }) {
    const rng = byteGenerator({ serverSeed, clientSeed, nonce, cursor });
    const bytes = [];
  
    // Collect enough bytes
    while (bytes.length < count * 4) {
      bytes.push(rng.next().value);
    }
  
    // Chunk bytes into groups of 4 and convert to floats
    return _.chunk(bytes, 4).map(bytesChunk =>
      bytesChunk.reduce((result, value, i) => {
        const divider = 256 ** (i + 1); // Scale down byte values
        const partialResult = value / divider;
        return result + partialResult;
      }, 0)
    );
}


const spamCache = {
    drop: {},
    queue: {}
}

router.post('/drop-ball', authJwt, async (req, res) => {
    try {
        const userData = req.userData
        const { rows, risk, betAmount } = req.body
    
        if (!betAmount || isNaN(betAmount) || Number(betAmount) < 0.25) return res.status(400).json({ error: 'Minimum wager is 1$' })
        if ( Number(betAmount) > 10) return res.status(400).json({ error: 'Maximum wager is 10$' })
        if (!['low', 'medium', 'high'].includes(risk)) return res.status(400).json({ error: 'Invalid parameters' })
        
        //if (!rows || rows < 8 || rows > 16) return res.status(400).json({ error: 'Invalid parameters' })

        if (!rows || rows !== 16) return res.status(400).json({ error: 'Invalid parameters' })
        
        const initGame = async () => {

            const results = await User.aggregate([
                {
                    $facet: {
                        botUser: [
                            { $match: { casinoBot: true, balance: { $gte: Number(betAmount) } } },
                            { $project: { balance: 1 } }
                        ],
                        updatedUser: [
                            {
                                $match: {
                                    userId: String(userData.id),
                                    balance: { $gte: Number(betAmount) }
                                }
                            },
                            { $set: { balance: { $subtract: ["$balance", Number(betAmount)] } } },
                            { $project: { balance: 1 } }
                        ]
                    }
                }
            ])

            const user = results[0].updatedUser[0]
            const botUser = results[0].botUser[0]

            if (!user) return res.status(400).json({ error: 'Insufficient balance' })
            if( !botUser ) return res.status(400).json({ error: 'Insufficient house balance' })
            
            let activeSeed
            const cacheSeed = globalThis.plinkoCache[`${userData.id}_seed`]
            if( cacheSeed ) {
                activeSeed = cacheSeed
            } else {
                const foundSeedDoc = await db['activeSeed'].findOne({ userId: String(userData.id) })
        
                if (!foundSeedDoc) {
                    const newClientSeed = crypto.randomBytes(16).toString('hex')
                    const newServerSeed = generateServerSeed()
                    const newNextServerSeed = generateServerSeed()
            
                    const activeSeedObj = await db['activeSeed'].create({
                        game: 'plinko',
                        userId: String(userData.id),
                        clientSeed: newClientSeed,
                        serverSeed: newServerSeed.seed,
                        serverSeedHashed: newServerSeed.seedHash,
                        nextServerSeed: newNextServerSeed.seed,
                        nextServerSeedHashed: newNextServerSeed.seedHash,
                        nonce: 0
                    })
            
                    globalThis.plinkoCache[`${userData.id}_seed`] = activeSeedObj
                    activeSeed = activeSeedObj
                } else {
                    globalThis.plinkoCache[`${userData.id}_seed`] = foundSeedDoc
                    activeSeed = foundSeedDoc
                }
            }
            activeSeed.nonce += 1

            if( spamCache.queue[userData.id] !== undefined && spamCache.queue[userData.id].length ) {
                const nextInit = spamCache.queue[userData.id].pop()
                nextInit()
            } else {
                delete spamCache.queue[userData.id]
            }

            const floats = generateFloats({
                serverSeed: activeSeed.serverSeed,
                clientSeed: activeSeed.clientSeed,
                nonce: activeSeed.nonce,
                cursor: 0,
                count: 16, // Generate 5 floats
            })

            const DIRECTIONS = [ 'left', 'right' ]

            const path = []
            floats.forEach( float => {
                const direction = DIRECTIONS[Math.floor(float * 2)]
                path.push(direction)
            } )

            const endPos = generateEndPosFromPath(path)
        
            const dropIndex = dropCords[endPos+1][Math.floor(Math.random() * dropCords[endPos+1].length)]
            const multiplier = payoutValues?.[risk]?.[rows]?.[endPos]
        
            if (multiplier === undefined) {
                return res.status(400).json({ error: 'Something went wrong' });
            }
        
            const losses = betAmount * (1 - multiplier)
            const winnings = betAmount * multiplier;
            const addedAmt = winnings - betAmount;
        
            //user.balance += addedAmt
            //globalThis.plinkoCache[userData.id] = user
        
            const gameId = generateRandomId(32)
            res.status(200).json({
                dropIndex: dropIndex,
                gameInfo: {
                    id: gameId,
                    ownerId: String(userData.id),
                    amount: Number(betAmount),
                    multiplayer: multiplier,
                    game: 'plinko',
                    gameData: {
                        rows: Number(rows),
                        risk,
                        clientSeed: activeSeed.clientSeed,
                        serverSeedHashed: activeSeed.serverSeedHashed,
                        nonce: activeSeed.nonce
                    }
                }
            })
        
            if( globalThis.plinkoCache[`${userData.id}_timeout`] !== undefined ) {
                clearTimeout(globalThis.plinkoCache[`${userData.id}_timeout`])
            }
            const timeoutId = setTimeout( () => {
                if( globalThis.plinkoCache[`${userData.id}_timeout`] !== undefined ) {
                    delete globalThis.plinkoCache[`${userData.id}_timeout`]
                }
                if( globalThis.plinkoCache[`${userData.id}_seed`] !== undefined ) {
                    delete globalThis.plinkoCache[`${userData.id}_seed`]
                }
            }, 30000 )
            globalThis.plinkoCache[`${userData.id}_timeout`] = timeoutId

            await User.updateOne({ userId: String(userData.id) }, {
                $inc: {
                    balance: addedAmt,
                    totalWagered: Number(betAmount),
                    totalPlayed: 1,
                    totalWon: multiplier > 1 ? 1 : 0,
                    totalWinAmt: multiplier > 1 ? addedAmt : 0,
                    totalLost: multiplier < 1 ? 1 : 0,
                    totalTie: multiplier === 1 ? 1 : 0
                }
            })
        
            await db['activeSeed'].updateOne({ _id: activeSeed._id }, { nonce: activeSeed.nonce })
        
            if( multiplier > 1 ) {
                await User.updateOne({ casinoBot: true }, { $inc: { balance: -winnings } })
            } else if( multiplier < 1 ) {
                await User.updateOne({ casinoBot: true }, { $inc: { balance: losses } })
            }
        
            await Game.create({
                active: false,
                id: gameId,
                ownerId: String(userData.id),
                amount: Number(betAmount),
                multiplayer: multiplier,
                game: 'plinko',
                gameData: {
                    rows: Number(rows),
                    risk,
                    clientSeed: activeSeed.clientSeed,
                    serverSeedHashed: activeSeed.serverSeedHashed,
                    nonce: activeSeed.nonce
                }
            })

        }


        if( spamCache.queue[userData.id] === undefined ) {
            spamCache.queue[userData.id] = []
            initGame()
        } else {
            spamCache.queue[userData.id].push(initGame)
        }
        
    } catch (error) {
        res.status(400).json({error: 'Internal server error.'})
        console.log('Error:', error.message)
    }
})


module.exports = router