import tokenStructure from "../models/tokens.js";
import simulationStructure from "../models/simulations.js";
import sniperTxsStructure from "../models/sniperTxs.js";
import abiDecoder from "abi-decoder"
import ethers from "ethers";
import { wssProvider, NONCE_HIGH_LEVEL, NONCE_SMALL_LEVEL, SAME_DELTA, uniswapV2Pair, FILTER_NONCE_COUNT, MAX_NUMBER,
  FILTER_SNIPERS_COUNT, SNIPER_NUMBER_MIN, NONCE0_MIN, NONCE0_OWNER_DELTA, WALLET_NUMBER_MIN, DOUBLE_SNIPER_WALLET, TOKENS, APIKEY, 
  httpProvider} from "../src/constants.js";
import IERC20ABI from "../src/abi/IERC20.js";
import IUniswapV2Pair from "../src/abi/IUniswapV2Pair.js";
import IUniswapV2Factory from "../src/abi/IUniswapV2Factory.js";
import ITeamFinanceLock from "../src/abi/ITeamFinance.js";
import IUnicrypt from "../src/abi/IUnicrypt.js";
import IPinkLock from "../src/abi/IPinkLock.js";
import { getUniv2PairAddress } from "../src/univ2.js";
import { match } from "../src/utils.js";

abiDecoder.addABI(IERC20ABI);
abiDecoder.addABI(IUniswapV2Pair);
abiDecoder.addABI(IUniswapV2Factory);
abiDecoder.addABI(ITeamFinanceLock);
abiDecoder.addABI(IUnicrypt);
abiDecoder.addABI(IPinkLock);

export const getPlotInfo = async (req, res) => {
  try {
    const tokens = await getFilteredTokens()
    console.log("length", tokens.length)
    // res.json({
    //   tokens
    // })
    let length = tokens.length

    let sniped = [], ratio = [], active = [];
    let sum = 0;

    for(let i = 0; i < length; ++ i) {
      sniped[i] = tokens[i].snipeData.sniperTxCount;
      ratio[i] = parseFloat(tokens[i].price) / parseFloat(tokens[i].snipeData.snipers);
      let swap = parseInt(tokens[i].buyCount) + parseInt(tokens[i].sellCount);
      active[i] = swap >= 400 ? 1 : 0; 
      sum += active[i];
    }

    console.log(sum)
    
    res.json({
      sniped: sniped,
      ratio: ratio,
      active: active
    })
  } catch (e) {
    console.log("error", e.message)
    res.json({
      error: e.message,
    })
  }

}

export const getSniperModel = async (sniperTxsDB) => {
  let sniperTxs = [];
  let BGCount = 0, MaestroCount = 0;
  for(let i = 0 ; i < sniperTxsDB.length ; ++ i) {
    const sniperTx = await wssProvider.getTransaction(sniperTxsDB[i].txHash);
    let toAddress = "";
    if(sniperTx === null || sniperTx.to === null) {
      continue;
    }
    if(sniperTx.to.toLocaleLowerCase() === "0x3328F7f4A1D1C57c35df56bBf0c9dCAFCA309C49".toLocaleLowerCase()){
      toAddress = "BananaGun";
      BGCount ++;
    }
    if(sniperTx.to.toLocaleLowerCase() === "0x7a250d5630b4cf539739df2c5dacb4c659f2488d".toLocaleLowerCase())
      toAddress = "UniswapV2Router";
    if(sniperTx.to.toLocaleLowerCase() === "0x80a64c6D7f12C47B7c66c5B4E20E72bc1FCd5d9e".toLocaleLowerCase()) {
      toAddress = "Maestro";
      MaestroCount ++;
    }
    let sniperTxsObject = {
      txHash : sniperTx.hash,
      from : sniperTx.from,
      to : toAddress === "" ? sniperTx.to : toAddress,
      nonce : sniperTx.nonce,
      priorityFee : ethers.utils.formatUnits(sniperTx.maxPriorityFeePerGas !== undefined ? sniperTx.maxPriorityFeePerGas : ethers.constants.Zero, "gwei"),
      gasLimit : sniperTx.gasLimit.toString(),
      value : ethers.utils.formatEther(sniperTx.value)
    };
    sniperTxs.push(sniperTxsObject);
  }

  return {sniperTxs, BGCount, MaestroCount};
}

const checkSame = (values, to, val) => {
  let id = 0
  let size = values.length
  let delta = SAME_DELTA


  while(id < size) {

    if(values[id].to === to) {
      if((values[id].value + delta) >= val && (values[id].value - delta) <= val){
        return true
      }
    }
    id ++
  }

  return false
}

export const getSniperTxNonce0 = async(token) => {
  const sniperTxsDB = await sniperTxsStructure.find({address: token}, {nonce: 1, to: 1, value: 1})
  let nonceSmallCount = 0
  let nonceHighCount = 0
  let BGCount = 0
  let MaestroCount = 0
  let values = []
  
  for(let i = 0 ; i < sniperTxsDB.length ; i ++) {

    if(sniperTxsDB[i].to === "BananaGun"){
      BGCount ++;

      if(!checkSame(values, 'BG', sniperTxsDB[i].value)) {
        values.push({to: 'BG', value: sniperTxsDB[i].value})
      }
    }
    else if(sniperTxsDB[i].to === "Maestro") {
      MaestroCount ++;

      if(!checkSame(values, 'MS', sniperTxsDB[i].value)) {
        values.push({to: 'MS', value: sniperTxsDB[i].value})
      }
    }
    else {
      if(!checkSame(values, sniperTxsDB[i].to, sniperTxsDB[i].value)) {
        values.push({to: sniperTxsDB[i].to, value: sniperTxsDB[i].value})
      }
    }

    if(sniperTxsDB[i].nonce <= NONCE_SMALL_LEVEL)
      nonceSmallCount ++;
    if(sniperTxsDB[i].nonce >= NONCE_HIGH_LEVEL)
      nonceHighCount ++;
  }

  return {nonceSmallCount, nonceHighCount, BGCount, MaestroCount, snipers: values.length, sniperTxCount: sniperTxsDB.length};
}

export const getContractInfo = async (req, res) => {
  const query = req.query;
  try {
    const contractAddress = query.address.toLowerCase();
    const tokenInfo = await tokenStructure.findOne({
      address: contractAddress,
    });
    let simulationInfos = await simulationStructure.find({
      address: contractAddress,
    });
    let newSimulationInfos = [];
    for (let i = 0; i < simulationInfos.length; ++i) {
      let simulationInfo = simulationInfos[i];
      let newSimulationInfo = simulationInfo.toJSON();
      newSimulationInfo.maxBuyAmount = ethers.BigNumber.from(
        tokenInfo.totalSupply
      )
        .mul(1000)
        .div(ethers.BigNumber.from(simulationInfo.maxSwapPercent * 10))
        .toString();
      newSimulationInfo.isUnlimitedBuy =
        simulationInfo.maxSwapPercent > 10 ? true : false;
      newSimulationInfos.push(newSimulationInfo);
    }

    // let contractCode;
    // const fetchURL = `https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${tokenInfo.address}&apikey=E4DKRHQZPF2RVBXC6G2IBP56PJFFBITYVA`;
    // await fetch(fetchURL)
    // .then((res) => res.json())
    // .then((json) => {
    //   contractCode = json.result[0].SourceCode;
    // })
    // .catch(() => {
    //   console.log(
    //     "Error when getting smart contract code from etherscan."
    //   );
    // });

    let sniperTxsDB = await sniperTxsStructure.find({address: contractAddress}); 

    if (tokenInfo != null) {

      const blockInfo = await wssProvider.getBlockWithTransactions(Number(tokenInfo.firstSwapBlockNumber));  //get block information including transactions
      const txns = blockInfo.transactions // get block transactions
      console.log(tokenInfo.blockNumber)

      let start = null, end = null, price = 0.0;

      for(let i = 0; i < sniperTxsDB.length; i ++) {
        sniperTxsDB[i] = {...sniperTxsDB[i]._doc, position: txns.findIndex(tx => tx.hash === sniperTxsDB[i].txHash)}
        if (i == 0) await getReservesFromTransaction(sniperTxsDB[i].txHash, true).then(reserves => {
          if (reserves) {
            start = reserves
          //  console.log(`Detected reserves from the transaction:`, reserves);
          } else {
            console.log('No reserve updates found in the transaction logs');
          }
        });
        if (i == sniperTxsDB.length - 1) await getReservesFromTransaction(sniperTxsDB[i].txHash).then(reserves => {
          if (reserves) {
            end = reserves
          //  console.log(`Detected reserves from the transaction:`, reserves);
          } else {
            console.log('No reserve updates found in the transaction logs');
          }
        });
      }

      if(start && end) {
        price = 1.0 * start.token * end.weth * 100 / end.token / start.weth - 100.0
        console.log(price)
      }

      res.status(200).json({
        success: true,
        data: tokenInfo,
        simulationInfo: newSimulationInfos,
        // contractSourceCode: contractCode,
        sniperTxs: sniperTxsDB,
        price: price,
      });
    } else {
      res.status(400).json({
        success: false,
        error: "There's no such contract.",
      });
    }
  } catch (e) {
    res.status(400).json({
      success: false,
      error: e.message,
    });
  }
};

export const getReservesFromTransaction = async (txHash, start = false) => {
  // Get the transaction receipt, which contains the logs
  const receipt = await wssProvider.getTransactionReceipt(txHash);
  
  let decodedLogs = [];
  try {
    decodedLogs = abiDecoder.decodeLogs(receipt.logs);
  } catch (e) {
    return null;
  }

  // Check all the logs from the transaction
  let WETHReserve, tokenReserve;
  let amount0In, amount1In, amount0Out, amount1Out
  let swapDirection; // 0: WETH -> TOKEN(BUY), 1: TOKEN -> WETH(SELL)
  let tradeWeth, tradeToken;
        
  for (const log of decodedLogs) {
    try {
      if (log.name === 'Sync') {
        const reserve0 = log.events[0].value;
        const reserve1 = log.events[1].value;

        const pair = log.address.toLowerCase();

        let token0, token1;
        try {
          token0 = await uniswapV2Pair.attach(pair).token0();
          token1 = await uniswapV2Pair.attach(pair).token1();
         } catch (e) {
          continue;
        }

        if (match(token0, TOKENS.WETH)) {
          WETHReserve = reserve0;
          tokenReserve = reserve1;
        } else if (match(token1, TOKENS.WETH)) {
          WETHReserve = reserve1;
          tokenReserve = reserve0;
        } else {
          throw new Error('Neither token0 nor token1 is WETH');
        }

      }

      if (log.name == "Swap") {
        const pair = log.address.toLowerCase();

        amount0In = log.events[1].value;
        amount1In = log.events[2].value;
        amount0Out = log.events[3].value;
        amount1Out = log.events[4].value;

        let token0, token1;
        try {
          token0 = await uniswapV2Pair.attach(pair).token0();
          token1 = await uniswapV2Pair.attach(pair).token1();
        } catch (e) {
          continue;
        }

        if (amount1Out == "0") { // 0: WETH -> TOKEN(BUY), 1: TOKEN -> WETH(SELL)
          swapDirection = match(token0, TOKENS.WETH) ? 1 : 0;
        } else {
          swapDirection = match(token0, TOKENS.WETH) ? 0 : 1;
        }

        if (swapDirection == 0) {
          tradeToken = amount0Out != "0" ? amount0Out : amount1Out;
          tradeWeth = amount0Out != "0" ? amount1In : amount0In;
        } else {
          tradeToken = amount0In != "0" ? amount0In : amount1In;
          tradeWeth = amount0In != "0" ? amount1Out : amount0Out;
        }
        
      }
    } catch (error) {
      console.log("error", error)
      return null;
    }
  }

  if (start) {
    if (swapDirection == 0) {
      tokenReserve = parseInt(tokenReserve) + parseInt(tradeToken);
      WETHReserve = parseInt(WETHReserve) - parseInt(tradeWeth);
    } else {
      tokenReserve = parseInt(tokenReserve) - parseInt(tradeToken);
      WETHReserve = parseInt(WETHReserve) + parseInt(tradeWeth);
    }
  }

  // console.log(`WETH Reserve: ${WETHReserve}`);
  // console.log(`Token Reserve: ${tokenReserve}`);

  return {
    weth: WETHReserve, 
    token: tokenReserve
  };
  
}

export const getContractInfoByPair = async (req, res) => {
  const query = req.query;
  try {
    const pairAddress = query.address.toLowerCase();
    const tokenInfo = await tokenStructure.findOne({
      pair: pairAddress,
    });
    if (tokenInfo != null) {
      let simulationInfos = await simulationStructure.find({
        address: tokenInfo.address,
      });
      res.status(200).json({
        success: true,
        data: tokenInfo,
        simulationInfo: simulationInfos
      });
    } else {
      res.status(200).json({
        success: false,
        error: "There's no such contract.",
      });
    }
  } catch (e) {
    res.status(200).json({
      success: false,
      error: e.message,
    });
  }
};

export const getBlockTxnsForTokens = async(req, res) => {
  const {block, token} = req.query;

  let txnsForTokens = []

  try {
    const blockInfo = await wssProvider.getBlockWithTransactions(Number(block));  //get block information including transactions
    const txns = blockInfo.transactions // get block transactions
  
    let token0, token1

    let result = []
  
    if(!txns || txns === undefined) { // if no transactions, no need to analyse
      res.json({txns: []})
      return
    }
  
    let position = -1
    let first = true, start = null, end = null, price = 0.0;
  
    for (const tx of txns) {
      const txReceipt = await wssProvider.getTransactionReceipt(tx.hash); // get transaction information based on txHash. it's a bit different from tx

      let isSwap = false // flag to decide whethere transaction is swap or not
      position ++;
  
      try {

        // Ignore failed transaction
        if (txReceipt.status == 0) continue // no success transaction
        
        let decodedLogs = []
        try {
          decodedLogs = abiDecoder.decodeLogs(txReceipt.logs); //decode transation logs to detect excuted funtions in transaction
        } catch (e) {
          continue
        }

        for (const decodedLog of decodedLogs) {
          
          if (decodedLog.name !== "Swap") continue // no swap function
          
          const pair = decodedLog.address.toLowerCase(); // get pair address used in this swap function
          
          try {
            // If the pair is uniswap v2 pair
            token0 = await uniswapV2Pair.attach(pair).token0(); // token0 address in the pair
            token1 = await uniswapV2Pair.attach(pair).token1(); // token1 address in the pair
            
            if(token0.toLowerCase() !== token.toLowerCase() && token1.toLowerCase() !== token.toLowerCase()) continue // if token0 or token1 is not token inputed,  no need to analyse
            
            if (
              pair !==
              getUniv2PairAddress({ tokenA: token0, tokenB: token1 }).toLowerCase() // if uniswap v2 pair is right?
            )
            continue;

  
            isSwap = true // this transation is ours
            break
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        continue
      }
  
      // push found transations to response
      if(isSwap) {
        let toAddress = "";
        if(tx.to.toLocaleLowerCase() === "0x3328F7f4A1D1C57c35df56bBf0c9dCAFCA309C49".toLocaleLowerCase()){
          toAddress = "BananaGun";
        }
        if(tx.to.toLocaleLowerCase() === "0x7a250d5630b4cf539739df2c5dacb4c659f2488d".toLocaleLowerCase())
          toAddress = "UniswapV2Router";
        if(tx.to.toLocaleLowerCase() === "0x80a64c6D7f12C47B7c66c5B4E20E72bc1FCd5d9e".toLocaleLowerCase()) {
          toAddress = "Maestro";
        }
        
        tx.to = toAddress === "" ? tx.to : toAddress
  
        // res.json({txReceipt, tx})
        // return

        let gasPrice = ethers.utils.formatUnits(tx.gasPrice !== undefined ? tx.gasPrice : ethers.constants.Zero, "gwei")
        let gasUsed = txReceipt.gasUsed
  
        txnsForTokens.push({
          txHash: tx.hash,
          type: tx.type,
          from: tx.from,
          to: tx.to,
          gasPrice: gasPrice,
          baseFeePerGas: ethers.utils.formatUnits(blockInfo.baseFeePerGas !== undefined ? blockInfo.baseFeePerGas : ethers.constants.Zero, "gwei"),
          maxPriorityFeePerGas: ethers.utils.formatUnits(tx.maxPriorityFeePerGas !== undefined ? tx.maxPriorityFeePerGas : ethers.constants.Zero, "gwei"),
          maxFeePerGas: ethers.utils.formatUnits(tx.maxFeePerGas !== undefined ? tx.maxFeePerGas : ethers.constants.Zero, "gwei"),
          gasUsed: gasUsed.toString(),
          gasFee: gasUsed * gasPrice,
          gasLimit: tx.gasLimit.toString(),
          value: ethers.utils.formatEther(tx.value),
          nonce: tx.nonce,
          bribe: await getInternalTxns(tx.from, tx.to, tx.hash),
          position: position
        })
          
        isSwap = false
	if (first) {
          await getReservesFromTransaction(tx.hash, true).then(reserves => {
            if (reserves) start = reserves
            else console.log('No reserve updates found in the transaction logs');
            first = false;
          });
        } 
        await getReservesFromTransaction(tx.hash, false).then(reserves => {
          if (reserves) end = reserves
          else console.log('No reserve updates found in the transaction logs');
        });
      }
    }
    if(start && end) {
      price = 1.0 * start.token * end.weth * 100 / end.token / start.weth - 100.0
      console.log(price)
    }
    res.json({
      tokens: txnsForTokens,
      price: price,
    })
  } catch(e) {
    console.log(e)
    res.json({
      tokens: [],
      price: 0,
    })
  }
}

export const getFilteredTokens = async() => {
  let tokens = await sniperTxsStructure.aggregate([
    {
      $match: {
        nonce: {$lte: NONCE_SMALL_LEVEL}
      }
    }, {
      $group: {
        _id: '$address',
        nonce0s: {$sum: 1},
        address: {$first: '$address'},
        to: {$first: '$to'},
        value: {$first: '$value'},
      }
    }, {
      $match: {
        nonce0s: {$gte: Number(FILTER_NONCE_COUNT)}
      }
    }, {
      $lookup: {
        from: 'tokenstructures',
        localField: 'address',
        foreignField: 'address',
        as: 'tokens'
      }
    }, {
      $project: {
        tokens: 1,
        toSnipers: 1
      }
    }, {
      $sort: {
        'tokens.createdAt': -1
      }
    }
  ])

  for(let i = 0 ; i < tokens.length; i ++) {
    tokens[i] = {...tokens[i].tokens[0], snipeData: await getSniperTxNonce0(tokens[i].tokens[0].address)}
  }

  tokens = tokens.filter(t => t.snipeData.snipers >= Number(FILTER_SNIPERS_COUNT))

  return tokens
}

export const getFilteredTokensApi = async(req, res) => {
  const {nonce0s, snipers, BG_MinCount, BG_Rate, MAS_Rate} = req.query

  let tokens = await sniperTxsStructure.aggregate([
    {
      $match: {
          nonce: {$lte: NONCE_SMALL_LEVEL}
      }
    }, {
      $group: {
        _id: '$address',
        nonce0s: {$sum: 1},
        address: {$first: '$address'}
      }
    }, {
      $match: {
        nonce0s: {$gte: Number(nonce0s)}
      }
    }, {
      $lookup: {
        from: 'tokenstructures',
        localField: 'address',
        foreignField: 'address',
        as: 'tokens'
      }
    }, {
      $project: {
        tokens: 1,
        toSnipers: 1
      }
    }, {
      $sort: {
        'tokens.createdAt': -1
      }
    }
  ])

  const stx_address = await sniperTxsStructure.aggregate([
    {
      $group: {
        _id: '$address',
        sum: {$sum: 1}
      }
    }
  ])

  const tos = await sniperTxsStructure.aggregate([
   {
      $group: {
        _id: {address: '$address', to: '$to', value: '$value'},
        toCnt: {$sum: 1}
      }
    }
  ])

  let eliminates = []
  let specials = []

  for(let i = 0 ; i < tos.length; i ++) {
    let sniperTxCnt = stx_address.find(s => s._id === tos[i]._id.address)
    sniperTxCnt = sniperTxCnt.sum
    if(tos[i]._id.to === "BananaGun") {
      if(tos[i].toCnt > Math.max(14, parseFloat(BG_MinCount))) {
        specials.push(tos[i]._id.address)
        continue
      }      
      if(tos[i].toCnt <= Math.min(14, parseFloat(BG_MinCount)) && (parseFloat(tos[i].toCnt) / parseFloat(sniperTxCnt)) >= parseFloat(BG_Rate)) {
        eliminates.push(tos[i]._id.address)
        continue
      }
    }
    else if(tos[i]._id.to === "Maestro") {
      if((parseFloat(tos[i].toCnt) / parseFloat(sniperTxCnt)) >= parseFloat(MAS_Rate)) {
        eliminates.push(tos[i]._id.address)
      }
      continue
    }
  }


  tokens = tokens.map(t => t.tokens[0])
  tokens = tokens.filter(t => eliminates.findIndex(e => e === t.address) === -1)


  for(let i = 0 ; i < tokens.length; i ++) {
    tokens[i] = {...tokens[i], special: false, snipeData: await getSniperTxNonce0(tokens[i].address)}
    if(specials.findIndex(s => s === tokens[i].address) > -1)
      tokens[i] = {...tokens[i], special: true}
  }

  tokens = tokens.filter(t => t.snipeData.snipers >= Number(snipers))

  res.json(tokens)
}

export const getFilteredMevTokensApi = async(req, res) => {
  const {nonce0s, snipers, BG_MinCount, BG_Rate, MAS_Rate, MEV_Rate} = req.query

  let tokens = await sniperTxsStructure.aggregate([
    {
      $match: {
        $and: [
          {to: {$ne: 'BananaGun'}},
          {to: {$ne: 'Maestro'}},
          {to: {$ne: 'UniswapV2Router'}},
          {nonce: {$lte: NONCE_SMALL_LEVEL}}
        ]
      }
    }, {
      $group: {
        _id: '$address',
        nonce0s: {$sum: 1},
        address: {$first: '$address'},
        to: {$first: '$to'},
        value: {$first: '$value'},
      }
    }, {
      $match: {
        nonce0s: {$gte: Number(nonce0s)}
      }
    }, {
      $lookup: {
        from: 'tokenstructures',
        localField: 'address',
        foreignField: 'address',
        as: 'tokens'
      }
    }, {
      $project: {
        tokens: 1,
        toSnipers: 1
      }
    }, {
      $sort: {
        'tokens.createdAt': -1
      }
    }
  ])

  const stx_address = await sniperTxsStructure.aggregate([
    {
      $group: {
        _id: '$address',
        sum: {$sum: 1}
      }
    }
  ])

  // const tos = await sniperTxsStructure.aggregate([
  //  {
  //     $group: {
  //       _id: {address: '$address', to: '$to', value: '$value'},
  //       toCnt: {$sum: 1}
  //     }
  //   }
  // ])

  const bots = await sniperTxsStructure.aggregate([
    {
      $match: {
        $and: [
          {to: {$ne: 'BananaGun'}},
          {to: {$ne: 'Maestro'}},
          {to: {$ne: 'UniswapV2Router'}}
        ]
      }
    },
    {
       $group: {
         _id: '$address',
         toCnt: {$sum: 1}
       }
     }
   ])

  let eliminates = []
  let specials = []

  // for(let i = 0 ; i < tos.length; i ++) {
  //   let sniperTxCnt = stx_address.find(s => s._id === tos[i]._id.address)
  //   sniperTxCnt = sniperTxCnt.sum
  //   if(tos[i]._id.to === "BananaGun") {
  //     if(tos[i].toCnt <= Number(BG_MinCount) && (tos[i].toCnt / sniperTxCnt) >= Number(BG_Rate)) {
  //       eliminates.push(tos[i]._id.address)
  //       continue
  //     }
  //     if(tos[i].toCnt > 10) {
  //       specials.push(tos[i]._id.address)
  //       continue
  //     }
  //   }
  //   else if(tos[i]._id.to === "Maestro") {
  //     if((tos[i].toCnt / sniperTxCnt) >= Number(MAS_Rate)) {
  //       eliminates.push(tos[i]._id.address)
  //     }
  //     continue
  //   }
  // }

  for(let i = 0 ; i < bots.length; i++) {
    let sniperTxCnt = stx_address.find(s => s._id === bots[i]._id)
    sniperTxCnt = sniperTxCnt.sum

    
    if((bots[i].toCnt / sniperTxCnt) >= Number(MEV_Rate)) {
      specials.push(bots[i]._id)
    }
  }


  tokens = tokens.map(t => t.tokens[0])
  // tokens = tokens.filter(t => eliminates.findIndex(e => e === t.address) === -1)


  for(let i = 0 ; i < tokens.length; i ++) {
    tokens[i] = {...tokens[i], special: false, snipeData: await getSniperTxNonce0(tokens[i].address)}
    if(specials.findIndex(s => s === tokens[i].address) > -1)
      tokens[i] = {...tokens[i], special: true}
  }

  tokens = tokens.filter(t => t.snipeData.snipers >= Number(snipers))

  res.json(tokens)
}

export const getFilteredNonceTokensApi = async(req, res) => {
  let tokens = await sniperTxsStructure.aggregate([
    {
      $match: {
          nonce: {$lte: NONCE_SMALL_LEVEL}
      }
    }, {
      $group: {
        _id: '$address',
        nonce0s: {$sum: 1},
        address: {$first: '$address'},
        to: {$first: '$to'},
        value: {$first: '$value'},
      }
    }, {
      $match: {
        nonce0s: {$gte: FILTER_NONCE_COUNT}
      }
    }, {
      $lookup: {
        from: 'tokenstructures',
        localField: 'address',
        foreignField: 'address',
        as: 'tokens'
      }
    }, {
      $project: {
        tokens: 1,
        toSnipers: 1
      }
    }, {
      $sort: {
        'tokens.createdAt': -1
      }
    }
  ])

  for(let i = 0 ; i < tokens.length; i ++) {
    tokens[i] = {...tokens[i].tokens[0], snipeData: await getSniperTxNonce0(tokens[i].tokens[0].address)}
  }

  tokens = tokens.filter(t => t.snipeData.snipers >= Number(FILTER_SNIPERS_COUNT))

  res.json(tokens)
  return
}


export const getFilteredWalletTokensApi = async(req, res) => {
  let tokens = await sniperTxsStructure.aggregate([
    {
      $match: {
        // $or: [
        //   {
        //     $and: [
        //       {$or: [
        //         {to: 'BananaGun'},
        //         {to: 'Maestro'}
        //       ]},
              nonce: {$gt: NONCE_SMALL_LEVEL}
        //     ]
        //   }, {
        //     $and: [
        //       {to: {$ne: 'BananaGun'}},
        //       {to: {$ne: 'Maestro'}},
        //       {to: {$ne: 'UniswapV2Router'}}
        //     ]
        //   }
        // ]
      }
    }, {
      $group: {
        _id: {address: '$address', to: '$to', value: '$value'},
        count: {$sum: 1},
        address: {$first: '$address'},
        to: {$first: '$to'},
        nonce: {$push: '$nonce'}
      }
    }, {
      $match: {
        count: {$gte: WALLET_NUMBER_MIN}
      }
    }, {
      $group: {
        _id: '$address',
        address: {$first: '$address'},
        to: {$first: '$to'},
        nonce: {$push: '$nonce'}
      }
    }, {
      $lookup: {
        from: 'tokenstructures',
        localField: 'address',
        foreignField: 'address',
        as: 'tokens'
      }
    }, {
      $project: {
        tokens: 1,
        nonce: 1,
        to: 1
      }
    }
  ])

  let dtokens = await sniperTxsStructure.aggregate([
    {
      $match: {
        // $or: [
        //   {
        //     $and: [
        //       {$or: [
        //         {to: 'BananaGun'},
        //         {to: 'Maestro'}
        //       ]},
              nonce: {$gt: NONCE_SMALL_LEVEL}
        //     ]
        //   }, {
        //     $and: [
        //       {to: {$ne: 'BananaGun'}},
        //       {to: {$ne: 'Maestro'}},
        //       {to: {$ne: 'UniswapV2Router'}}
        //     ]
        //   }
        // ]
      }
    }, {
      $group: {
        _id: {address: '$address', to: '$to', value: '$value'},
        count: {$sum: 1},
        address: {$first: '$address'}
      }
    }, {
      $match: {
        count: {$gte: DOUBLE_SNIPER_WALLET}
      }
    }, {
      $group: {
        _id: '$address',
        sum: {$sum: 1},
      }
    }, {
      $match: {
        sum : {$gte: 2}
      }
    }
  ])

  tokens = tokens.filter(t => dtokens.findIndex(d => d._id === t.tokens[0].address) >= 0)
  console.log(tokens)

  let isSkip = false
  let snipeData = {}
  for(let i = 0; i < tokens.length; i ++) {
    isSkip = false
    if(tokens[i].to === 'BananaGun' || tokens[i].to === 'Maestro') {
      for(let j = 0 ; j < tokens[i].nonce.length; j ++) {
        isSkip = await isNonceSame(tokens[i].nonce[j])
        if(isSkip) break
        // if((tokens[i].nonce[j].length / snipeData.sniperTxCount) >= 0.7) {
          //   isSkip = true
          //   break
          // }
        }
      }
    if(isSkip) continue
    snipeData = await getSniperTxNonce0(tokens[i].tokens[0].address)
    tokens[i] = {...tokens[i].tokens[0], snipeData: snipeData}
  }

  tokens = tokens.filter(t => t.snipeData !== undefined)

  res.json(tokens)

}

const isNonceSame = async(nonces) => {
  const counts = nonces.reduce((acc, value) => {
    // If the value is already a property of acc, increment it, otherwise initialize it to 1
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});

  for (const key in counts) {
    if(Number(key) < 10 && (counts[key] > nonces.length - 3)) return true
  }
  return false
}

const getAddress = (address) => {
  let toAddress = '';
  if(address.toLocaleLowerCase() === "0x3328F7f4A1D1C57c35df56bBf0c9dCAFCA309C49".toLocaleLowerCase()){
    toAddress = "BananaGun";
  }
  else if(address.toLocaleLowerCase() === "0x7a250d5630b4cf539739df2c5dacb4c659f2488d".toLocaleLowerCase())
    toAddress = "UniswapV2Router";
  else if(address.toLocaleLowerCase() === "0x80a64c6D7f12C47B7c66c5B4E20E72bc1FCd5d9e".toLocaleLowerCase()) {
    toAddress = "Maestro";
  }
  else {
    toAddress = address
  }

  return toAddress
}

const getInternalTxns = async(from, to, hash) => {
  const res = await httpProvider.send("debug_traceTransaction", 
                    [hash, { tracer: 'callTracer', tracerConfig: { withLog: false } }])

  const logs = res.calls[0]

  if(logs === undefined) return 0
  if(logs.calls === undefined) return 0

  let lfrom = ''
  let lto = ''

  for(const log of logs.calls) {
    if(log.type !== 'CALL') continue
    
    lfrom = getAddress(log.from)  
    if(lfrom !== to) continue
    
    lto = getAddress(log.to)
    if(lto === from) continue
    if(lto === TOKENS.WETH) continue
    
    return ethers.utils.formatEther(log.value)
  }

  return 0
}

// tokens having at least one sniping transactions including bribe maybe useful tokens
export const getFilteredBribetokensApi = async(req, res) => {
  res.json(await getInternalTxnsFromEtherscan(''))
}

export const getFilteredTokensTest = async(req, res) => {
  const {nonce0s, snipers} = req.query

  let tokens = await sniperTxsStructure.aggregate([
    {
      $match: {
        nonce: 0,
        address: '0x027e99e24495442d16667b69423f1e82c1d185db'
      }
    }, {
      $group: {
        _id: '$address',
        nonce0s: {$sum: 1},
        address: {$first: '$address'},
        to: {$first: '$to'},
        value: {$first: '$value'},
      }
    }, {
      $match: {
        nonce0s: {$gte: Number(nonce0s)}
      }
    }, {
      $group: {
        _id: {saddress: '$address', sto: '$to', svalue: {$round: ['$value', 2]}},
        toSnipers: {$sum: 1}
      }
    }, {
      $lookup: {
        from: 'tokenstructures',
        localField: 'address',
        foreignField: 'address',
        as: 'tokens'
      }
    }, {
      $project: {
        tokens: 1,
        toSnipers: 1
      }
    }
  ])

  res.json(tokens)
  return

  // tokens = await tokenStructure.aggregate([
  //  {
  //     $lookup: {
  //       from: 'snipertxsstructures',
  //       localField: 'address',
  //       foreignField: 'address',
  //       as: 'sniperTxs'
  //     }
  //   }, {
  //     $unwind: {
  //       path: '$sniperTxs'
  //     }
  //   }, {
  //     $match: {
  //       'sniperTxs.nonce': 0
  //     }
  //   }, {
  //     $group: {
  //       _id: '$_id',
  //       nonce0s:  {$sum: 1},
  //       // sniperTxs: {$push: '$sniperTxs'},
  //       address: {$first: '$address'},
  //       name: {$first: '$name'},
  //       symbol: {$first: '$symbol'},
  //       pair: {$first: '$pair'},
  //       blockNumber: {$first: '$blockNumber'},
  //       buyCount:{$first: '$buyCount'},
  //       sellCount: {$first: '$sellCount'},
  //       liquidityLockedHash: {$first: '$liquidityLockedHash'},
  //       removeLimitsHash: {$first: '$removeLimitsHash'},
  //       setMaxTxAmountHash: {$first: '$setMaxTxAmountHash'},
  //       renounceOwnerShipHash: {$first: '$renounceOwnerShipHash'},
  //       updatedOwner: {$first: '$updatedOwner'},
  //       liquidityUnlockTime: {$first: '$liquidityUnlockTime'},
  //       level: {$first: '$level'},
  //       liquidityLockedBuyCount: {$first: '$liquidityLockedBuyCount'},
  //       liquidityLockedSellCount: {$first: '$liquidityLockedSellCount'},
  //       firstBlockBuyCount: {$first: '$firstBlockBuyCount'},
  //       firstBlockSellCount: {$first: '$firstBlockSellCount'},
  //       firstSwapBlockNumber: {$first: '$firstSwapBlockNumber'},
  //       createdAt: {$first: '$createdAt'},
  //       updatedAt: {$first: '$updatedAt'},
  //     }
  //   }
  //   // , {
  //   //   $unwind: {
  //   //     path: '$sniperTxs'
  //   //   }
  //   // }, {
  //   //   $group: {
  //   //     _id: {_id: '$_id', sto: '$sniperTxs.to', svalue: {$round: ['$sniperTxs.value', 2]}},
  //   //     snipers: {$sum: 1},
  //   //     address: {$first: '$address'},
  //   //     nonce0s: {$first: '$nonce0s'},
  //   //     name: {$first: '$name'},
  //   //     symbol: {$first: '$symbol'},
  //   //     pair: {$first: '$pair'},
  //   //     blockNumber: {$first: '$blockNumber'},
  //   //     buyCount:{$first: '$buyCount'},
  //   //     sellCount: {$first: '$sellCount'},
  //   //     liquidityLockedHash: {$first: '$liquidityLockedHash'},
  //   //     removeLimitsHash: {$first: '$removeLimitsHash'},
  //   //     setMaxTxAmountHash: {$first: '$setMaxTxAmountHash'},
  //   //     renounceOwnerShipHash: {$first: '$renounceOwnerShipHash'},
  //   //     updatedOwner: {$first: '$updatedOwner'},
  //   //     liquidityUnlockTime: {$first: '$liquidityUnlockTime'},
  //   //     level: {$first: '$level'},
  //   //     liquidityLockedBuyCount: {$first: '$liquidityLockedBuyCount'},
  //   //     liquidityLockedSellCount: {$first: '$liquidityLockedSellCount'},
  //   //     firstBlockBuyCount: {$first: '$firstBlockBuyCount'},
  //   //     firstBlockSellCount: {$first: '$firstBlockSellCount'},
  //   //     firstSwapBlockNumber: {$first: '$firstSwapBlockNumber'},
  //   //     createdAt: {$first: '$createdAt'},
  //   //     updatedAt: {$first: '$updatedAt'},
  //   //   }
  //   // }, {
  //   //   $group: {
  //   //     _id: '$address',
  //   //     snipers: {$sum: 1},
  //   //     address: {$first: '$address'},
  //   //     nonce0s: {$first: '$nonce0s'},
  //   //     name: {$first: '$name'},
  //   //     symbol: {$first: '$symbol'},
  //   //     pair: {$first: '$pair'},
  //   //     blockNumber: {$first: '$blockNumber'},
  //   //     buyCount:{$first: '$buyCount'},
  //   //     sellCount: {$first: '$sellCount'},
  //   //     liquidityLockedHash: {$first: '$liquidityLockedHash'},
  //   //     removeLimitsHash: {$first: '$removeLimitsHash'},
  //   //     setMaxTxAmountHash: {$first: '$setMaxTxAmountHash'},
  //   //     renounceOwnerShipHash: {$first: '$renounceOwnerShipHash'},
  //   //     updatedOwner: {$first: '$updatedOwner'},
  //   //     liquidityUnlockTime: {$first: '$liquidityUnlockTime'},
  //   //     level: {$first: '$level'},
  //   //     liquidityLockedBuyCount: {$first: '$liquidityLockedBuyCount'},
  //   //     liquidityLockedSellCount: {$first: '$liquidityLockedSellCount'},
  //   //     firstBlockBuyCount: {$first: '$firstBlockBuyCount'},
  //   //     firstBlockSellCount: {$first: '$firstBlockSellCount'},
  //   //     firstSwapBlockNumber: {$first: '$firstSwapBlockNumber'},
  //   //     createdAt: {$first: '$createdAt'},
  //   //     updatedAt: {$first: '$updatedAt'},
  //   //   }
  //   // }, 
  //   , {
  //     $match: {
  //       // snipers: {$gte: Number(snipers)},
  //       nonce0s: {$gte: Number(nonce0s)}
  //     }
  //   }
  // ])

  for(let i = 0 ; i < tokens.length; i ++) {
    tokens[i] = {...tokens[i].tokens[0], snipeData: await getSniperTxNonce0(tokens[i].tokens[0].address)}
  }

  tokens = tokens.filter(t => t.snipeData.snipers >= Number(snipers))
  res.json(tokens)


}

export const setGasFeeOnSnipingTxns = async(req, res) => {

  const snipers = await sniperTxsStructure.find({}) // get all sniping transactions

  for(let i = 0; i < snipers.length; i ++) {
    const txReceipt = await wssProvider.getTransactionReceipt(snipers[i].txHash) // get transaction information based on txHash. it's a bit different from tx
    const gasPrice = ethers.utils.formatUnits(txReceipt.effectiveGasPrice !== undefined ? txReceipt.effectiveGasPrice : ethers.constants.Zero, "gwei")
    const gasUsed = txReceipt.gasUsed
    
    snipers[i].gasUsed = gasUsed.toString()
    snipers[i].gasFee = gasUsed * gasPrice

    await snipers[i].save() //update sniping trasactions
  }

  res.json("success")
}

export const setContractLevel = async (req, res) => {
  try {
    const { address, level } = req.body;
    const tokenInfo = await tokenStructure.findOne({ address });
    tokenInfo.level = level;
    await tokenInfo.save();
    res.status(200).json({
      success: true,
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      error: e.message,
    });
  }
};

export const deleteSwappedTokens = async (req, res) => {
  try {
    const deleteResult = await tokenStructure.deleteMany({
      buyCount: { $exists: true },
    });
    res.status(200).json({
      success: true,
      deletectCount: deleteResult.deletedCount,
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      error: e.message,
    });
  }
};

export const deleteLockedTokens = async (req, res) => {
  try {
    const deleteResult = await tokenStructure.deleteMany({
      liquidityLockedHash: { $exists: true },
    });
    res.status(200).json({
      success: true,
      deletectCount: deleteResult.deletedCount,
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      error: e.message,
    });
  }
};

export const deleteOldTokens = async (req, res) => {
  try {
    const currentBlockNumber = await wssProvider.getBlockNumber();
    const deleteResult = await tokenStructure.deleteMany({
      blockNumber: { $lt: currentBlockNumber - 21600 },
    });
    res.status(200).json({
      success: true,
      deletectCount: deleteResult.deletedCount,
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      error: e.message,
    });
  }
};

export const deleteLevel1Tokens = async (req, res) => {
  try {
    const deleteResult = await tokenStructure.deleteMany({
      level: 1,
    });
    res.status(200).json({
      success: true,
      deletectCount: deleteResult.deletedCount,
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      error: e.message,
    });
  }
};