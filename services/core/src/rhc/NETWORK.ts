import type { Address } from "viem";

// What exists on Robinhood Chain TESTNET (chain 46630) for B9, checked 2026-10-20 with eth_getCode
// against https://rpc.testnet.chain.robinhood.com and the Blockscout API at
// https://explorer.testnet.chain.robinhood.com/api/v2/addresses/<addr>. `undefined` = not found.
// Every "CREATE2" entry was created by the deterministic deployer 0x4e59b448…956C, so it is the same
// init code (and contract) as at that address on other chains.

export const RHC_TESTNET_CHAIN_ID = 46630;

export const UNISWAP_V4 = {
  // Uniswap's v4 deployments page lists these for Robinhood Chain MAINNET (4663) only
  // (developers.uniswap.org/docs/protocols/v4/deployments); testnet is not listed there. The same
  // addresses carry code on testnet, all CREATE2 from 0x4e59b448…; PoolManager is Blockscout-verified
  // "PoolManager" with live Swap events.
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address,
  // Uniswap docs (4663) StateView; testnet: code present, CREATE2, not verified on Blockscout.
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as Address,
  // Uniswap docs (4663) PositionManager; testnet: Blockscout-verified "PositionManager", CREATE2.
  positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7" as Address,
  // Uniswap docs (4663) V4Quoter; testnet: code present, CREATE2.
  quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as Address,
  // Never callable by the swap key. Uniswap docs (4663) Universal Router; testnet: code present, CREATE2.
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904" as Address,
  // Uniswap docs list "Universal Router 2.1.2" 0x204FAca1…0498 for 4663; no code on testnet.
  universalRouter212: undefined,
  // Never callable by the swap key. docs.robinhood.com/chain/protocol-contracts lists Permit2 on
  // testnet; Blockscout-verified "Permit2".
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
} as const;

export const CHAINLINK = {
  // No Chainlink feeds found on testnet: Chainlink's feed directory has feeds-robinhood-mainnet.json
  // (58 feeds, e.g. TSLA/USD 0x4A1166a6…7C38, 8 decimals, 86400 s heartbeat) but no testnet file;
  // those mainnet proxies have no code on 46630; Blockscout search finds no aggregator proxies.
  // docs.robinhood.com/chain/oracles-and-price-feeds: Stock Token feeds are multiplier-EMBEDDED
  // (answer = share price × multiplier; uiMultiplier() 1e18-scaled on the token, also
  // newUIMultiplier()/effectiveAt()/oraclePaused()); they update 24/5. So adapter policies use
  // multiplier = 1e18 for them, and a 60 s staleness window will reject feeds that only move on a
  // 24 h heartbeat (mainnet feeds list heartbeat 86400).
  feeds: undefined,
  stockFeedsMultiplierEmbedded: true,
} as const;

export const ACCOUNT_ABSTRACTION = {
  // docs.robinhood.com/chain/account-abstraction lists these EntryPoints (mainnet page); all are
  // Blockscout-verified "EntryPoint" on testnet too, CREATE2.
  entryPointV07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address,
  entryPointV08: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108" as Address,
  // ZeroDev Kernel v3.3 (EIP-7702 implementation address from ZeroDev's SDK constants);
  // testnet: Blockscout-verified "Kernel", CREATE2.
  kernelV33Implementation: "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28" as Address,
  // ZeroDev Kernel v3.1 implementation / factory (SDK constants); testnet: code present, CREATE2.
  kernelV31Implementation: "0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D" as Address,
  kernelV31Factory: "0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419" as Address,
  // ZeroDev ECDSA validator; testnet: Blockscout-verified "ECDSAValidator".
  ecdsaValidator: "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57" as Address,
  // ZeroDev permission modules (@zerodev/permissions 5.6.4 _esm/constants.js); code present on testnet.
  zerodevEcdsaSigner: "0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF" as Address,
  zerodevCallPolicyV005: "0x85770b902D1e503D5f5141d9eaC16d0d08eEaDd2" as Address,
  zerodevTimestampPolicy: "0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F" as Address,
  zerodevSudoPolicy: "0x67b436caD8a6D025DF6C82C5BB43fbF11fC5B9B7" as Address,
  // Same constants file; NO code on testnet. (Neither caps token amounts per day anyway, which is
  // why the swap-key policy is the SwapKeyPolicy executor module.)
  zerodevRateLimitPolicy: undefined,
  zerodevGasPolicy: undefined,
  // Bundlers answering for 46630 (read-only probes: eth_chainId 0xb626, eth_supportedEntryPoints,
  // gas price; a bogus chain id is rejected): Pimlico public endpoint and ZeroDev's RPC (project
  // id required for real use). Paymaster sponsorship not verified (needs API keys).
  pimlicoPublicBundler: "https://public.pimlico.io/v2/46630/rpc",
  zerodevBundler: "https://rpc.zerodev.app/api/v3/<PROJECT_ID>/chain/46630",
  // Alchemy: docs only show mainnet (robinhood-mainnet.g.alchemy.com); testnet not verified.
  alchemyBundler: undefined,
  // EIP-7702: eth_estimateGas with a type-4 authorizationList (throwaway key → Kernel v3.3) returned
  // 46382 vs 21000 without it (+25000 authorization cost), so the node processes authorizations.
  eip7702: true,
} as const;

export const TOKENS = {
  // Robinhood docs list only mainnet USDG; this is the testnet USDG recorded in @proviso/chain.
  usdg: "0x7E955252E15c84f5768B83c41a71F9eba181802F" as Address,
  // docs.robinhood.com/chain/protocol-contracts, testnet L2 Weth.
  weth: "0x7943e237c7F95DA44E0301572D358911207852Fa" as Address,
  // Candidate testnet Stock Tokens (Blockscout-verified BeaconProxy → "Stock", 18 decimals,
  // uiMultiplier() = 1e18, oraclePaused() reverts). Not confirmed as official by Robinhood docs,
  // whose token list doesn't cover testnet.
  tslaCandidate: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E" as Address,
  amznCandidate: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02" as Address,
} as const;

// Proviso's own B9 contracts (ProvisoSwapAdapter, SwapKeyPolicy) are deployed on testnet: see
// TESTNET_DEPLOYMENT in @proviso/chain. A live swap through them: scripts/smoke-swaps-testnet.ts.
