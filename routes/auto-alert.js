const express = require('express');
const router = express.Router();
const { checkAndAlert, status } = require('../services/auto-alert');
router.get('/status', (req,res)=>res.json(status()));
router.post('/check', async (req,res)=>res.json(await checkAndAlert()));
module.exports = router;
