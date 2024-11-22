const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const minesWinRates = require('../storage/minesWinRate.json')
const rateLimit = require('express-rate-limit')


const { db } = require("../handler")
const { authJwt } = require('../middlewares/authJwt')
const { handleWinReport } = require('../helpers')

const User = db.user
const Game = db.game

/*function createMinesweeperArray(minesCount) {
    let array = Array(25).fill(0)
    
    for (let i = 0; i < minesCount; i++) {
        let randomIndex = Math.floor(Math.random() * 25)
        while (array[randomIndex] !== 0) {
            randomIndex = Math.floor(Math.random() * 25)
        }
        array[randomIndex] = 1
    }
    
    return array
}*/


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

const createMinesweeperArray = (minesCount, serverSeed, clientSeed, nonce) => {
    const gameSeed = `${serverSeed}${clientSeed}${nonce}`
    const gameHash = crypto.createHash('sha512').update(gameSeed).digest('hex')
    
    let array = Array(25).fill(0)
    let availableSpots = Array.from({ length: 25 }, (_, i) => i)

    let placedMines = 0
    for (let i = 0; i < gameHash.length && placedMines < minesCount; i += 3) {
        const randomIndex = parseInt(gameHash.substring(i, i + 3), 16) % availableSpots.length
        const chosenSpot = availableSpots[randomIndex]
        
        array[chosenSpot] = 1
        availableSpots.splice(randomIndex, 1)
        placedMines++
    }
    
    return { array, gameHash }
}

const spamLimiter = rateLimit({
    store: new rateLimit.MemoryStore(),
    max: 1,
    windowMs: 500,
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

const moveLimiter = rateLimit({
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

const spamCache = {
    bet: {},
    cashout: {},
    move: {}
}

router.post('/active-bet', authJwt, spamLimiter, async (req, res) => {
    try {
        const userData = req.userData

        const foundGame = await Game.findOne({game: 'mines', ownerId: String(userData.id), active: true}).select('id amount multiplayer gameData').lean()
        if(!foundGame) return res.status(200).json({
            activeCasinoBet: null
        })

        res.status(200).json({
            activeCasinoBet: {
                active: true,
                id: foundGame.id,
                amount: Number(foundGame.amount),
                multiplayer: foundGame.multiplayer,
                game: 'mines',
                ownerId: String(userData.id),
                gameData: {
                    mines: null,
                    minesCount: foundGame.gameData.minesCount,
                    rounds: foundGame.gameData.rounds
                }
            }
        })
    } catch ( err ) {
        console.error( err )
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/create-bet', authJwt, spamLimiter, async (req, res) => {
    try {
        const userData = req.userData

        if( spamCache.bet[userData.id] === true ) return res.status(400).json({ error: 'stop spam' })
        spamCache.bet[userData.id] = true

        const foundGame = await Game.findOne({game: 'mines', ownerId: String(userData.id), active: true})
        if(foundGame) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'already playing' })
        }


        const { betAmount, minesCount } = req.body

        if (!betAmount || isNaN(betAmount) || Number(betAmount) < 0.25) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'Minimum wager is 0.25$' })
        }
        if ( Number(betAmount) > 10) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'Maximum wager is 10$' })
        }
        if( isNaN(minesCount) || minesCount > 24 || minesCount < 1 ) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'Invalid request data' })
        }
    
        const user = await User.findOne({userId: String(userData.id)}).select('balance').lean()
        if (!user) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'Unauthorized access' })
        }
        if (Number(betAmount) > user.balance) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'Insufficient balance' })
        }
    
        const botUser = await User.findOne({casinoBot: true}).select('balance').lean()
        if(!botUser) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'Bot user not found' })
        }
        if( Number(betAmount) > botUser.balance ) {
            delete spamCache.bet[userData.id]
            return res.status(400).json({ error: 'Insufficient house balance' })
        }

        await User.findOneAndUpdate({userId: String(userData.id)}, { $inc: { balance: -Number(betAmount) } })

        let foundSeedDoc = await db['activeSeed'].findOne({ userId: String(userData.id) }).lean()
        if (!foundSeedDoc) {
            const newClientSeed = crypto.randomBytes(16).toString('hex')
            const newServerSeed = generateServerSeed()
            const newNextServerSeed = generateServerSeed()
    
            foundSeedDoc = await db['activeSeed'].create({
                game: 'mines',
                userId: String(userData.id),
                clientSeed: newClientSeed,
                serverSeed: newServerSeed.seed,
                serverSeedHashed: newServerSeed.seedHash,
                nextServerSeed: newNextServerSeed.seed,
                nextServerSeedHashed: newNextServerSeed.seedHash,
                nonce: 0
            })
        }
        foundSeedDoc.nonce += 1

        await db['activeSeed'].updateOne({ _id: foundSeedDoc._id }, { nonce: foundSeedDoc.nonce })

        const minesMap = createMinesweeperArray(minesCount, foundSeedDoc.serverSeed, foundSeedDoc.clientSeed, foundSeedDoc.nonce).array        

        const gameId = generateRandomId(32)
        await Game.create({
            active: true,
            id: gameId,
            amount: Number(betAmount),
            game: 'mines',
            ownerId: String(userData.id),
            gameData: {
                mines: null,
                minesCount,
                rounds: [],
                minesMap,
                clientSeed: foundSeedDoc.clientSeed,
                serverSeedHashed: foundSeedDoc.serverSeedHashed,
                nonce: foundSeedDoc.nonce
            }
        })

        delete spamCache.bet[userData.id]

        res.status(200).json({
            active: true,
            id: gameId,
            amount: Number(betAmount),
            game: 'mines',
            ownerId: String(userData.id),
            gameData: {
                mines: null,
                minesCount,
                rounds: []
            }
        })
    } catch ( err ) {
        delete spamCache.bet[userData.id]
        console.error( err )
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/next-move', authJwt, moveLimiter, async (req, res) => {
    try {
        const userData = req.userData

        if( spamCache.move[userData.id] === true ) return res.status(400).json({ error: 'stop spam' })
        spamCache.move[userData.id] = true

        setTimeout( () => {
            delete spamCache.move[userData.id]
        }, 300 )

        const foundGame = await Game.findOne({game: 'mines', ownerId: String(userData.id), active: true}).select('id amount gameData').lean()
        if(!foundGame) return res.status(400).json({ error: 'Game not found' })

        const { fields } = req.body

        if( fields.length > (25 - foundGame.gameData.minesCount) ) return res.status(400).json({ error: 'Too many fields' })

        const gameMinesMap = foundGame.gameData.minesMap

        let foundMine = false
        let newFields = []
        for (const [i, field] of fields.entries()) {
            let fieldAlreadyAdded = foundGame.gameData.rounds.find(r => r.field === field)
            if (fieldAlreadyAdded) continue

            if (gameMinesMap[field] === 0) {
                const playedRounds = foundGame.gameData.rounds.length + (i + 1)
                const currentPayout = minesWinRates[foundGame.gameData.minesCount][playedRounds]
                const newField = {
                    field,
                    payoutMultiplier: currentPayout
                }
                newFields.push(newField)

                if( 25 - foundGame.gameData.minesCount === playedRounds ) break
            } else {
                const newField = {
                    field,
                    payoutMultiplier: 0
                }
                newFields.push(newField)
                foundMine = true
            }
        }

        let minesPoses = []
        gameMinesMap.forEach( (p, i) => {
            if( p === 1 ) minesPoses.push(i)
        } )

        if( foundMine ) {
            await Game.updateOne( { _id: foundGame._id }, {
                    $push: {
                        'gameData.rounds': {
                            $each: newFields
                        }
                    },
                    $set: {
                        'gameData.mines': minesPoses,
                        multiplayer: 0,
                        active: false
                    },
                    $unset: {
                        'gameData.minesMap': 1
                    }
                }
            )

            await db["user"].updateOne({ userId: String(userData.id) }, {
                $inc: {
                    totalWagered: Number(foundGame.amount),
                    totalLost: 1,
                    totalPlayed: 1
                }
            })

            await User.updateOne({ casinoBot: true }, { $inc: { balance: foundGame.amount } })
            
            return res.status(200).json({
                active: false,
                _id: foundGame._id,
                id: foundGame.id,
                amount: Number(foundGame.amount),
                game: 'mines',
                ownerId: String(userData.id),
                multiplayer: 0,
                gameData: {
                    mines: minesPoses,
                    minesCount: foundGame.gameData.minesCount,
                    rounds: [...foundGame.gameData.rounds, ...newFields]
                }
            })
        }

        const playedRounds = [...foundGame.gameData.rounds, ...newFields].length
        if( 25 - foundGame.gameData.minesCount === playedRounds ) {
            const fullPayout = minesWinRates[foundGame.gameData.minesCount][playedRounds]
            const wonAmount = Number(foundGame.amount) * fullPayout

            await db["user"].updateOne({ userId: String(userData.id) }, {
                $inc: {
                    totalWagered: Number(foundGame.amount),
                    totalWon: 1,
                    totalPlayed: 1,
                    balance: Number(wonAmount),
                    totalWinAmt: Number(wonAmount)
                }
            })
        
            await Game.updateOne( { _id: foundGame._id }, {
                    $push: {
                        'gameData.rounds': {
                            $each: newFields
                        }
                    },
                    $set: {
                        'gameData.mines': minesPoses,
                        multiplayer: fullPayout,
                        active: false
                    },
                    $unset: {
                        'gameData.minesMap': 1
                    }
                }
            )

            const botAmount = Math.abs(Number(foundGame.amount) - wonAmount)
            await User.updateOne({ casinoBot: true }, { $inc: { balance: -botAmount } })

            handleWinReport(userData, 'mines', foundGame.amount, fullPayout)

            return res.status(200).json({
                active: false,
                _id: foundGame._id,
                id: foundGame.id,
                amount: Number(foundGame.amount),
                game: 'mines',
                ownerId: String(userData.id),
                multiplayer: fullPayout,
                gameData: {
                    mines: minesPoses,
                    minesCount: foundGame.gameData.minesCount,
                    rounds: [...foundGame.gameData.rounds, ...newFields]
                }
            })
        }
        
        await Game.updateOne( { _id: foundGame._id }, {
            $push: {
                'gameData.rounds': {
                    $each: newFields
                }
            }
        })
        
        res.status(200).json({
            active: true,
            _id: foundGame._id,
            id: foundGame.id,
            amount: Number(foundGame.amount),
            game: 'mines',
            ownerId: String(userData.id),
            multiplayer: 0,
            gameData: {
                mines: null,
                minesCount: foundGame.gameData.minesCount,
                rounds: [...foundGame.gameData.rounds, ...newFields]
            }
        })

    } catch ( err ) {
        console.error( err )
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/bet-cashout', authJwt, spamLimiter, async (req, res) => {
    const userData = req.userData

    if( spamCache.cashout[userData.id] === true ) return res.status(400).json({ error: 'stop spam' })
    spamCache.cashout[userData.id] = true

    const foundGame = await Game.findOne({game: 'mines', ownerId: String(userData.id), active: true}).select('id amount gameData').lean()
    if(!foundGame) {
        delete spamCache.cashout[userData.id]
        return res.status(400).json({ error: 'Game not found' })
    }

    const playedRounds = [...foundGame.gameData.rounds].length
    if(playedRounds === 0) {
        delete spamCache.cashout[userData.id]
        return res.status(400).json({ error: 'Cannot cashout now.' })
    }

    const gameMinesMap = foundGame.gameData.minesMap

    let minesPoses = []
    gameMinesMap.forEach( (p, i) => {
        if( p === 1 ) minesPoses.push(i)
    } )

    const fullPayout = minesWinRates[foundGame.gameData.minesCount][playedRounds]
    const wonAmount = Number(foundGame.amount) * fullPayout

    await db["user"].updateOne({ userId: String(userData.id) }, {
        $inc: {
            totalWagered: Number(foundGame.amount),
            totalWon: 1,
            totalPlayed: 1,
            balance: Number(wonAmount),
            totalWinAmt: Number(wonAmount)
        }
    })

    await Game.updateOne( { _id: foundGame._id }, {
            $set: {
                'gameData.mines': minesPoses,
                multiplayer: fullPayout,
                active: false
            },
            $unset: {
                'gameData.minesMap': 1
            }
        }
    )

    handleWinReport(userData, 'mines', foundGame.amount, fullPayout)

    delete spamCache.cashout[userData.id]

    res.status(200).json({
        active: false,
        _id: foundGame._id,
        id: foundGame.id,
        amount: Number(foundGame.amount),
        game: 'mines',
        ownerId: String(userData.id),
        multiplayer: fullPayout,
        gameData: {
            mines: minesPoses,
            minesCount: foundGame.gameData.minesCount,
            rounds: foundGame.gameData.rounds
        }
    })

    const botAmount = Math.abs(Number(foundGame.amount) - wonAmount)
    await User.updateOne({ casinoBot: true }, { $inc: { balance: -botAmount } })
})

module.exports = router