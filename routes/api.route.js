const express = require('express')
const router = express.Router()
const crypto = require('crypto')

const { db } = require("../handler")
const { authJwt } = require('../middlewares/authJwt')
const payoutValues = require('../storage/plinkoPayouts.json')
const chancesValues = require('../storage/plinkoChances.json')


const User = db.user
const Game = db.game

const cache = {}


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

  // Normalize resultNumber to a range within totalWeight
  const scaledResult = resultNumber % totalWeight;

  // Determine the index based on the scaled result
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

router.post('/drop-ball', authJwt, async (req, res) => {
    const userData = req.userData;
    const { rows, risk, betAmount } = req.body;

    if (!betAmount || Number(betAmount) < 1) return res.status(400).json({ error: 'Minimum wager is 1$' });
    if (!['low', 'medium', 'high'].includes(risk)) return res.status(400).json({ error: 'Invalid parameters' });
    if (!rows || rows < 8 || rows > 16) return res.status(400).json({ error: 'Invalid parameters' });

    let user = /*cache[userData.id] ||*/ await User.findOne({ userId: String(userData.id) }).select('balance').lean();
    if (!user) return res.status(400).json({ error: 'Unauthorized access' });
    if (Number(betAmount) > user.balance) return res.status(400).json({ error: 'Insufficient balance' });

    let activeSeed
    const cacheSeed = cache[`${userData.id}_seed`]
    if( cacheSeed ) {
      activeSeed = cacheSeed
    } else {
      const foundSeedDoc = await db['activeSeed'].findOne({ game: 'plinko', userId: String(userData.id) })

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

        cache[`${userData.id}_seed`] = activeSeedObj
        activeSeed = activeSeedObj
      } else {
        cache[`${userData.id}_seed`] = foundSeedDoc
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

    user.balance += addedAmt
    //cache[userData.id] = user

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
    });

    if( cache[`${userData.id}_timeout`] !== undefined ) {
      clearTimeout(cache[`${userData.id}_timeout`])
    }
    const timeoutId = setTimeout( () => {
      if( cache[`${userData.id}_timeout`] !== undefined ) {
        delete cache[`${userData.id}_timeout`]
      }
      if( cache[`${userData.id}_seed`] !== undefined ) {
        delete cache[`${userData.id}_seed`]
      }
    }, 30000 )
    cache[`${userData.id}_timeout`] = timeoutId

    // Final database updates after response
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

    // Update or create the game seed record in database
    await db['activeSeed'].updateOne({ _id: activeSeed._id }, { nonce: activeSeed.nonce })

    // If the casino bot needs balance adjustment
    const casinoBotAdjustment = multiplier > 1 ? -winnings : (multiplier < 1 ? losses : 0)
    if (casinoBotAdjustment !== 0) {
      await User.updateOne({ casinoBot: true }, { $inc: { balance: casinoBotAdjustment } })
    }

    // Game report creation
    await Game.create({
        active: false,
        id: gameId,
        ownerId: String(userData.id),
        amount: Number(betAmount),
        multiplier,
        game: 'plinko',
        gameData: {
          rows: Number(rows),
          risk,
          clientSeed: activeSeed.clientSeed,
          serverSeedHashed: activeSeed.serverSeedHashed,
          nonce: activeSeed.nonce
        }
    });

});

  
router.post('/user-state', authJwt, async(req, res) => {
    const userData = req.userData

    const user = await User.findOne({userId: String(userData.id)})
    if(!user) return res.status( 400 ).json({error: 'Unauthorised access'})

    res.status(200).json({
        balance: user.balance
    })
})
  
router.get('/active-seed', authJwt, async(req, res) => {
    const userData = req.userData
  
    let activeSeed = await db['activeSeed'].findOne({game: 'plinko', userId: String(userData.id)}).select('clientSeed serverSeedHashed nonce')
    if( !activeSeed ) {
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
  
      activeSeed = activeSeedObj
    }
  
    res.status(200).json({
      clientSeed: activeSeed.clientSeed,
      serverSeedHashed: activeSeed.serverSeedHashed,
      nonce: activeSeed.nonce
    })
  })
  
router.post('/game-seed', authJwt, async(req, res) => {
    const {gameId, gameName} = req.body
    const userData = req.userData
  
    const foundGame = await db['game'].findOne({game: gameName, id: gameId, ownerId: String(userData.id)}).select('gameData')
    if( !foundGame ) return res.status(400).json({error: 'Game not found'})
  
    res.status(200).json({game: foundGame})
})
  
router.post('/rotate-seed', authJwt, async(req, res) => {
    const userData = req.userData
  
    const activeSeed = await db['activeSeed'].findOne({game: 'plinko', userId: String(userData.id)})
    if( !activeSeed ) return res.status(400).json({error: 'Active seed not found.'})
  
    const newClientSeed = crypto.randomBytes(16).toString('hex')
  
    const newServerSeed = generateServerSeed()
  
    const oldServerSeed = activeSeed.serverSeed
    const oldHashedServerSeed = activeSeed.serverSeedHashed
  
    activeSeed.serverSeed = activeSeed.nextServerSeed
    activeSeed.serverSeedHashed = activeSeed.nextServerSeedHashed
  
    activeSeed.nextServerSeed = newServerSeed.seed
    activeSeed.nextServerSeedHashed = newServerSeed.seedHash
    activeSeed.clientSeed = newClientSeed
    activeSeed.nonce = 0

    await activeSeed.save()

    if( cache[`${userData.id}_seed`] ) {
      delete cache[`${userData.id}_seed`]
    }
  
    await db['game'].updateMany({game: 'plinko', ownerId: String(userData.id), 'gameData.serverSeedHashed': oldHashedServerSeed}, {'gameData.serverSeed': oldServerSeed})
  
    res.status(200).json({
      clientSeed: activeSeed.clientSeed,
      serverSeedHashed: activeSeed.serverSeedHashed,
      nonce: 0
    })
})
  
  
router.post('/history/:gameName', authJwt, async(req, res) => {
    const gameName = req.params.gameName

    res.status(200).json({games: []})
})
  
  

module.exports = router