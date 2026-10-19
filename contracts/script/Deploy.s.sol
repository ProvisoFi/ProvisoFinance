// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ThesisSeal} from "../src/ThesisSeal.sol";
import {StampRoots} from "../src/StampRoots.sol";
import {CallerShare} from "../src/CallerShare.sol";
import {ProvisoSwapAdapter} from "../src/ProvisoSwapAdapter.sol";

/// Env: STAMP_POSTER, SHARE_POSTER, USDG, POOL_MANAGER (all addresses).
/// forge script script/Deploy.s.sol --rpc-url $RPC_URL --account <keystore> --broadcast
contract Deploy is Script {
    function run() external {
        address stampPoster = vm.envAddress("STAMP_POSTER");
        address sharePoster = vm.envAddress("SHARE_POSTER");
        address usdg = vm.envAddress("USDG");
        address poolManager = vm.envAddress("POOL_MANAGER");

        vm.startBroadcast();
        ThesisSeal seal = new ThesisSeal();
        StampRoots roots = new StampRoots(stampPoster);
        CallerShare share = new CallerShare(IERC20(usdg), sharePoster);
        ProvisoSwapAdapter adapter = new ProvisoSwapAdapter(IPoolManager(poolManager));
        vm.stopBroadcast();

        console.log("ThesisSeal", address(seal));
        console.log("StampRoots", address(roots));
        console.log("CallerShare", address(share));
        console.log("ProvisoSwapAdapter", address(adapter));
    }
}
