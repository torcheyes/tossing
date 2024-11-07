const express = require('express')
const router = express.Router()
const crypto = require('crypto')

const { db } = require("../handler")
const { authJwt } = require('../middlewares/authJwt')

const User = db.user

function generateServerSeed() {
    const seed = crypto.randomBytes(32).toString('hex');
    const seedHashRaw = crypto.createHash('sha256').update(seed);
    const seedHash = seedHashRaw.digest('hex');
  
    return {
      seed,
      seedHash,
    }
}

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

  let activeSeed = await db['activeSeed'].findOne({userId: String(userData.id)}).select('clientSeed serverSeedHashed nonce')
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
  
    const activeSeed = await db['activeSeed'].findOne({userId: String(userData.id)})
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

    if( globalThis.plinkoCache[`${userData.id}_seed`] ) {
      delete globalThis.plinkoCache[`${userData.id}_seed`]
    }
  
    await db['game'].updateMany({ownerId: String(userData.id), 'gameData.serverSeedHashed': oldHashedServerSeed}, {'gameData.serverSeed': oldServerSeed})
  
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