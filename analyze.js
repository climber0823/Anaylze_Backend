import { ethers } from "ethers";
import {
  wssProvider,
  IERC20,
  uniswapV2Pair,
  CONTRACTS,
  TOKENS,
} from "./src/constants.js";
import IERC20ABI from "./src/abi/IERC20.js";
import IUniswapV2Pair from "./src/abi/IUniswapV2Pair.js";
import IUniswapV2Factory from "./src/abi/IUniswapV2Factory.js";
import ITeamFinanceLock from "./src/abi/ITeamFinance.js";
import IUnicrypt from "./src/abi/IUnicrypt.js";
import IPinkLock from "./src/abi/IPinkLock.js";
import { createRequire } from "module";
import {
  requestSimulationForNewContract,
  getVerifiedContract,
} from "./src/simulationAndVerify.js";

const require = createRequire(import.meta.url);
const abiDecoder = require("abi-decoder");
import { match, getBigNumberFromString } from "./src/utils.js";
import tokenStructure from "./models/tokens.js";
import sniperTxsStructure from "./models/sniperTxs.js";
import syncBlock from "./models/syncBlock.js";
import { io } from "./global/socketIO.js";
import { getUniv2PairAddress } from "./src/univ2.js";
import axios from "axios";
import { logSuccess } from "./src/logging.js";

abiDecoder.addABI(IERC20ABI);
abiDecoder.addABI(IUniswapV2Pair);
abiDecoder.addABI(IUniswapV2Factory);
abiDecoder.addABI(ITeamFinanceLock);
abiDecoder.addABI(IUnicrypt);
abiDecoder.addABI(IPinkLock);

// Handle detect ERC20 token creation
const detectForContractCreation = async (parameters) => {
  const { txReceipt } = parameters;
  const contractAddress = txReceipt.contractAddress;

  // Get name, symbol, totalSupply, decimals of the contract. If these things are exist, this contract is token contract.
  let name, symbol, totalSupply, decimals;

  try {
    name = await IERC20.attach(contractAddress).name();
    symbol = await IERC20.attach(contractAddress).symbol();
    totalSupply = await IERC20.attach(contractAddress).totalSupply();
    decimals = await IERC20.attach(contractAddress).decimals();

    // Check if the contract is NFT: NFT's decimal is ZERO
    if (decimals == 0) return;

    let owner;
    try {
      owner = await IERC20.owner();
    } catch (e) {
      try {
        owner = await IERC20.getOwner();
      } catch (e) {
        owner = txReceipt.from;
      }
    }

    console.log("We detect new ERC20 token creation", {
      address: contractAddress.toLowerCase(),
      name,
      symbol,
      decimals,
      owner,
      totalSupply,
      tokenCreationHash: txReceipt.transactionHash,
      blockNumber: txReceipt.blockNumber,
      hash: txReceipt.transactionHash,
    });

    // io.emit("newContractIsCreated", {
    //   address: contractAddress.toLowerCase(),
    //   name,
    //   symbol,
    //   decimals,
    //   owner,
    //   totalSupply,
    //   tokenCreationHash: txReceipt.transactionHash,
    //   blockNumber: txReceipt.blockNumber
    // });

    const newTokenStructure = await tokenStructure.create({
      address: contractAddress.toLowerCase(),
      name,
      symbol,
      decimals,
      owner,
      totalSupply,
      tokenCreationHash: txReceipt.transactionHash,
      blockNumber: txReceipt.blockNumber,
    });

    io.emit("newContractCreated", newTokenStructure);
  } catch (e) {
    // This contract is not ERC20 token contract.
    return;
  }
};

//Analyze the log for the token mint.
const detectForTokenMint = async (parameters) => {
  const { decodedLogs, txHash } = parameters;

  for (const decodedLog of decodedLogs) {
    if (decodedLog.name == "Transfer") {
      const contract = decodedLog.address.toLowerCase();
      const from = decodedLog.events[0].value;
      // const to = decodedLog.events[1].value;
      const value = decodedLog.events[2].value;
      if (match(from, CONTRACTS.DEAD)) {
        const tokenStructureInfoForCheck = await tokenStructure.findOne({
          address: contract,
        });
        if (tokenStructureInfoForCheck == null) continue;
        const alreadyMintedAmount =
          tokenStructureInfoForCheck.mintedAmount == undefined
            ? getBigNumberFromString("0")
            : getBigNumberFromString(tokenStructureInfoForCheck.mintedAmount);
        // const responseForTokenMint = await tokenStructure.findOneAndUpdate(
        await tokenStructure.findOneAndUpdate(
          {
            address: contract,
          },
          {
            mintedAmount: alreadyMintedAmount.add(
              getBigNumberFromString(value)
            ),
          },
          {}
        );
        console.log("We detect new token mint.", {
          token: contract,
          amount: value,
        });
      }
    }
  }
};

// Analyze the log of the transaction. Mainly find swap methods.
const detectPairCreate = async (parameters) => {
  const { decodedLogs, txHash } = parameters;

  for (const decodedLog of decodedLogs) {
    if (
      decodedLog.name == "PairCreated" &&
      match(decodedLog.address, CONTRACTS.UNIV2_FACTORY)
    ) {
      const token0 = decodedLog.events[0].value;
      const token1 = decodedLog.events[1].value;
      const pair = decodedLog.events[2].value;

      // We detect only WETH pair now
      if (!match(token0, TOKENS.WETH) && !match(token1, TOKENS.WETH)) continue;

      const tokenAddress = match(token0, TOKENS.WETH)
        ? token1.toLowerCase()
        : token0.toLowerCase();

      console.log("We detect WETH pair create.", {
        address: tokenAddress,
        pair: pair.toLowerCase(),
        pairToken: TOKENS.WETH,
        hash: txHash,
      });

      await tokenStructure.findOneAndUpdate(
        {
          address: tokenAddress,
        },
        {
          pair: pair.toLowerCase(),
          pairToken: TOKENS.WETH,
        },
        {}
      );
    }
  }
};

// Analyze the log of the transaction. Mainly find AddLiquidity.
const detectAddLiquidity = async (parameters) => {
  const { decodedLogs, txHash } = parameters;

  for (const decodedLog of decodedLogs) {
    if (decodedLog.name == "Mint") {
      // const sender = decodedLog.events[0].value;
      const amount0 = decodedLog.events[1].value;
      const amount1 = decodedLog.events[2].value;

      const tokenStructureInfoForCheck = await tokenStructure.findOne({
        pair: decodedLog.address.toLowerCase(),
      });
      if (tokenStructureInfoForCheck == null) continue;
      if (tokenStructureInfoForCheck.liquidityToken != undefined) continue;
      const contractAddress = tokenStructureInfoForCheck.address;
      const pairToken = tokenStructureInfoForCheck.pairToken;
      let ethAmount, tokenAmount;
      if (
        ethers.BigNumber.from(contractAddress).lt(
          ethers.BigNumber.from(pairToken)
        )
      ) {
        tokenAmount = amount0;
        ethAmount = amount1;
      } else {
        tokenAmount = amount1;
        ethAmount = amount0;
      }

      console.log("We detect addLiquidity", {
        pair: decodedLog.address.toLowerCase(),
        liquidityETH: ethAmount,
        liquidityToken: tokenAmount,
        hash: txHash,
      });
      await tokenStructure.findOneAndUpdate(
        {
          pair: decodedLog.address.toLowerCase(),
        },
        {
          liquidityETH: ethAmount,
          liquidityToken: tokenAmount,
        },
        {}
      );
    }
  }

  // Start detect for UniswapV2 pool token creation

  for (const decodedLog of decodedLogs) {
    if (decodedLog.name == "Transfer") {
      const from = decodedLog.events[0].value;
      const to = decodedLog.events[1].value;
      const value = decodedLog.events[2].value;
      if (match(from, CONTRACTS.DEAD) && !match(to, CONTRACTS.DEAD)) {
        const tokenStructureInfoForCheck = await tokenStructure.findOne({
          pair: decodedLog.address.toLowerCase(),
        });
        if (tokenStructureInfoForCheck == null) continue;
        let totalLiquidityAmount = ethers.BigNumber.from(
          tokenStructureInfoForCheck.totalLPAmount == undefined
            ? 0
            : tokenStructureInfoForCheck.totalLPAmount
        );
        let liquidityAmount = ethers.BigNumber.from(
          tokenStructureInfoForCheck.currentLPAmount == undefined
            ? 0
            : tokenStructureInfoForCheck.currentLPAmount
        );
        totalLiquidityAmount = totalLiquidityAmount.add(
          ethers.BigNumber.from(value)
        );
        liquidityAmount = liquidityAmount.add(ethers.BigNumber.from(value));

        // const responseForLPMint = await tokenStructure.findOneAndUpdate(
        await tokenStructure.findOneAndUpdate(
          {
            pair: decodedLog.address.toLowerCase(),
          },
          {
            totalLPAmount: totalLiquidityAmount,
            currentLPAmount: liquidityAmount,
          },
          {}
        );
        console.log("We detect new LP token mint", {
          pair: decodedLog.address.toLowerCase(),
          value,
          hash: txHash,
        });
      }
    }
  }
};

// Analyze the log of the transaction. Mainly find AddLiquidity.
const detectRemoveLiquidity = async (parameters) => {
  const { decodedLogs, txHash } = parameters;

  for (const decodedLog of decodedLogs) {
    if (decodedLog.name == "Burn") {
      // const sender = decodedLog.events[0].value;
      const amount0 = decodedLog.events[1].value;
      const amount1 = decodedLog.events[2].value;
      // const to = decodedLog.events[3].value;

      const tokenStructureInfoForCheck = await tokenStructure.findOne({
        pair: decodedLog.address.toLowerCase(),
      });
      if (tokenStructureInfoForCheck == null) continue;
      const contractAddress = tokenStructureInfoForCheck.address;
      const pairToken = tokenStructureInfoForCheck.pairToken;
      let ethAmount, tokenAmount;
      if (
        ethers.BigNumber.from(contractAddress).lt(
          ethers.BigNumber.from(pairToken)
        )
      ) {
        tokenAmount = amount0;
        ethAmount = amount1;
      } else {
        tokenAmount = amount1;
        ethAmount = amount0;
      }

      console.log("We detect remove liquidity", {
        pair: decodedLog.address.toLowerCase(),
        removedLiquidityETH: ethAmount,
        removedLiquidityToken: tokenAmount,
        hash: txHash,
      });
      await tokenStructure.findOneAndUpdate(
        {
          pair: decodedLog.address.toLowerCase(),
        },
        {
          removedLiquidityETH: ethAmount,
          removedLiquidityToken: tokenAmount,
        },
        {}
      );
    }
  }
};

// Start detect for UniswapV2 pool burn
const detectForRemoveLPToken = async (parameters) => {
  const { decodedLogs, txHash } = parameters;

  for (const decodedLog of decodedLogs) {
    if (decodedLog.name == "Transfer") {
      const from = decodedLog.events[0].value;
      const to = decodedLog.events[1].value;
      const value = decodedLog.events[2].value;
      if (match(to, CONTRACTS.DEAD) && !match(from, CONTRACTS.DEAD)) {
        const tokenStructureInfoForCheck = await tokenStructure.findOne({
          pair: decodedLog.address.toLowerCase(),
        });
        if (tokenStructureInfoForCheck == null) continue;
        let liquidityAmount = ethers.BigNumber.from(
          tokenStructureInfoForCheck.currentLPAmount
        );
        liquidityAmount = liquidityAmount.sub(ethers.BigNumber.from(value));

        console.log("We detect new lp token burn", {
          pair: decodedLog.address.toLowerCase(),
          value,
          hash: txHash,
        });
        await tokenStructure.findOneAndUpdate(
          {
            pair: decodedLog.address.toLowerCase(),
          },
          {
            currentLPAmount: liquidityAmount,
          },
          {}
        );
      }
    }
  }
};

// Analyze the log of the transaction. Mainly find swap methods.
const detectSwapLogs = async (parameters) => {
  const { decodedLogs, tx, blockNumber } = parameters;

  for (const decodedLog of decodedLogs) {
    if (decodedLog.name == "Swap") {
      const pair = decodedLog.address.toLowerCase();

      // const sender = decodedLog.events[0].value;
      const amount0In = decodedLog.events[1].value;
      const amount1In = decodedLog.events[2].value;
      const amount0Out = decodedLog.events[3].value;
      const amount1Out = decodedLog.events[4].value;
      // const to = decodedLog.events[5].value;

      let token0, token1;
      try {
        // If the pair is uniswap v2 pair
        token0 = await uniswapV2Pair.attach(pair).token0();
        token1 = await uniswapV2Pair.attach(pair).token1();
        if (
          pair !==
          getUniv2PairAddress({ tokenA: token0, tokenB: token1 }).toLowerCase()
        )
          continue;
      } catch (e) {
        continue;
      }

      let swapDirection; // 0: WETH -> TOKEN(BUY), 1: TOKEN -> WETH(SELL)
      if (amount1Out == "0") {
        swapDirection = match(token0, TOKENS.WETH) ? 1 : 0;
      } else {
        swapDirection = match(token0, TOKENS.WETH) ? 0 : 1;
      }

      // const token = match(token0, TOKENS.WETH) ? token1 : token0; // current token;

      let tradeTokenAmount; // Trade amount of token
      if (swapDirection == 0) {
        tradeTokenAmount = amount0Out != "0" ? amount0Out : amount1Out;
      } else {
        tradeTokenAmount = amount0In != "0" ? amount0In : amount1In;
      }

      const tokenStructureInfoForCheck = await tokenStructure.findOne({ pair });
      if (tokenStructureInfoForCheck == null) continue;

      // console.log("We detect new swap", {
      //   pair,
      //   swapDirection,
      //   tradeTokenAmount,
      //   hash: txHash,
      // });

      
      const sniperTx = tx;

      if (tokenStructureInfoForCheck.buyCount == undefined) {
        tokenStructureInfoForCheck.buyCount = swapDirection == 0 ? 1 : 0;
        tokenStructureInfoForCheck.sellCount = swapDirection == 1 ? 1 : 0;
        tokenStructureInfoForCheck.firstBlockBuyCount =
          swapDirection == 0 ? 1 : 0;
        tokenStructureInfoForCheck.firstBlockSellCount =
          swapDirection == 1 ? 1 : 0;
        tokenStructureInfoForCheck.maxTradeTokenAmount = tradeTokenAmount;
        tokenStructureInfoForCheck.firstSwapBlockNumber = blockNumber;
        await tokenStructureInfoForCheck.save();

        if(swapDirection == 0) {  //sniping buy
          if(sniperTx !== null && sniperTx.to !== null) {
            let toAddress = "";
            if(sniperTx.to.toLocaleLowerCase() === "0x3328F7f4A1D1C57c35df56bBf0c9dCAFCA309C49".toLocaleLowerCase()){
              toAddress = "BananaGun";
            }
            if(sniperTx.to.toLocaleLowerCase() === "0x7a250d5630b4cf539739df2c5dacb4c659f2488d".toLocaleLowerCase())
              toAddress = "UniswapV2Router";
            if(sniperTx.to.toLocaleLowerCase() === "0x80a64c6D7f12C47B7c66c5B4E20E72bc1FCd5d9e".toLocaleLowerCase()) {
              toAddress = "Maestro";
            }
            
            const gasPrice = ethers.utils.formatUnits(sniperTx.effectiveGasPrice !== undefined ? sniperTx.effectiveGasPrice : ethers.constants.Zero, "gwei")
            const gasUsed = sniperTx.gasUsed

            await sniperTxsStructure.create({
              address: (match(token0, TOKENS.WETH) ? token1 : token0).toLowerCase(),
              txHash : sniperTx.hash,
              from : sniperTx.from,
              to : toAddress === "" ? sniperTx.to : toAddress,
              nonce : sniperTx.nonce,
              priorityFee : ethers.utils.formatUnits(sniperTx.maxPriorityFeePerGas !== undefined ? sniperTx.maxPriorityFeePerGas : ethers.constants.Zero, "gwei"),
              gasLimit : sniperTx.gasLimit.toString(),
              gasFee: gasPrice * gasUsed,
              gasUsed: gasUsed.toString(),
              value : ethers.utils.formatEther(sniperTx.value)
            })
          }
        }

        io.emit("swapEnabled", tokenStructureInfoForCheck);

        // let code, abi;
        // const fetchURL = `https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${tokenStructureInfoForCheck.address}&apikey=E4DKRHQZPF2RVBXC6G2IBP56PJFFBITYVA`;
        // await fetch(fetchURL)
        //   .then((res) => res.json())
        //   .then((json) => {
        //     code = json.result[0].SourceCode;
        //     abi = json.result[0].ABI;
        //   })
        //   .catch(() => {
        //     console.log(
        //       "Error when getting smart contract code from etherscan."
        //     );
        //   });
        // tokenStructureInfoForCheck.contractSourceCode = code;
        // tokenStructureInfoForCheck.contractABI = abi;
        // await tokenStructureInfoForCheck.save();
      } else {
        tokenStructureInfoForCheck.buyCount =
          swapDirection == 0
            ? tokenStructureInfoForCheck.buyCount + 1
            : tokenStructureInfoForCheck.buyCount;
        tokenStructureInfoForCheck.sellCount =
          swapDirection == 1
            ? tokenStructureInfoForCheck.sellCount + 1
            : tokenStructureInfoForCheck.sellCount;
        if (blockNumber === tokenStructureInfoForCheck.firstSwapBlockNumber) {
          tokenStructureInfoForCheck.firstBlockBuyCount = tokenStructureInfoForCheck.buyCount;
          tokenStructureInfoForCheck.firstBlockSellCount = tokenStructureInfoForCheck.sellCount;

          if(swapDirection == 0) {  //sniping buy
            if(sniperTx !== null && sniperTx.to !== null) {
  
              let toAddress = "";
              if(sniperTx.to.toLocaleLowerCase() === "0x3328F7f4A1D1C57c35df56bBf0c9dCAFCA309C49".toLocaleLowerCase()){
                toAddress = "BananaGun";
              }
              if(sniperTx.to.toLocaleLowerCase() === "0x7a250d5630b4cf539739df2c5dacb4c659f2488d".toLocaleLowerCase())
                toAddress = "UniswapV2Router";
              if(sniperTx.to.toLocaleLowerCase() === "0x80a64c6D7f12C47B7c66c5B4E20E72bc1FCd5d9e".toLocaleLowerCase()) {
                toAddress = "Maestro";
              }

              const gasPrice = ethers.utils.formatUnits(sniperTx.effectiveGasPrice !== undefined ? sniperTx.effectiveGasPrice : ethers.constants.Zero, "gwei")
              const gasUsed = sniperTx.gasUsed

              await sniperTxsStructure.create({
                address: (match(token0, TOKENS.WETH) ? token1 : token0).toLowerCase(),
                txHash : sniperTx.hash,
                from : sniperTx.from,
                to : toAddress === "" ? sniperTx.to : toAddress,
                nonce : sniperTx.nonce,
                priorityFee : ethers.utils.formatUnits(sniperTx.maxPriorityFeePerGas !== undefined ? sniperTx.maxPriorityFeePerGas : ethers.constants.Zero, "gwei"),
                gasLimit : sniperTx.gasLimit.toString(),
                gasFee: gasPrice * gasUsed,
                gasUsed: gasUsed.toString(),
                value : ethers.utils.formatEther(sniperTx.value)
              })
            }
          }
        }
          
        tokenStructureInfoForCheck.maxTradeTokenAmount = getBigNumberFromString(
          tokenStructureInfoForCheck.maxTradeTokenAmount
        ).lt(getBigNumberFromString(tradeTokenAmount))
          ? tradeTokenAmount
          : tokenStructureInfoForCheck.maxTradeTokenAmount;
        await tokenStructureInfoForCheck.save();
        io.emit("swapped", tokenStructureInfoForCheck);
      }
      return;
    }
  }
};

const detectTeamFinanceLock = async (parameters) => {
  const { txReceipt } = parameters;

  const decodedLogsForTeamFinance = abiDecoder.decodeLogs(txReceipt.logs);
  for (const decodedLog of decodedLogsForTeamFinance) {
    if (decodedLog.name == "Deposit") {
      // const id = decodedLog.events[0].value;
      const tokenAddress = decodedLog.events[1].value;
      // const withdrawalAddress = decodedLog.events[2].value;
      const amount = ethers.BigNumber.from(decodedLog.events[3].value);
      const unlockTime = decodedLog.events[4].value;
      return { token: tokenAddress, amount, unlockTime };
    }
  }
  return null;
};

const detectUnicryptLock = async (parameters) => {
  const { txReceipt } = parameters;

  const decodedLogsForUnicrypt = abiDecoder.decodeLogs(txReceipt.logs);

  for (const decodedLog of decodedLogsForUnicrypt) {
    if (decodedLog.name == "onDeposit") {
      const lpToken = decodedLog.events[0].value;
      // const user = decodedLog.events[1].value;
      const amount = ethers.BigNumber.from(decodedLog.events[2].value);
      // const lockDate = decodedLog.events[3].value;
      const unlockDate = decodedLog.events[4].value;
      return { token: lpToken, amount, unlockTime: unlockDate };
    }
  }
  return null;
};

const detectPinkLock = async (parameters) => {
  const { txReceipt } = parameters;

  for (const txLog of txReceipt.logs) {
    if (
      txLog.topics[0] ==
      "0x694af1cc8727cdd0afbdd53d9b87b69248bd490224e9dd090e788546506e076f"
    ) {
      // Lock added
      const token = "0x" + txLog.data.slice(26, 66);
      const amount = ethers.BigNumber.from("0x" + txLog.data.slice(130, 194));
      const unlockDate = ethers.BigNumber.from(
        "0x" + txLog.data.slice(194, 258)
      ).toNumber();
      return { token, amount, unlockTime: unlockDate };
    }
  }
  return null;
};

const detectLock = async (parameters) => {
  const { txReceipt } = parameters;

  let token, amount, unlockTime;
  // Start Detect for Team finance
  if (match(txReceipt.to, "0xe2fe530c047f2d85298b07d9333c05737f1435fb")) {
    const returnParameters = await detectTeamFinanceLock({ txReceipt });
    if (returnParameters == null) return;
    ({ token, amount, unlockTime } = returnParameters);
  }

  // Start Detect for Unicrypt
  else if (match(txReceipt.to, "0x663A5C229c09b049E36dCc11a9B0d4a8Eb9db214")) {
    const returnParameters = await detectUnicryptLock({ txReceipt });
    if (returnParameters == null) return;
    ({ token, amount, unlockTime } = returnParameters);
  }

  // Start Detect for Pink lock
  else if (match(txReceipt.to, "0x71B5759d73262FBb223956913ecF4ecC51057641")) {
    const returnParameters = await detectPinkLock({ txReceipt });
    if (returnParameters == null) return;
    ({ token, amount, unlockTime } = returnParameters);
  }

  // Start Detect for lp to transfer dead wallet
  else {
    let tokenStructureInfoForCheck = await tokenStructure.findOne({
      pair: txReceipt.to.toLowerCase(),
    });
    if (tokenStructureInfoForCheck != null) {
      let decodedLogs = [];
      try {
        decodedLogs = abiDecoder.decodeLogs(txReceipt.logs);
      } catch (e) {
        return;
      }
      for (const decodedLog of decodedLogs) {
        if (decodedLog.name == "Transfer") {
          // const from = decodedLog.events[0].value;
          const to = decodedLog.events[1].value;
          const value = decodedLog.events[2].value;
          if (match(to, CONTRACTS.DEAD) || match(to, CONTRACTS.DEAD2)) {
            tokenStructureInfoForCheck.liquidityLockedAmount =
              getBigNumberFromString(value);
            tokenStructureInfoForCheck.liquidityUnlockTime = 10000000000000;
            tokenStructureInfoForCheck.liquidityLockedHash =
              txReceipt.transactionHash;
            tokenStructureInfoForCheck.liquidityLockedBuyCount = tokenStructureInfoForCheck.buyCount;
            tokenStructureInfoForCheck.liquidityLockedSellCount = tokenStructureInfoForCheck.sellCount;
            await tokenStructureInfoForCheck.save();

            console.log("We detect lp transfer to dead wallet");
            io.emit("lpLocked", tokenStructureInfoForCheck);
            return;
          }
        }
      }
    } else return;
  }

  if (token === undefined) return;

  let tokenStructureInfoForCheck = await tokenStructure.findOne({
    pair: token,
  });
  if (tokenStructureInfoForCheck != null) {
    console.log("We detect lp lock", {
      token,
      amount,
      unlockTime,
      hash: txReceipt.transactionHash,
    });
    tokenStructureInfoForCheck.liquidityLockedAmount = amount;
    tokenStructureInfoForCheck.liquidityUnlockTime = unlockTime;
    tokenStructureInfoForCheck.liquidityLockedHash = txReceipt.transactionHash;
    tokenStructureInfoForCheck.liquidityLockedBuyCount = tokenStructureInfoForCheck.buyCount;
    tokenStructureInfoForCheck.liquidityLockedSellCount = tokenStructureInfoForCheck.sellCount;
    await tokenStructureInfoForCheck.save();
    io.emit("lpLocked", tokenStructureInfoForCheck);
  }
  tokenStructureInfoForCheck = await tokenStructure.findOne({
    address: token,
  });
  if (tokenStructureInfoForCheck != null) {
    console.log("We detect token lock", {
      token,
      amount,
      unlockTime,
      hash: txReceipt.transactionHash,
    });
    tokenStructureInfoForCheck.tokenLockedAmount = amount;
    tokenStructureInfoForCheck.tokenUnlockTime = unlockTime;
    tokenStructureInfoForCheck.tokenLockedHash = txReceipt.transactionHash;
    await tokenStructureInfoForCheck.save();
    io.emit("tokenLocked", tokenStructureInfoForCheck);
  }
};

const detectRemoveLimits = async (parameters) => {
  const { tx } = parameters;
  const txData = tx.data;
  const MethodID = txData.slice(0, 10);

  let updatedContractStructure;

  if (MethodID == "0x751039fc" || MethodID == "0x62256589") {
    //  removeLimits()
    // const caller = tx.from;
    const token = tx.to.toLowerCase();

    updatedContractStructure = await tokenStructure.findOne({
      address: token,
    });
    if (updatedContractStructure != null) {
      console.log("We detect removeLimits", {
        hash: tx.hash,
      });
      updatedContractStructure.removeLimitsHash = tx.hash;
      await updatedContractStructure.save();
    }
  } else if (MethodID == "0xea1644d5") {
    // setMaxWalletSize(uint256 maxWalletSize)
    // const caller = tx.from;
    const token = tx.to.toLowerCase();
    const amount = ethers.BigNumber.from("0x" + txData.slice(10));

    updatedContractStructure = await tokenStructure.findOne({
      address: token,
    });
    if (updatedContractStructure != null) {
      console.log("We detect setMaxWalletSize", {
        amount,
        hash: tx.hash,
      });
      updatedContractStructure.maxWalletSize = amount;
      updatedContractStructure.setMaxWalletSizeHash = tx.hash;
      await updatedContractStructure.save();
    }
  } else if (MethodID == "0x74010ece") {
    // setMaxTxnAmount(uint256 maxTxAmount)
    // const caller = tx.from;
    const token = tx.to.toLowerCase();
    const amount = ethers.BigNumber.from("0x" + txData.slice(10));

    updatedContractStructure = await tokenStructure.findOne({
      address: token,
    });
    if (updatedContractStructure != null) {
      console.log("We detect setMaxTxnAmount", {
        amount,
        hash: tx.hash,
      });
      updatedContractStructure.maxTxAmount = amount;
      updatedContractStructure.setMaxTxAmountHash = tx.hash;
      await updatedContractStructure.save();
    }
  } else if (MethodID == "0x81bfdcca") {
    // changeMaxWalletAmount(uint256 _maxWalletAmount)
    // const caller = tx.from;
    const token = tx.to.toLowerCase();
    const amount = ethers.BigNumber.from("0x" + txData.slice(10));

    updatedContractStructure = await tokenStructure.findOne({
      address: token,
    });
    if (updatedContractStructure != null) {
      console.log("We detect changeMaxWalletAmount", {
        amount,
        hash: tx.hash,
      });
      updatedContractStructure.maxWalletSize = amount;
      updatedContractStructure.setMaxWalletSizeHash = tx.hash;
    }
  } else if (MethodID == "0x677daa57") {
    // changeMaxTxAmount(uint256 _maxTxAmount)
    // const caller = tx.from;
    const token = tx.to.toLowerCase();
    const amount = ethers.BigNumber.from("0x" + txData.slice(10));

    updatedContractStructure = await tokenStructure.findOne({
      address: token,
    });
    if (updatedContractStructure != null) {
      console.log("We detect changeMaxTxAmount", {
        amount,
        hash: tx.hash,
      });
      updatedContractStructure.maxTxAmount = amount;
      updatedContractStructure.setMaxTxAmountHash = tx.hash;
      await updatedContractStructure.save();
    }
  } else if (MethodID == "0xec28438a") {
    // setMaxTxAmount(uint256 maxTxAmount)
    // const caller = tx.from;
    const token = tx.to.toLowerCase();
    const amount = ethers.BigNumber.from("0x" + txData.slice(10));

    updatedContractStructure = await tokenStructure.findOne({
      address: token,
    });
    if (updatedContractStructure != null) {
      console.log("We detect setMaxTxAmount", {
        amount,
        hash: tx.hash,
      });
      updatedContractStructure.maxWalletSize = amount;
      updatedContractStructure.setMaxWalletSizeHash = tx.hash;
      await updatedContractStructure.save();
    }
  } else if (MethodID == "0x4019cfa9") {
    // maxLimits()
    // const caller = tx.from;
    const token = tx.to.toLowerCase();

    updatedContractStructure = await tokenStructure.findOne({
      address: token,
    });
    if (updatedContractStructure != null) {
      console.log("We detect maxLimits", {
        hash: tx.hash,
      });
      updatedContractStructure.removeLimitsHash = tx.hash;
      await updatedContractStructure.save();
    }
  } else return;

  if (updatedContractStructure != null)
    io.emit("limitRemoved", updatedContractStructure);
};

const detectRenounceOwnerShip = async (parameters) => {
  const { tx } = parameters;
  const txData = tx.data;
  const MethodID = txData.slice(0, 10);

  let updatedContractStructure = null;

  if (MethodID == "0x715018a6") {
    // renounceOwnership()
    // const caller = tx.from;
    const token =
      tx.to.toLowerCase() == null
        ? tx.contractAddress.toLowerCase()
        : tx.to.toLowerCase();

    updatedContractStructure = await tokenStructure.findOne({
      address: token,
    });
    if (updatedContractStructure != null) {
      console.log("We detect renounceOwnership", {
        hash: tx.hash,
      });
      updatedContractStructure.renounceOwnerShipHash = tx.hash;
      await updatedContractStructure.save();
    }
  } else if (MethodID == "0xf2fde38b") {
    // transferOwnership(address adr)
    // const caller = tx.from;
    const token = tx.to.toLowerCase();
    const updatedOwner = "0x" + txData.slice(txData.length - 40, txData.length);

    updatedContractStructure = await tokenStructure.findOne({
      address: token,
    });
    if (updatedContractStructure != null) {
      console.log("We detect transferOwnership", {
        updatedOwner,
        hash: tx.hash,
      });
      updatedContractStructure.updatedOwner = updatedOwner;
      updatedContractStructure.transferOwnershipHash = tx.hash;
      await updatedContractStructure.save();
    }
  } else return;

  if (updatedContractStructure !== null)
    io.emit("renounced", updatedContractStructure);
};

const doWhatBlockRecvNeed = async (blockNumber, txPos, block) => {
  const txs = block.transactions;
  let position = -1
  let startPos = txPos

  for (const tx of txs) {
    if((++ position) < startPos) continue
    const txReceipt = await wssProvider.getTransactionReceipt(tx.hash);
    try {
      // Ignore failed transaction
      if (txReceipt.status == 0) continue;

      // Detect for contract creation
      if (txReceipt.to == null && txReceipt.contractAddress != null) {
        // Analyze new contract is created
        await detectForContractCreation({ txReceipt });
      } else {
        // Analyze the logs for lock
        await detectLock({ txReceipt });

        // Analyze the transaction for remove limits
        await detectRemoveLimits({ tx });
      }
      // Analyze the transaction for remove limits
      await detectRenounceOwnerShip({ tx });

      let decodedLogs = [];
      try {
        decodedLogs = abiDecoder.decodeLogs(txReceipt.logs);
      } catch (e) {
        continue;
      }
      // Analyze the token mint
      await detectForTokenMint({
        decodedLogs,
        txHash: txReceipt.transactionHash,
      });

      // Analyze the logs for Pair create
      await detectPairCreate({
        decodedLogs,
        txHash: txReceipt.transactionHash,
      });

      // Analyze the logs for add liquidity
      await detectAddLiquidity({
        decodedLogs,
        txHash: txReceipt.transactionHash,
      });

      // Analyze the logs for remove liquidity
      await detectRemoveLiquidity({
        decodedLogs,
        txHash: txReceipt.transactionHash,
      });

      // Detect for the lp token burn. Will remove by remove liquidity or send it to the ZERO wallet.
      await detectForRemoveLPToken({
        decodedLogs,
        txHash: txReceipt.transactionHash,
      });

      // Analyze the logs for swap
      await detectSwapLogs({
        decodedLogs,
        tx: txReceipt,
        blockNumber: txReceipt.blockNumber,
      });
    } catch (e) {
      console.log("Error:", {txReceipt}, e);
      continue
    }

    //save block and transaction number
    const savedBlock = await syncBlock.findOne({})
    if(!savedBlock) { //no saved data
      const newSyncBlock = new syncBlock({
        block: blockNumber,
        tx: position
      })
      await newSyncBlock.save()
    }
    else {
      console.log("position---", position)
      savedBlock.block = blockNumber
      savedBlock.tx = position
      await savedBlock.save()
    }
  }
};

export const analyze = async () => {
  // requestSimulationForNewContract(16419170 + 5);
  // getVerifiedContract(16419170 + 5);
  // await doWhatBlockRecvNeed(
  //   await wssProvider.getBlockWithTransactions(
  //     18110116)
  // );
  // await detectPinkLock({txReceipt: await wssProvider.getTransactionReceipt("0xcc163f60f267dd6fb2f8549ed4b0fffd3d3a417b386ce9c144a0f0fb3b4d796c")})
  // console.log("done");
  // await detectForRemoveLPToken({txReceipt: await wssProvider.getTransactionReceipt("0xcc163f60f267dd6fb2f8549ed4b0fffd3d3a417b386ce9c144a0f0fb3b4d796c")});
  // await detectAddLiquidity({txReceipt: await wssProvider.getTransactionReceipt("0x59ec7f6b8aacadee0fe79ef99deaf9454243cab41bd3d455f96b342ece44c76e")});
  // await detectLock({
  //   txReceipt: await wssProvider.getTransactionReceipt(
  //     "0x299524acf56025415eb1c678d411078aaa1682367f213d356148627349c927f9"
  //   ),
  // });

  // Start detect swap
  // const txReceipt = await wssProvider.getTransactionReceipt(
  //   "0x3b7af35d7cc16d396fc117c0c31aa97b568dfdbe8334a20c933bba06eff23aad"
  // );
  // let decodedLogs = abiDecoder.decodeLogs(txReceipt.logs);
  // detectSwapLogs({ decodedLogs, txHash: txReceipt.transactionHash });
  
  const lastBlockNumber = await wssProvider.getBlockNumber();
  
  let startBlock = lastBlockNumber - 7200*15
  let startTx = -1
  const savedBlock = await syncBlock.findOne({})
  if(savedBlock){
    startBlock = savedBlock.block
    startTx = savedBlock.tx
  }

  let isDoneSyncing = 0;
  for(let i = startBlock;; ++ i) {
    console.log(i);
    if(i > await wssProvider.getBlockNumber()) break;
    if(i === startBlock)
      await doWhatBlockRecvNeed(i, startTx, await wssProvider.getBlockWithTransactions(i));
    else
      await doWhatBlockRecvNeed(i, -1, await wssProvider.getBlockWithTransactions(i));
  }
  isDoneSyncing = 1;
  logSuccess("Done");

  let prevoiusBlock = 0;
  wssProvider.on("block", async (blk) => {
    if (prevoiusBlock >= blk) return;
    if(!isDoneSyncing) return;
    prevoiusBlock = blk;
    requestSimulationForNewContract(blk);
    // getVerifiedContract(blk);
    const blkReceiveTime = Date.now() / 1000;
    try {
      const block = await wssProvider.getBlockWithTransactions(blk);
      console.log(
        block.number,
        block.timestamp,
        blkReceiveTime,
        block.timestamp - blkReceiveTime
      );
      doWhatBlockRecvNeed(blk, -1, block);
    } catch (e) {
      console.log("Error", e);
    }
  });
};
