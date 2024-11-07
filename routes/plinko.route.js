const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const rateLimit = require('express-rate-limit')


const { db } = require("../handler")
const { authJwt } = require('../middlewares/authJwt')
const payoutValues = require('../storage/plinkoPayouts.json')
const chancesValues = require('../storage/plinkoChances.json')


const User = db.user
const Game = db.game


const dropBallLimiter = rateLimit({
    store: new rateLimit.MemoryStore(),
    max: 1,
    windowMs: 300,
    handler: (req, res, next) => {
        const timeLeft = (req.rateLimit.resetTime - Date.now()) / 1000
        res.status(429).json({
            error: 'This action cannot be performed due to slowmode rate limit.',
            timeLeft: timeLeft > 0 ? timeLeft : 0,
        })
    },
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

const generatePlinkoDir = (serverSeed, clientSeed, index, nonce) => {
    const gameSeed = `${serverSeed}${clientSeed}${index}${nonce}`
    const gameHash = crypto.createHash('sha512').update(gameSeed).digest('hex')
    const resultNumber = parseInt(gameHash.substring(0, 13), 16)
    const result = resultNumber % 2 === 0 ? 'R' : 'L'
    return { result, gameHash }
}
  
const generatePlinkoStartPos = (serverSeed, clientSeed, nonce) => {
    const gameSeed = `${serverSeed}${clientSeed}${nonce}`
    const gameHash = crypto.createHash('sha512').update(gameSeed).digest('hex')
    const resultNumber = parseInt(gameHash.substring(0, 13), 16)
    const result = resultNumber % 3
    return { result, gameHash }
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
  
const generatePlinkoPath = (serverSeed, clientSeed, nonce, rows, percentages) => {
        const { resultIndex } = generatePlinkoEndPos(serverSeed, clientSeed, nonce, percentages);
        const { result: startPos } = generatePlinkoStartPos(serverSeed, clientSeed, nonce);
        
        const path = []
        let currentPos = Math.round(rows / 2) + startPos
    
        for (let i = 0; i < rows; i++) {
        if (Math.floor(currentPos) - 1 < resultIndex) {
            path.push('R');
            currentPos += .5
        } else if (Math.floor(currentPos) - 1 > resultIndex) {
            path.push('L');
            currentPos -= .5
        } else {
            const randomMove = generatePlinkoDir(serverSeed, clientSeed, i, nonce).result
            path.push(randomMove)
            if( randomMove === 'R' ) currentPos += .5
            else currentPos -= .5
        }
    }
  
    return { startPos, path, finalPos: Math.floor(currentPos) - 1 }
}

router.post('/drop-ball', authJwt, dropBallLimiter, async (req, res) => {
    let resSent
    try {
        const userData = req.userData;
        const { rows, risk, betAmount } = req.body;
    
        if (!betAmount || Number(betAmount) < 0.25) return res.status(400).json({ error: 'Minimum wager is 1$' });
        if ( Number(betAmount) > 10) return res.status(400).json({ error: 'Maximum wager is 10$' });
        if (!['low', 'medium', 'high'].includes(risk)) return res.status(400).json({ error: 'Invalid parameters' });
        if (!rows || rows < 8 || rows > 16) return res.status(400).json({ error: 'Invalid parameters' });
    
        const balances = await User.find({ 
            $or: [
                {casinoBot: true},
                {userId: String(userData.id)}
            ]
        }).select('balance').lean()
    
        //let user = /*globalThis.plinkoCache[userData.id] ||*/ await User.findOne({ userId: String(userData.id) }).select('balance').lean();
        const user = balances[1]
        const botUser = balances[0]
        if (!user) return res.status(400).json({ error: 'Unauthorized access' });
        if (Number(betAmount) > user.balance) return res.status(400).json({ error: 'Insufficient balance' });
    
        //const botUser = await User.findOne({ casinoBot: true }).select('balance').lean();
        if(!botUser) return res.status(400).json({ error: 'Bot user not found' });
        if( Number(betAmount) > botUser.balance ) return res.status(400).json({ error: 'Insufficient house balance' });
    
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
    
        const percentages = chancesValues[risk][rows];
        const endPos = generatePlinkoPath(activeSeed.serverSeed, activeSeed.clientSeed, activeSeed.nonce, rows, percentages);
        const multiplier = payoutValues?.[risk]?.[rows]?.[endPos.finalPos];
    
        if (multiplier === undefined) {
            return res.status(400).json({ error: 'Something went wrong' });
        }
    
        const losses = betAmount * (1 - multiplier)
        const winnings = betAmount * multiplier;
        const addedAmt = winnings - betAmount;
    
        //user.balance += addedAmt
        //globalThis.plinkoCache[userData.id] = user
    
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
        });
    
        const gameId = generateRandomId(32);
        res.status(200).json({
            path: endPos.path,
            startPos: endPos.startPos,
            finalPos: endPos.finalPos,
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
        resSent = true
    
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
  
    } catch (error) {
        if(!resSent) {
            res.status(400).json({error: 'Internal server error.'})
        }
    
        console.log('Error:', error.message)
    }
})


module.exports = router