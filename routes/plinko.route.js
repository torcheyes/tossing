const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const _ = require('lodash')


const { db } = require("../handler")
const { authJwt } = require('../middlewares/authJwt')
const payoutValues = require('../storage/plinkoPayouts.json')
const chancesValues = require('../storage/plinkoChances.json')
const dropCords = require('../storage/plinkoDropCords.json')


const User = db.user
const Game = db.game


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
  
/*const generatePlinkoEndPos = (serverSeed, clientSeed, nonce, percentages) => {
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
}*/

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

const handleNextInit = (userId) => {
    if( spamCache.queue[String(userId)] !== undefined && spamCache.queue[String(userId)].length ) {
        const nextInit = spamCache.queue[String(userId)].pop()
        nextInit()
    } else {
        delete spamCache.queue[String(userId)]
    }
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

            const botUserPromise = User.findOne({ casinoBot: true, balance: { $gte: Number(betAmount) } }).select('balance').lean()
            const updatedUserPromise = User.findOneAndUpdate(
                { userId: String(userData.id), balance: { $gte: Number(betAmount) } },
                { $inc: { balance: -Number(betAmount) } },
                { new: true }
            ).select('balance').lean()
            
            const [botUser, user] = await Promise.all([botUserPromise, updatedUserPromise])

            if (!user) {
                handleNextInit(userData.id)
                return res.status(400).json({ error: 'Insufficient balance' })
            }
            if( !botUser ) {
                handleNextInit(userData.id)
                return res.status(400).json({ error: 'Insufficient house balance' })
            }
            
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

            let endPos = generateEndPosFromPath(path)
            if( endPos === 0 ) endPos = 5
            else if( endPos === 16 ) endPos = 11
        
            const dropIndex = dropCords[endPos+1][Math.floor(Math.random() * dropCords[endPos+1].length)]
            const multiplier = payoutValues?.[risk]?.[rows]?.[endPos]
        
            if (multiplier === undefined) {
                return res.status(400).json({ error: 'Something went wrong' })
            }

            const gameId = generateRandomId(32)
            const gameRes = new Game({
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
            
            res.status(200).json({
                dropIndex: dropIndex,
                gameInfo: {
                    _id: gameRes._id,
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
            await gameRes.save()
        
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

            await db['activeSeed'].updateOne({ _id: activeSeed._id }, { nonce: activeSeed.nonce })
        
            await handleGameEnd({multiplayer: multiplier}, String(userData.id), Number(betAmount))
        }


        if( spamCache.queue[userData.id] === undefined ) {
            spamCache.queue[userData.id] = []
            initGame()
        } else {
            if( spamCache.queue[userData.id].length > 10 ) return res.status(400).json({ error: 'Too many requests' })
            spamCache.queue[userData.id].push(initGame)
        }
        
    } catch (error) {
        res.status(400).json({error: 'Internal server error.'})
        console.log('Error:', error.message)
    }
})

const handleGameEnd = async ( res, userId, betAmount ) => {
    await db["user"].findOneAndUpdate(
        { userId: String(userId) },
        {
            $inc: {
                balance: Number(betAmount) * res.multiplayer,
                totalWagered: Number(betAmount),
                totalWon: res.multiplayer > 1 ? 1 : 0,
                totalLost: res.multiplayer < 1 ? 1 : 0,
                totalTie: res.multiplayer === 1 ? 1 : 0,
                totalPlayed: 1,
                totalWinAmt: res.multiplayer > 1 ? (res.multiplayer * Number(betAmount)) : 0,
            }
        }
    )

    let botAmount
    if( res.multiplayer === 0 ) botAmount = Number(betAmount)
    else if ( res.multiplayer < 1 ) botAmount = Number(betAmount) - (Number(betAmount) * res.multiplayer)
    else if ( res.multiplayer === 1 ) botAmount = 0
    else botAmount = -(Math.abs(Number(betAmount) - (Number(betAmount) * res.multiplayer)))

    //console.log(`betAmount: ${betAmount}, multiplier: ${res.multiplayer}, remove from housebal: ${botAmount}`)

    await db["user"].findOneAndUpdate(
        { casinoBot: true },
        { $inc: { balance: botAmount } }
    )
}


module.exports = router