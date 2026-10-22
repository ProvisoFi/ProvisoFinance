// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ThesisSeal} from "../src/ThesisSeal.sol";
import {StampRoots} from "../src/StampRoots.sol";
import {CallerShare} from "../src/CallerShare.sol";
import {ProvisoSwapAdapter} from "../src/ProvisoSwapAdapter.sol";
import {SwapKeyPolicy} from "../src/SwapKeyPolicy.sol";

/// Env: REVEALER, STAMP_POSTER, SHARE_POSTER, USDG, POOL_MANAGER (all addresses), PIN_TOKENS and
/// PIN_ORACLES (comma-separated, same length: the adapter's stock token -> feed pins, quoted in
/// USDG), and optional MAX_ORACLE_AGE (seconds; default 60 for testnet's pushed feeds, mainnet
/// uses 90000). The mainnet path is packages/chain/scripts/deploy-mainnet.ts (pins from MAINNET_SWAP).
/// forge script script/Deploy.s.sol --rpc-url $RPC_URL --account <keystore> --broadcast
contract Deploy is Script {
    function run() external {
        address revealer = vm.envAddress("REVEALER");
        address stampPoster = vm.envAddress("STAMP_POSTER");
        address sharePoster = vm.envAddress("SHARE_POSTER");
        address usdg = vm.envAddress("USDG");
        address poolManager = vm.envAddress("POOL_MANAGER");
        uint256 maxOracleAge = vm.envOr("MAX_ORACLE_AGE", uint256(60));
        address[] memory pinTokens = vm.envAddress("PIN_TOKENS", ",");
        address[] memory pinOracles = vm.envAddress("PIN_ORACLES", ",");

        vm.startBroadcast();
        ThesisSeal seal = new ThesisSeal(revealer);
        StampRoots roots = new StampRoots(stampPoster);
        CallerShare share = new CallerShare(IERC20(usdg), sharePoster);
        ProvisoSwapAdapter adapter = new ProvisoSwapAdapter(IPoolManager(poolManager), maxOracleAge, usdg, pinTokens, pinOracles);
        SwapKeyPolicy policy = new SwapKeyPolicy(address(adapter));
        vm.stopBroadcast();

        console.log("ThesisSeal", address(seal));
        console.log("StampRoots", address(roots));
        console.log("CallerShare", address(share));
        console.log("ProvisoSwapAdapter", address(adapter));
        console.log("SwapKeyPolicy", address(policy));
    }
}
